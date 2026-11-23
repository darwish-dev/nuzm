import {
  MODEL_CONTRACT_VERSION_1_1,
  ModelAdapterError,
  TOOL_LIMITS,
  TOOL_NAME,
  contractAtLeast,
  effectiveCapabilities,
  type CompleteRequest,
  type CompleteResponse,
  type ModelInfo,
  type StreamChunk,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from './types';

/**
 * Pure helpers of contract 1.1 (D-46, SCR-K-10 §2): validation of a tool request, assembly of a streamed response, parsing of tool arguments and normalisation of provider errors.
 * They hold no policy and make no network call: an adapter uses them so that every provider fails the same way, and the conformance kit uses them to judge adapters.
 */

const bytes = (v: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/** Problems of a list of tool specs (empty = fine). The schema is never interpreted here: it must only be a JSON object of bounded size. */
export function toolSpecProblems(tools: readonly ToolSpec[] | undefined): string[] {
  if (tools === undefined) return [];
  const out: string[] = [];
  if (!Array.isArray(tools)) return ['tools must be a list'];
  if (tools.length === 0) out.push('tools must not be empty when given');
  if (tools.length > TOOL_LIMITS.maxTools) out.push(`at most ${TOOL_LIMITS.maxTools} tools`);
  const seen = new Set<string>();
  for (const t of tools.slice(0, TOOL_LIMITS.maxTools)) {
    const at = `tool ${String(t?.name).slice(0, 40)}`;
    if (typeof t?.name !== 'string' || !TOOL_NAME.test(t.name))
      out.push(`${at}: the name must match ${TOOL_NAME.source}`);
    else if (seen.has(t.name)) out.push(`${at}: duplicate name`);
    else seen.add(t.name);
    if (
      typeof t?.description !== 'string' ||
      t.description.length < 1 ||
      t.description.length > TOOL_LIMITS.descriptionMax
    )
      out.push(`${at}: the description must be 1..${TOOL_LIMITS.descriptionMax} characters`);
    const s = t?.inputSchema as Record<string, unknown> | undefined;
    if (!s || typeof s !== 'object' || Array.isArray(s))
      out.push(`${at}: inputSchema must be an object`);
    else if (s.type !== 'object') out.push(`${at}: inputSchema.type must be "object"`);
    else if (bytes(s) > TOOL_LIMITS.schemaMaxBytes)
      out.push(`${at}: inputSchema is larger than ${TOOL_LIMITS.schemaMaxBytes} bytes`);
  }
  return out;
}

/**
 * The gate every adapter runs at the top of `complete` and `stream` for a request that carries tools: the model must be known and declare `tool-use` under the adapter's
 * declared contract (negotiation), the specs must be well formed, the choice must name a declared tool, and the limits must be sane. Throws a NON-retryable
 * `unsupported_capability` or `invalid_request`; a request without tools passes untouched (every 1.0 caller).
 */
export function assertToolRequest(
  adapter: { contractVersion: string },
  model: ModelInfo | undefined,
  req: Pick<CompleteRequest, 'tools' | 'toolChoice' | 'maxToolCalls'>,
): void {
  const noToolFields =
    req.tools === undefined && req.toolChoice === undefined && req.maxToolCalls === undefined;
  if (noToolFields) return;
  if (!model) throw new ModelAdapterError('invalid_request', 'unknown model', false);
  const caps = effectiveCapabilities(adapter.contractVersion, model.capabilities);
  if (!caps.includes('tool-use'))
    throw new ModelAdapterError(
      'unsupported_capability',
      contractAtLeast(adapter.contractVersion, MODEL_CONTRACT_VERSION_1_1)
        ? `model ${model.modelId} does not declare tool-use`
        : `the adapter implements contract ${adapter.contractVersion}, tool calling needs ${MODEL_CONTRACT_VERSION_1_1}`,
      false,
    );
  const problems = toolSpecProblems(req.tools);
  if (req.tools === undefined && (req.toolChoice !== undefined || req.maxToolCalls !== undefined))
    problems.push('toolChoice and maxToolCalls need tools');
  const choice = req.toolChoice;
  if (
    choice &&
    typeof choice === 'object' &&
    !(req.tools ?? []).some((t) => t.name === choice.name)
  )
    problems.push(`toolChoice names an undeclared tool`);
  if (req.maxToolCalls !== undefined) {
    if (
      !Number.isInteger(req.maxToolCalls) ||
      req.maxToolCalls < 1 ||
      req.maxToolCalls > TOOL_LIMITS.maxToolCallsPerResponse
    )
      problems.push(`maxToolCalls must be 1..${TOOL_LIMITS.maxToolCallsPerResponse}`);
    else if (req.maxToolCalls > 1 && !caps.includes('parallel-tool-calls'))
      throw new ModelAdapterError(
        'unsupported_capability',
        `model ${model.modelId} does not declare parallel-tool-calls`,
        false,
      );
  }
  if (problems.length)
    throw new ModelAdapterError('invalid_request', problems.slice(0, 6).join('; '), false);
}

/** How many calls one response may carry for this request and model. */
export function allowedToolCalls(
  model: ModelInfo,
  req: Pick<CompleteRequest, 'maxToolCalls'>,
): number {
  const parallel = model.capabilities.includes('parallel-tool-calls');
  return Math.min(
    req.maxToolCalls ?? (parallel ? TOOL_LIMITS.maxToolCallsPerResponse : 1),
    parallel ? TOOL_LIMITS.maxToolCallsPerResponse : 1,
  );
}

/** Parses the argument text of a tool call: a JSON OBJECT of bounded size, or a non-retryable `invalid_response`. */
export function parseToolArgs(text: string, name = 'tool'): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > TOOL_LIMITS.argsMaxBytes)
    throw new ModelAdapterError(
      'invalid_response',
      `the arguments of ${name} are larger than ${TOOL_LIMITS.argsMaxBytes} bytes`,
      false,
    );
  let v: unknown;
  try {
    v = JSON.parse(text === '' ? '{}' : text);
  } catch {
    throw new ModelAdapterError(
      'invalid_response',
      `the arguments of ${name} are not valid JSON`,
      false,
    );
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new ModelAdapterError(
      'invalid_response',
      `the arguments of ${name} must be a JSON object`,
      false,
    );
  return v as Record<string, unknown>;
}

/** Checks the tool calls of a response against the request: declared names, unique ids, within the number allowed. Throws `invalid_response` (non-retryable). */
export function assertToolCalls(
  calls: readonly ToolCall[],
  tools: readonly ToolSpec[] | undefined,
  max: number,
): void {
  if (calls.length > max)
    throw new ModelAdapterError(
      'invalid_response',
      `${calls.length} tool calls where at most ${max} are allowed`,
      false,
    );
  const ids = new Set<string>();
  for (const c of calls) {
    if (typeof c.id !== 'string' || c.id.length < 1 || c.id.length > 128)
      throw new ModelAdapterError('invalid_response', 'a tool call has no valid id', false);
    if (ids.has(c.id))
      throw new ModelAdapterError('invalid_response', 'duplicate tool call id', false);
    ids.add(c.id);
    if (!(tools ?? []).some((t) => t.name === c.name))
      throw new ModelAdapterError(
        'invalid_response',
        `the model called an undeclared tool (${String(c.name).slice(0, 40)})`,
        false,
      );
    if (!c.args || typeof c.args !== 'object' || Array.isArray(c.args))
      throw new ModelAdapterError(
        'invalid_response',
        `the arguments of ${c.name} must be a JSON object`,
        false,
      );
  }
}

/** The result of a fully read stream: the same shape as `complete`. */
export type AssembledResponse = Pick<
  CompleteResponse,
  'text' | 'finishReason' | 'usage' | 'toolCalls'
>;

/**
 * Assembles a stream (text deltas and tool-call deltas) into one response, validating as it goes. A stream that is out of order, ends without a `done` chunk, leaves a call
 * unfinished, carries malformed arguments or an undeclared tool, or has more than one `done` is an `invalid_response`. Nothing is executed or trusted: the result is data.
 */
export class StreamAssembler {
  private text = '';
  private readonly calls = new Map<
    number,
    { id: string; name: string; args: string; done: boolean }
  >();
  private finished: { finishReason: CompleteResponse['finishReason']; usage: Usage | null } | null =
    null;
  private bytesSeen = 0;
  constructor(
    private readonly tools?: readonly ToolSpec[],
    private readonly maxCalls: number = TOOL_LIMITS.maxToolCallsPerResponse,
  ) {}

  private bad(m: string): never {
    throw new ModelAdapterError('invalid_response', m, false);
  }

  push(chunk: StreamChunk): void {
    if (this.finished) this.bad('data after the done chunk');
    if ('delta' in chunk) {
      this.text += chunk.delta;
      return;
    }
    if ('toolCallDelta' in chunk) {
      const d = chunk.toolCallDelta;
      if (!Number.isInteger(d.index) || d.index < 0 || d.index >= this.maxCalls)
        this.bad('a tool call index is out of range');
      let c = this.calls.get(d.index);
      if (!c) {
        if (d.index !== this.calls.size)
          this.bad('tool call indexes must start at 0 and be contiguous');
        if (typeof d.id !== 'string' || typeof d.name !== 'string')
          this.bad('the first piece of a tool call must carry its id and name');
        c = { id: d.id, name: d.name, args: '', done: false };
        this.calls.set(d.index, c);
      } else if (c.done) this.bad('a piece arrived for a finished tool call');
      else if ((d.id !== undefined && d.id !== c.id) || (d.name !== undefined && d.name !== c.name))
        this.bad('a tool call changed its id or name');
      if (d.argsDelta) {
        this.bytesSeen += Buffer.byteLength(d.argsDelta, 'utf8');
        if (this.bytesSeen > TOOL_LIMITS.argsMaxBytes * TOOL_LIMITS.maxToolCallsPerResponse)
          this.bad('the tool-call arguments are too large');
        c.args += d.argsDelta;
      }
      return;
    }
    if ('toolCallDone' in chunk) {
      const c = this.calls.get(chunk.toolCallDone.index);
      if (!c) this.bad('a tool call finished before it started');
      if (c.done) this.bad('a tool call finished twice');
      c.done = true;
      return;
    }
    this.finished = { finishReason: chunk.finishReason, usage: chunk.usage };
  }

  result(): AssembledResponse {
    if (!this.finished) this.bad('the stream ended without a done chunk');
    const calls: ToolCall[] = [];
    for (const [, c] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!c.done) this.bad('the stream ended with an unfinished tool call');
      calls.push({ id: c.id, name: c.name, args: parseToolArgs(c.args, c.name) });
    }
    assertToolCalls(calls, this.tools, this.maxCalls);
    if (this.finished.finishReason === 'tool_calls' && calls.length === 0)
      this.bad('finishReason tool_calls without a tool call');
    if (
      calls.length > 0 &&
      this.finished.finishReason !== 'tool_calls' &&
      this.finished.finishReason !== 'length'
    )
      this.bad('tool calls with a finishReason that is not tool_calls');
    return {
      text: this.text,
      finishReason: this.finished.finishReason,
      usage: this.finished.usage,
      ...(calls.length ? { toolCalls: calls } : {}),
    };
  }
}

