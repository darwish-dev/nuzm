import {
  MODEL_CONTRACT_VERSION,
  MODEL_CONTRACT_VERSION_1_1,
  ModelAdapterError,
  estimateTokens,
  type CallContext,
  type CompleteRequest,
  type CompleteResponse,
  type DataTerms,
  type DiscoveredModel,
  type ModelAdapter,
  type ModelInfo,
  type ModelMessage,
  type ProviderPricing,
  type StreamChunk,
  type ToolCall,
  type Usage,
  LiveCallsNotApprovedError,
} from './types';
import { allowedToolCalls, assertToolCalls, assertToolRequest, parseToolArgs } from './tools';
import {
  ADAPTER_TIMEOUT_MS,
  errorFromResponse,
  linkSignal,
  mapTransportError,
  readJsonBody,
  readSse,
  safeRequestId,
  type FetchLike,
} from './http-transport';

/**
 * OpenAI (Chat Completions API) behind the `ModelAdapter` contract. STATUS: IMPLEMENTED BEHIND D11, NEVER EXERCISED LIVE. Written from the vendor's official documentation read on
 * 2026-11-24 (docs/adapters/openai.md lists every page, every field relied on and every statement that stayed NOT FOUND). It is not registered anywhere, it has no key, and a call is
 * refused unless the owner's live gate (`liveEnabled`) lists it: nothing here makes OpenAI available. Capabilities beyond chat/structured output are declared as CANDIDATES only for
 * contract 1.1 and count only from a VERIFIED evidence row (D8); until a probe has run against the real service they are "unknown = unsupported".
 *
 * It declares facts and performs calls; it never decides policy (residency, the data-terms attestation, budget, secret scan: the gateway, before `complete`).
 */
export const OPENAI_PROVIDER_ID = 'openai';
/** The one model declared (the pricing field of an adapter is per adapter). Limits and list price: docs/adapters/openai.md §8, read 2026-11-24. */
export const OPENAI_MODEL_ID = 'gpt-6.1-terra';

const BASE_CAPABILITIES: ModelInfo['capabilities'] = ['chat', 'structured-output', 'long-context'];
const TOOL_CAPABILITIES: ModelInfo['capabilities'] = [
  'tool-use',
  'streaming-tool-calls',
  'parallel-tool-calls',
];
const modelsFor = (v11: boolean): ModelInfo[] => [
  {
    modelId: OPENAI_MODEL_ID,
    capabilities: v11 ? [...BASE_CAPABILITIES, ...TOOL_CAPABILITIES] : [...BASE_CAPABILITIES],
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    latencyClass: 'medium',
  },
];
/** The vendor's own list price (our COST input), USD per million tokens, standard short-context tier (docs/adapters/openai.md §8). */
const PRICING: ProviderPricing = {
  currency: 'USD',
  inputPerMillion: '1.00',
  outputPerMillion: '5.00',
};

/**
 * Pre-flight margin: the vendor documents no tokenizer margin, so this is OUR assumption (not a vendor fact) to keep a reservation from being too low. The provider's own
 * `usage` is used whenever it reports one.
 */
const TOKENIZER_MARGIN = 1.25;

/** The ONE host this adapter talks to: fixed in code, never from the environment, a request or the database. */
const BASE_URL = 'https://api.openai.com/v1';

/**
 * Documented: "Starting with GPT-5.4, Chat Completions does not support tool calling with `reasoning_effort` values other than `none`" (migrate-to-responses guide). A request that
 * carries tools therefore sets `none` explicitly. NOT VERIFIED for the declared model: if the vendor rejects it, the probe records NOT VERIFIED and tools stay off.
 */
