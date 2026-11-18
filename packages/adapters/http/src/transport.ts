import {
  AdapterTimeoutError,
  assertEgressAllowed,
  type EgressPolicy,
  type EvidenceKind,
} from '@nuzm/adapter-contracts';

/**
 * Minimal HTTP transport shared by the vendor adapters (M05 S18-S22). Adapters never call `fetch` directly: every outbound request goes
 * through a transport, and the production transport applies the per-adapter egress allow-list / SSRF guard (M05 §9) BEFORE connecting.
 * Tests inject a transport that talks to a loopback server (kind `fixture`) — the evidence kind is derived from the URL actually called,
 * so a fixture run can never be labelled `live`.
 */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HttpTransport {
  send(req: HttpRequest): Promise<HttpResponse>;
  /** `live` only for a non-loopback host reached through the real network; loopback servers and replays are `fixture`. */
  evidenceKind(url: string): EvidenceKind;
}

/** The request may or may not have reached the provider (connection reset, timeout, abort): callers treat a mutating call as `uncertain`. */
export class TransportAmbiguousError extends AdapterTimeoutError {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterTimeoutError'; // keeps the framework guard's timeout handling
  }
}

const isLoopbackHost = (url: string): boolean => {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || h.startsWith('127.');
  } catch {
    return false;
  }
};

export interface FetchTransportOptions {
  policy: EgressPolicy;
  fetchImpl?: typeof fetch;
}

/** The only transport that touches the network. Egress is checked per request; there is no way to bypass the allow-list. */
export function createFetchTransport(opts: FetchTransportOptions): HttpTransport {
  const f = opts.fetchImpl ?? fetch;
  return {
    evidenceKind: (url) => (isLoopbackHost(url) ? 'fixture' : 'live'),
    async send(req) {
      assertEgressAllowed(req.url, opts.policy);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), req.timeoutMs);
      try {
        const res = await f(req.url, {
          method: req.method,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
          signal: ac.signal,
          redirect: 'error', // a redirect could leave the allow-list
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        return { status: res.status, headers, body: await res.text() };
      } catch (e) {
        if ((e as Error).name === 'AbortError')
          throw new TransportAmbiguousError(`no answer within ${req.timeoutMs} ms`);
        throw new TransportAmbiguousError(
          `connection failed: ${(e as Error).message ?? 'network error'}`,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