/** Reads a whole stream into one response. Cancellation: the adapter's stream throws `aborted`; this helper adds nothing and swallows nothing. */
export async function assembleStream(
  stream: AsyncIterable<StreamChunk>,
  opts: { tools?: readonly ToolSpec[]; maxCalls?: number; onChunk?: (c: StreamChunk) => void } = {},
): Promise<AssembledResponse> {
  const a = new StreamAssembler(opts.tools, opts.maxCalls);
  for await (const c of stream) {
    a.push(c);
    opts.onChunk?.(c);
  }
  return a.result();
}

/**
 * Error normalisation for adapters: anything a provider SDK or a network stack throws becomes a `ModelAdapterError` with a code of this contract and the retry rule below. The
 * raw message is NOT carried (a provider message may echo a prompt or a key): only the code and a fixed sentence.
 *  - an AbortError or an aborted signal → `aborted` (never retried)
 *  - HTTP 400/404/413/422 → `invalid_request` · 401/403 → `unavailable` (a credential problem is not the caller's to retry) · 408 and timeouts → `timeout` · 429 → `rate_limited`
 *  - HTTP >= 500, overloaded, network errors → `unavailable` · a content or safety refusal → `content_filtered`
 */
export function normalizeModelError(e: unknown): ModelAdapterError {
  if (e instanceof ModelAdapterError) return e;
  const x = (e ?? {}) as { name?: unknown; status?: unknown; code?: unknown; type?: unknown };
  const status = typeof x.status === 'number' ? x.status : undefined;
  const text =
    `${String(x.name ?? '')} ${String(x.code ?? '')} ${String(x.type ?? '')}`.toLowerCase();
  if (/abort/.test(text)) return new ModelAdapterError('aborted', 'the call was aborted', false);
  if (/content_filter|safety|refus|policy_violation|invalid_prompt/.test(text) || status === 451)
    return new ModelAdapterError('content_filtered', 'the provider refused the content', false);
  if (status === 429 || /rate_?limit/.test(text))
    return new ModelAdapterError('rate_limited', 'the provider rate-limited the call');
  if (status === 408 || /timeout|etimedout|timedout/.test(text))
    return new ModelAdapterError('timeout', 'the provider call timed out');
  if (status !== undefined && [400, 404, 413, 422].includes(status))
    return new ModelAdapterError('invalid_request', 'the provider rejected the request', false);
  if (
    (status !== undefined && status >= 500) ||
    /overload|unavailable|econn|enotfound|network|socket|fetch/.test(text) ||
    status === 401 ||
    status === 403
  )
    return new ModelAdapterError('unavailable', 'the provider is unavailable');
  return new ModelAdapterError('unavailable', 'the provider call failed');
}