const TOOL_REASONING_EFFORT = 'none';
/** Vendor-documented `error.code` values that answer HTTP 429 but are billing, spend or quota limits: retrying cannot help (error-codes guide). */
export const OPENAI_SPEND_CODES = [
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
] as const;
/** The id of a tool call echoed back to the vendor: its format is not documented, so only a conservative shape is sent. */
const WIRE_TOOL_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export interface OpenAIAdapterOptions {
  /** Reads the API key when a call is made (from the secret store). `null` = no key stored. */
  getApiKey: () => Promise<string | null>;
  region?: string;
  /** tests only: the transport */
  fetchImpl?: FetchLike;
  /** default '1.0' (no tool capability declared); '1.1' declares and implements tool calling (candidates until evidence) */
  contract?: '1.0' | '1.1';
  /** the live-egress gate, asked before every call and before the key is read. `false` refuses with a non-retryable `unavailable`. */
  liveEnabled?: () => boolean;
  timeoutMs?: number;
}

const JSON_ONLY =
  'Reply with exactly one JSON value and nothing else: no code fences and no commentary.';
const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
};
type Wire = Record<string, unknown>;

export class OpenAIModelAdapter implements ModelAdapter {
  readonly kind = 'model' as const;
  readonly contractVersion: string;
  readonly id = OPENAI_PROVIDER_ID;
  readonly region: string;
  readonly dataTerms: DataTerms;
  readonly pricing = PRICING;
  private readonly v11: boolean;
  private readonly f: FetchLike;

  constructor(private readonly o: OpenAIAdapterOptions) {
    this.v11 = o.contract === '1.1';
    this.contractVersion = this.v11 ? MODEL_CONTRACT_VERSION_1_1 : MODEL_CONTRACT_VERSION;
    this.region = o.region ?? 'unspecified';
    this.dataTerms = {
      attested: false,
      retainsPrompts: 'unknown',
      trainsOnData: 'unknown',
      processingRegion: this.region,
    };
    this.f = o.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  models(): ModelInfo[] {
    return modelsFor(this.v11);
  }

  tokenCount(_model: string, messages: ModelMessage[]): number {
    return Math.ceil(estimateTokens(messages) * TOKENIZER_MARGIN);
  }

  /** `GET /v1/models`: read-only, no prompt, nothing billed. One bounded list; ids sanitised. NOT live-verified. */
  async discoverModels(ctx: CallContext): Promise<DiscoveredModel[]> {
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', 'the call was aborted');
    this.assertLive();
    const key = await this.key();
    const l = linkSignal(ctx.signal, this.o.timeoutMs ?? ADAPTER_TIMEOUT_MS);
    try {
      const res = await this.f(`${BASE_URL}/models`, {
        method: 'GET',
        headers: this.headers(key),
        signal: l.signal,
      });
      if (!res.ok) throw await errorFromResponse(res, OPENAI_SPEND_CODES);
      const body = await readJsonBody(res);
      const data = Array.isArray(body.data) ? (body.data as unknown[]) : [];
      const out: DiscoveredModel[] = [];
      for (const m of data.slice(0, 200)) {
        const x = m as { id?: unknown; created?: unknown };
        if (typeof x?.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(x.id)) continue;
        out.push({
          modelId: x.id,
          ...(typeof x.created === 'number' && Number.isFinite(x.created)
            ? { createdAt: new Date(x.created * 1000).toISOString() }
            : {}),
        });
      }
      return out;
    } catch (e) {
      throw mapTransportError(e, l, ctx.signal);
    } finally {
      l.dispose();
    }
  }

  async complete(ctx: CallContext, req: CompleteRequest): Promise<CompleteResponse> {
    const body = this.body(ctx, req, false);
    this.assertLive();
    const key = await this.key();
    const l = linkSignal(ctx.signal, this.o.timeoutMs ?? ADAPTER_TIMEOUT_MS);
    try {
      const res = await this.f(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.headers(key),
        body: JSON.stringify(body),
        signal: l.signal,
      });
      if (!res.ok) throw await errorFromResponse(res, OPENAI_SPEND_CODES);
      const rid = safeRequestId(res.headers.get('x-request-id'));
      const r = this.response(req, await readJsonBody(res));
      return rid ? { ...r, requestId: rid } : r;
    } catch (e) {
      throw mapTransportError(e, l, ctx.signal);
    } finally {
      l.dispose();
    }
  }

