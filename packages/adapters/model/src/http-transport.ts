import { ModelAdapterError } from './types';
import { modelErrorFromHttpStatus } from './provider-drafts';
import { parseRetryAfterMs } from './resilience';

/**
 * Shared HTTP plumbing for the REST adapters (OpenAI, Gemini): a stubbable `fetch`, bounded response reads, an SSE reader and the error mapping. There is no vendor SDK behind
 * these adapters: a fixed host in code, a key read only at call time, and nothing from the vendor's error body is passed on except an allow-listed code.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The largest body (in bytes) read from a provider: a runaway or hostile response is refused, not buffered. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The longest single SSE line accepted. */
const MAX_LINE_BYTES = 1024 * 1024;

export const ADAPTER_TIMEOUT_MS = 120_000;

export interface Linked {
  signal: AbortSignal;
  /** the timer fired (not the caller) */
  timedOut(): boolean;
  dispose(): void;
}
/** One AbortSignal that fires when the caller's does or when `ms` elapse; `dispose` must be called when the request is done. */
export function linkSignal(caller: AbortSignal | undefined, ms = ADAPTER_TIMEOUT_MS): Linked {
  const ac = new AbortController();
  let timed = false;
  const onAbort = () => ac.abort();
  caller?.addEventListener('abort', onAbort, { once: true });
  if (caller?.aborted) ac.abort();
  const t = setTimeout(() => {
    timed = true;
    ac.abort();
  }, ms);
  return {
    signal: ac.signal,
    timedOut: () => timed,
    dispose: () => {
      clearTimeout(t);
      ac.abort(); // the request is over (or the consumer stopped reading): nothing may keep running
      caller?.removeEventListener('abort', onAbort);
    },
  };
}

/** What a transport failure (not an HTTP status) means: the caller's abort, our timer, or the network. */
export function mapTransportError(
  e: unknown,
  linked: Linked,
  caller?: AbortSignal,
): ModelAdapterError {
  if (e instanceof ModelAdapterError) return e;
  if (caller?.aborted) return new ModelAdapterError('aborted', 'the call was aborted');
  if (linked.timedOut())
    return new ModelAdapterError('timeout', 'the model did not answer in time');
  const name = e instanceof Error ? e.name : '';
  if (name === 'AbortError') return new ModelAdapterError('aborted', 'the call was aborted');
  return new ModelAdapterError('unavailable', 'could not reach the model provider (network)');
}

/** Reads a JSON body with a size ceiling; anything that is not a JSON object is an `invalid_response`. */
export async function readJsonBody(res: Response): Promise<Record<string, unknown>> {
  const text = await readTextBounded(res);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ModelAdapterError('invalid_response', 'the provider answer is not valid JSON', false);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new ModelAdapterError(
      'invalid_response',
      'the provider answer is not a JSON object',
      false,
    );
  return v as Record<string, unknown>;
}
export async function readTextBounded(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ModelAdapterError('invalid_response', 'the provider answer is too large', false);
    }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

/**
 * Server-sent events: yields the `data:` payload of each event (multi-line data joined with \n). Comments and other fields are ignored. Cancelling the consumer cancels the body.
 */
export async function* readSse(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES * 4)
        throw new ModelAdapterError('invalid_response', 'the provider stream is too large', false);
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r\n|\n|\r/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf.startsWith('\r\n', nl) ? 2 : 1));
        if (line.length > MAX_LINE_BYTES)
          throw new ModelAdapterError('invalid_response', 'a stream line is too long', false);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (buf.length > MAX_LINE_BYTES)
        throw new ModelAdapterError('invalid_response', 'a stream line is too long', false);
    }
    buf += dec.decode();
    if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''));
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * An HTTP error status → a contract error. The vendor's message is never carried. `spendCodes` is the vendor's documented list of `error.code` / `error.type` values that mean
 * "billing, quota or spend limit": those answer HTTP 429 but retrying cannot help, so they become a NON-retryable `rate_limited`.
 */
export async function errorFromResponse(
  res: Response,
  spendCodes: readonly string[] = [],
  spendMessage = 'the model provider spending limit or quota is reached (raise it in the vendor console)',
): Promise<ModelAdapterError> {
  const retryAfter = parseRetryAfterMs(res.headers);
  if (res.status === 429 && spendCodes.length) {
    const codes = await errorCodes(res);
    if (codes.some((c) => spendCodes.includes(c)))
      return new ModelAdapterError('rate_limited', spendMessage, false);
  } else await res.body?.cancel().catch(() => undefined);
  return modelErrorFromHttpStatus(res.status, retryAfter);
}
/** The `error.code` and `error.type` strings of a vendor error body, only when they look like identifiers; nothing else of the body survives. */
async function errorCodes(res: Response): Promise<string[]> {
  try {
    const body = JSON.parse((await readTextBounded(res)).slice(0, 65_536)) as {
      error?: { code?: unknown; type?: unknown };
    };
    return [body.error?.code, body.error?.type].filter(
      (x): x is string => typeof x === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(x),
    );
  } catch {
    return [];
  }
}

/** A well-formed vendor request id (`req_…`) or null: only that shape ends up in evidence files. */
export function safeRequestId(v: string | null | undefined): string | null {
  return typeof v === 'string' && /^req_[A-Za-z0-9_-]{4,100}$/.test(v) ? v : null;
}