  async *stream(ctx: CallContext, req: CompleteRequest): AsyncGenerator<StreamChunk> {
    const body = this.body(ctx, req, true);
    this.assertLive();
    const key = await this.key();
    const l = linkSignal(ctx.signal, this.o.timeoutMs ?? ADAPTER_TIMEOUT_MS);
    try {
      const res = await this.f(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.headers(key),
        body: JSON.stringify(body),
        signal: l.signal,
      });
      if (!res.ok) throw await errorFromResponse(res, OPENAI_SPEND_CODES);
      const rid = safeRequestId(res.headers.get('x-request-id'));
      const toolIndex = new Map<number, number>(); // the vendor's tool_calls index -> our contiguous index
      const open = new Set<number>();
      let finish: string | null = null;
      let usage: Usage | null = null;
      let sawDone = false;
      for await (const data of readSse(res)) {
        if (data === '[DONE]') {
          sawDone = true;
          break;
        }
        let chunk: {
          choices?: { delta?: Wire; finish_reason?: string | null }[];
          usage?: Wire | null;
        };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          throw new ModelAdapterError(
            'invalid_response',
            'a stream chunk is not valid JSON',
            false,
          );
        }
        if (chunk.usage) usage = this.usage(chunk.usage);
        const ch = chunk.choices?.[0];
        if (!ch) continue; // the final usage chunk has `choices: []`
        const d = ch.delta ?? {};
        if (typeof d.content === 'string' && d.content) yield { delta: d.content };
        if (this.v11 && Array.isArray(d.tool_calls))
          for (const tc of d.tool_calls as {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[]) {
            if (typeof tc.index !== 'number') continue;
            let idx = toolIndex.get(tc.index);
            if (idx === undefined) {
              idx = toolIndex.size;
              toolIndex.set(tc.index, idx);
              open.add(idx);
              yield { toolCallDelta: { index: idx, id: tc.id, name: tc.function?.name } };
            }
            if (tc.function?.arguments)
              yield { toolCallDelta: { index: idx, argsDelta: tc.function.arguments } };
          }
        if (typeof ch.finish_reason === 'string') {
          finish = ch.finish_reason;
          for (const i of [...open].sort((a, b) => a - b)) yield { toolCallDone: { index: i } };
          open.clear();
        }
      }
      if (finish === null || !sawDone)
        throw new ModelAdapterError(
          'unavailable',
          'the provider stream ended before it finished',
          true,
        );
      yield {
        done: true,
        finishReason: this.finishReason(finish, toolIndex.size > 0),
        usage,
        ...(rid ? { requestId: rid } : {}),
      };
    } catch (e) {
      throw mapTransportError(e, l, ctx.signal);
    } finally {
      l.dispose();
    }
  }

  // ---- internals --------------------------------------------------------------------------------------------------------------------------------------------

  private assertLive(): void {
    if (this.o.liveEnabled && !this.o.liveEnabled()) throw new LiveCallsNotApprovedError();
  }
  private async key(): Promise<string> {
    const key = await this.o.getApiKey().catch(() => null);
    if (!key)
      throw new ModelAdapterError('unavailable', 'no API key is stored for this provider', false);
    return key;
  }
  /** Bearer authentication only; no organization or project header (those are optional and would come from the provider row in a later step). */
  private headers(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }

  private usage(u: Wire): Usage | null {
    const i = u.prompt_tokens;
    const o = u.completion_tokens;
    if (typeof i !== 'number' || typeof o !== 'number' || !Number.isFinite(i + o)) return null;
    return { inputTokens: i, outputTokens: o };
  }

  private finishReason(
    v: string | null | undefined,
    hasCalls: boolean,
  ): CompleteResponse['finishReason'] {
    switch (v) {
      case 'length':
        return 'length';
      case 'content_filter':
        return 'refusal';
      case 'tool_calls':
        return 'tool_calls';
      case 'stop':
        return hasCalls ? 'tool_calls' : 'stop';
      default:
        throw new ModelAdapterError(
          'invalid_response',
          'the provider sent an unknown finish reason',
          false,
        );
    }
  }

  /** Request body. No `temperature` (restrictions on newer models are not stated in the documentation read), no `user`; the output ceiling is `max_completion_tokens`. */
  private body(ctx: CallContext, req: CompleteRequest, stream: boolean): Wire {
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', 'the call was aborted');
    const model = this.models().find((m) => m.modelId === req.model);
    if (!model) throw new ModelAdapterError('invalid_request', `unknown model ${req.model}`, false);
    assertToolRequest(this, model, req);
    const withTools = this.v11 && !!req.tools?.length;
    const messages: Wire[] = [];
    const json = req.responseFormat === 'json';
    for (const m of req.messages) this.wireMessage(m, withTools, messages);
    if (!messages.some((m) => m.role === 'user'))
      throw new ModelAdapterError('invalid_request', 'a conversation needs a user message', false);
    if (withTools) this.assertToolHistory(req.messages);
    // the documented JSON mode needs an instruction in a message to produce JSON
    if (json) messages.unshift({ role: 'developer', content: JSON_ONLY });
    const limit = withTools ? allowedToolCalls(model, req) : 1;
    return {
      model: req.model,
      messages,
      max_completion_tokens: req.maxTokens, // a hard ceiling (includes reasoning tokens, per the documentation)
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...(withTools
        ? {
            tools: req.tools!.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: this.toolChoice(req),
            parallel_tool_calls: limit > 1,
            reasoning_effort: TOOL_REASONING_EFFORT,
          }
        : {}),
    };
  }

  private toolChoice(req: CompleteRequest): unknown {
    const c = req.toolChoice ?? 'auto';
    if (c === 'none' || c === 'auto') return c;
    return { type: 'function', function: { name: c.name } };
  }

  /** One neutral message → one or more wire messages (a tool result is its own `tool` message). Without tools, blocks are flattened to text (as the Claude adapter does). */
  private wireMessage(m: ModelMessage, withTools: boolean, out: Wire[]): void {
    const role = m.role === 'system' ? 'developer' : m.role;
    if (!m.blocks) {
      out.push({ role, content: m.content });
      return;
    }
    if (!withTools) {
      const parts = m.blocks
        .map((b) =>
          b.type === 'text'
            ? b.text
            : b.type === 'tool_call'
              ? `[tool call ${b.name}: ${safeJson(b.args)}]`
              : `[tool result${b.isError ? ' (error)' : ''}]\n${b.content}`,
        )
        .filter((x) => x.length > 0);
      out.push({ role, content: parts.join('\n\n') || ' ' });
      return;
    }
    const text = m.blocks
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (m.role === 'assistant') {
      const calls = m.blocks.filter(
        (b): b is Extract<typeof b, { type: 'tool_call' }> => b.type === 'tool_call',
      );
      for (const c of calls)
        if (!WIRE_TOOL_ID.test(c.id))
          throw new ModelAdapterError('invalid_request', 'a tool call has an invalid id', false);
      if (m.blocks.some((b) => b.type === 'tool_result'))
        throw new ModelAdapterError(
          'invalid_request',
          'a tool result must be in a user message',
          false,
        );
      out.push({
        role: 'assistant',
        content: text.length ? text : null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                type: 'function',
                id: c.id,
                function: { name: c.name, arguments: safeJson(c.args ?? {}) },
              })),
            }
          : {}),
      });
      return;
    }
    if (m.blocks.some((b) => b.type === 'tool_call'))
      throw new ModelAdapterError(
        'invalid_request',
        'a tool call must be in an assistant message',
        false,
      );
    for (const b of m.blocks)
      if (b.type === 'tool_result') {
        if (!WIRE_TOOL_ID.test(b.callId))
          throw new ModelAdapterError(
            'invalid_request',
            'a tool result carries an invalid call id',
            false,
          );
        // the wire has no error flag on a tool message: an error result is marked in its text
        out.push({
          role: 'tool',
          tool_call_id: b.callId,
          content: b.isError ? `[error] ${b.content}` : b.content,
        });
      }
    if (text.length) out.push({ role, content: text });
  }

  /** The vendor refuses a call that is not answered by a result (and a result without a call): caught before a billed call. */
  private assertToolHistory(messages: ModelMessage[]): void {
    const turns = messages.filter((m) => m.role !== 'system');
    for (let i = 0; i < turns.length; i++) {
      const calls = (turns[i]!.blocks ?? [])
        .filter((b) => b.type === 'tool_call')
        .map((b) => (b as { id: string }).id);
      const results = (turns[i]!.blocks ?? [])
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b as { callId: string }).callId);
      if (calls.length) {
        const next = (turns[i + 1]?.blocks ?? [])
          .filter((b) => b.type === 'tool_result')
          .map((b) => (b as { callId: string }).callId);
        if (
          new Set(next).size !== next.length ||
          calls.length !== next.length ||
          !calls.every((c) => next.includes(c))
        )
          throw new ModelAdapterError(
            'invalid_request',
            'every tool call needs exactly one result in the next message',
            false,
          );
      }
      if (results.length) {
        const prev = (turns[i - 1]?.blocks ?? [])
          .filter((b) => b.type === 'tool_call')
          .map((b) => (b as { id: string }).id);
        if (!results.every((r) => prev.includes(r)))
          throw new ModelAdapterError(
            'invalid_request',
            'a tool result does not answer a call of the previous message',
            false,
          );
      }
    }
  }

  private response(req: CompleteRequest, body: Wire): CompleteResponse {
    const choice = (
      body.choices as { message?: Wire; finish_reason?: string | null }[] | undefined
    )?.[0];
    if (!choice?.message)
      throw new ModelAdapterError('invalid_response', 'the provider answer has no choice', false);
    const msg = choice.message;
    const text = typeof msg.content === 'string' ? msg.content : '';
    const usage =
      body.usage && typeof body.usage === 'object' ? this.usage(body.usage as Wire) : null;
    const model = req.model;
    const rawCalls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Wire[]) : [];
    if (typeof msg.refusal === 'string' && msg.refusal.length > 0 && rawCalls.length === 0)
      return { text: '', finishReason: 'refusal', usage, model };
    let finishReason = this.finishReason(choice.finish_reason, rawCalls.length > 0);
    if (!this.v11 || rawCalls.length === 0) {
      if (finishReason === 'tool_calls')
        throw new ModelAdapterError(
          'invalid_response',
          'the provider stopped for a tool call but sent none',
          false,
        );
      return { text, finishReason, usage, model };
    }
    if (finishReason !== 'tool_calls')
      throw new ModelAdapterError(
        'invalid_response',
        'the answer ended in the middle of a tool call',
        false,
      );
    finishReason = 'tool_calls';
    const toolCalls: ToolCall[] = rawCalls.map((c) => {
      const f = (c.function ?? {}) as { name?: unknown; arguments?: unknown };
      if (c.type !== undefined && c.type !== 'function')
        throw new ModelAdapterError(
          'invalid_response',
          'the provider sent a tool call of an unsupported kind',
          false,
        );
      const name = String(f.name ?? '');
      return {
        id: String(c.id ?? ''),
        name,
        args: parseToolArgs(typeof f.arguments === 'string' ? f.arguments : '', name),
      };
    });
    assertToolCalls(toolCalls, req.tools, allowedToolCalls(this.models()[0]!, req));
    return { text, finishReason, toolCalls, usage, model };
  }
}
