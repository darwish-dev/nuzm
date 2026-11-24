import Anthropic from '@anthropic-ai/sdk';
import {
  MODEL_CONTRACT_VERSION,
  MODEL_CONTRACT_VERSION_1_1,
  ModelAdapterError,
  estimateTokens,
  type CallContext,
  type CompleteRequest,
  type CompleteResponse,
  type ContentBlock,
  type DataTerms,
  type DiscoveredModel,
  type ModelAdapter,
  type ModelInfo,
  type ModelMessage,
  type ProviderPricing,
  type StreamChunk,
  type ToolCall,
  type Usage,
} from './types';
import { allowedToolCalls, assertToolCalls, assertToolRequest } from './tools';
import { parseRetryAfterMs } from './resilience';

/**
 * Claude (Anthropic Messages API) behind the `ModelAdapter` contract (docs/09 §7), written from the provider's official documentation (docs/adapters/anthropic.md)
 * and the official SDK. It declares facts and performs calls; it never decides policy: residency, the human data-terms attestation, the budget reservation and
 * the secret scan all run in the gateway BEFORE `complete` is reached.
 *
 * Facts it declares are only what the documentation states: one model, its limits and its list price. Data terms are declared UNATTESTED and unknown: only a
 * human can attest them (HG-09-01), and that is stored on the provider row, never here. Nothing is claimed about quality (NOT VERIFIED).
 */
export const CLAUDE_MODEL_ID = 'claude-opus-5-5';
export const CLAUDE_PROVIDER_ID = 'claude';

const BASE_CAPABILITIES: ModelInfo['capabilities'] = ['chat', 'structured-output', 'long-context'];
/**
 * Contract 1.1 (S-AG4 preparation): tool calling is declared ONLY when the adapter is built with `contract: '1.1'`. The wire mapping below follows the Messages API
 * documentation (tool_use / tool_result blocks, input_json_delta streaming, parallel tool use), but "unknown = unsupported" until a live probe has recorded it as
 * LIVE-VERIFIED, so the default stays 1.0 and nothing in the platform asks Claude for tools.
 */
const TOOL_CAPABILITIES: ModelInfo['capabilities'] = [
  'tool-use',
  'streaming-tool-calls',
  'parallel-tool-calls',
];
const modelsFor = (v11: boolean): ModelInfo[] => [
  {
    modelId: CLAUDE_MODEL_ID,
    capabilities: v11 ? [...BASE_CAPABILITIES, ...TOOL_CAPABILITIES] : [...BASE_CAPABILITIES],
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    latencyClass: 'medium',
  },
];
/** The provider's own list price (our COST input), USD per million tokens, for the model above (docs/adapters/anthropic.md). */
const PRICING: ProviderPricing = {
  currency: 'USD',
  inputPerMillion: '4.00',
  outputPerMillion: '20.00',
};

/** Pre-flight margin for the tokenizer of this model family (provider documentation, read 2026-11-22: about 30% more tokens for the same text). */
const TOKENIZER_MARGIN = 1.3;

const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
};

/** The ONE host this adapter talks to: fixed in code, never from the environment, a request or the database. */
const BASE_URL = 'https://api.anthropic.com';
const SDK_TIMEOUT_MS = 120_000; // a backstop: the gateway aborts a call on its own, shorter, timer

/** What the adapter needs of the SDK client: small on purpose, so a test can supply a deterministic one. */
export interface ClaudeContentBlock {
  type: string;
  text?: string;
  /** `tool_use` blocks */
  id?: string;
  name?: string;
  input?: unknown;
}
export interface ClaudeMessage {
  content: ClaudeContentBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}
export interface ClaudeStreamEvent {
  type: string;
  /** position of the content block (content_block_start / _delta / _stop) */
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
}
export interface ClaudeModelListing {
  data: { id: string; display_name?: string | null; created_at?: string | null }[];
}
export interface ClaudeClient {
  /** optional: only model discovery uses it */
  models?: {
    list(
      params?: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ): Promise<ClaudeModelListing>;
  };
  messages: {
    create(
      params: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ): Promise<ClaudeMessage>;
    stream(
      params: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<ClaudeStreamEvent> & { finalMessage(): Promise<ClaudeMessage> };
  };
}

export interface AnthropicAdapterOptions {
  /** Reads the API key when a call is made (from the secret store). `null` = no key stored. The adapter keeps no key beyond the client built for it. */
  getApiKey: () => Promise<string | null>;
  /** where the provider processes the data, as stated on the provider row; default "unspecified" (a human decides) */
  region?: string;
  /** tests only: build the client */
  clientFactory?: (apiKey: string) => ClaudeClient;
  /** The contract this adapter implements. Default '1.0' (no tool capability is declared); '1.1' declares tool calling for the model and implements it (S-AG4). */
  contract?: '1.0' | '1.1';
  /**
   * The live-egress gate: asked before every call, before the key is even read. `false` refuses the call with a non-retryable `unavailable` and nothing leaves the process.
   * The platform wires this to the owner's approval of live calls to this provider (default: not approved). Absent = allowed (library default, for tests with a stub).
   */
  liveEnabled?: () => boolean;
}

const JSON_ONLY =
  'Reply with exactly one JSON value and nothing else: no code fences and no commentary.';
/** The id of a tool call the Messages API accepts (`tool_use.id`): anything else is refused before a billed call is made. */
const WIRE_TOOL_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const ERR = {
  timeout: 'the model did not answer in time',
  rate_limited: 'the model provider is limiting requests',
  spend_limit:
    'the model provider spending limit is reached (raise it in the vendor console, or wait for the next billing month)',
  unavailable: 'the model provider is unavailable',
  content_filtered: 'the model provider declined the request',
  invalid_request: 'the model provider rejected the request',
  aborted: 'the call was aborted',
} as const;

export class AnthropicModelAdapter implements ModelAdapter {
  readonly kind = 'model' as const;
  readonly contractVersion: string;
  readonly id = CLAUDE_PROVIDER_ID;
  readonly region: string;
  readonly dataTerms: DataTerms;
  readonly pricing = PRICING;
  private cached: { key: string; client: ClaudeClient } | null = null;

  private readonly v11: boolean;

  constructor(private readonly o: AnthropicAdapterOptions) {
    this.v11 = o.contract === '1.1';
    this.contractVersion = this.v11 ? MODEL_CONTRACT_VERSION_1_1 : MODEL_CONTRACT_VERSION;
    this.region = o.region ?? 'unspecified';
    // unknown until a human attests (HG-09-01): the gateway reads the ATTESTED terms from the provider row
    this.dataTerms = {
      attested: false,
      retainsPrompts: 'unknown',
      trainsOnData: 'unknown',
      processingRegion: this.region,
    };
  }

  models(): ModelInfo[] {
    return modelsFor(this.v11);
  }

  /**
   * Model discovery (`GET /v1/models`, read-only, no prompt, nothing billed). Behind the same live gate and key rules as a call: closed gate = nothing leaves the process.
   * One bounded page (100); ids are sanitised, display names clipped. NOT live-verified: the shape is the SDK's, exercised only against a stub.
   */
  async discoverModels(ctx: CallContext): Promise<DiscoveredModel[]> {
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', ERR.aborted);
    this.assertLive();
    const client = await this.client();
    if (!client.models)
      throw new ModelAdapterError('unavailable', 'model listing is not available', false);
    try {
      const page = await client.models.list({ limit: 100 }, { signal: ctx.signal });
      const out: DiscoveredModel[] = [];
      for (const m of page.data.slice(0, 100)) {
        if (typeof m.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(m.id)) continue;
        out.push({
          modelId: m.id,
          ...(typeof m.display_name === 'string'
            ? { displayName: m.display_name.slice(0, 120) }
            : {}),
          ...(typeof m.created_at === 'string' ? { createdAt: m.created_at.slice(0, 40) } : {}),
        });
      }
      return out;
    } catch (e) {
      throw this.mapError(e, ctx.signal);
    }
  }

  tokenCount(_model: string, messages: ModelMessage[]): number {
    // a local estimate; the provider's own count is used whenever it reports one. The documentation says this model family produces about 30% more tokens for the same text than
    // the characters/4 rule assumes, so the PRE-FLIGHT estimate (reservations, caps) carries that margin: an estimate that is too low would let a call reserve less than it can use.
    return Math.ceil(estimateTokens(messages) * TOKENIZER_MARGIN);
  }

  async complete(ctx: CallContext, req: CompleteRequest): Promise<CompleteResponse> {
    const params = this.params(ctx, req);
    this.assertLive();
    const client = await this.client();
    try {
      const msg = await client.messages.create(params, { signal: ctx.signal });
      return this.response(req.model, msg, req);
    } catch (e) {
      throw this.mapError(e, ctx.signal);
    }
  }

  async *stream(ctx: CallContext, req: CompleteRequest): AsyncGenerator<StreamChunk> {
    const params = this.params(ctx, req);
    this.assertLive();
    const client = await this.client();
    // our own controller, linked to the caller's signal: if the consumer stops reading (a `return` from the generator) the request is aborted, not left running
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const s = client.messages.stream(params, { signal: ac.signal });
      const toolIndex = new Map<number, number>(); // the provider's block index -> our contiguous tool-call index
      for await (const ev of s) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text)
          yield { delta: ev.delta.text };
        else if (
          this.v11 &&
          ev.type === 'content_block_start' &&
          ev.content_block?.type === 'tool_use' &&
          typeof ev.index === 'number'
        ) {
          const idx = toolIndex.size;
          toolIndex.set(ev.index, idx);
          yield {
            toolCallDelta: { index: idx, id: ev.content_block.id, name: ev.content_block.name },
          };
        } else if (
          this.v11 &&
          ev.type === 'content_block_delta' &&
          ev.delta?.type === 'input_json_delta' &&
          typeof ev.index === 'number' &&
          toolIndex.has(ev.index)
        ) {
          if (ev.delta.partial_json)
            yield {
              toolCallDelta: { index: toolIndex.get(ev.index)!, argsDelta: ev.delta.partial_json },
            };
        } else if (
          this.v11 &&
          ev.type === 'content_block_stop' &&
          typeof ev.index === 'number' &&
          toolIndex.has(ev.index)
        )
          yield { toolCallDone: { index: toolIndex.get(ev.index)! } };
      }
      const final = await s.finalMessage();
      const r = this.response(req.model, final, req);
      yield { done: true, finishReason: r.finishReason, usage: r.usage };
    } catch (e) {
      throw this.mapError(e, ctx.signal);
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
      ac.abort();
    }
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------------------------------------

  private assertLive(): void {
    if (this.o.liveEnabled && !this.o.liveEnabled())
      throw new ModelAdapterError(
        'unavailable',
        'live calls to this model provider are not approved in this environment',
        false,
      );
  }

  private async client(): Promise<ClaudeClient> {
    const key = await this.o.getApiKey().catch(() => null);
    if (!key)
      throw new ModelAdapterError('unavailable', 'no API key is stored for this provider', false);
    if (this.cached?.key !== key) {
      this.cached = {
        key,
        client:
          this.o.clientFactory?.(key) ??
          (new Anthropic({
            apiKey: key,
            authToken: null, // never fall back to a token from the environment
            baseURL: BASE_URL,
            maxRetries: 0, // retries are the gateway's decision (attempts per candidate)
            timeout: SDK_TIMEOUT_MS,
          }) as unknown as ClaudeClient),
      };
    }
    return this.cached.client;
  }

  /** Request parameters. No `temperature`/`top_p` (removed on this model), no prefill, thinking left at the model's default; effort is explicit. */
  private params(ctx: CallContext, req: CompleteRequest): Record<string, unknown> {
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', ERR.aborted);
    const model = this.models().find((m) => m.modelId === req.model);
    if (!model) throw new ModelAdapterError('invalid_request', `unknown model ${req.model}`, false);
    // a tool request is checked first (declared capability under the declared contract, well-formed specs, sane limits): nothing is sent for an invalid one
    assertToolRequest(this, model, req);
    const withTools = this.v11 && !!req.tools?.length;
    const system: string[] = [];
    const messages: { role: 'user' | 'assistant'; content: string | Record<string, unknown>[] }[] =
      [];
    for (const m of req.messages) {
      if (m.role === 'system') system.push(m.content);
      else messages.push({ role: m.role, content: this.wireContent(m, withTools) });
    }
    if (messages.length === 0 || messages[0]!.role !== 'user')
      throw new ModelAdapterError(
        'invalid_request',
        'a conversation must start with a user message',
        false,
      );
    if (withTools) this.assertToolHistory(req.messages);
    if (req.responseFormat === 'json') system.push(JSON_ONLY);
    const limit = withTools ? allowedToolCalls(model, req) : 1;
    return {
      model: req.model,
      max_tokens: req.maxTokens, // a hard ceiling
      ...(system.length ? { system: system.join('\n\n') } : {}),
      messages,
      output_config: { effort: 'medium' },
      ...(withTools
        ? {
            tools: req.tools!.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
            tool_choice: this.toolChoice(req, limit),
          }
        : {}),
    };
  }

  private toolChoice(req: CompleteRequest, limit: number): Record<string, unknown> {
    const c = req.toolChoice ?? 'auto';
    if (c === 'none') return { type: 'none' };
    // one call per response unless more were asked for (and the model declares parallel calls: checked above)
    const serial = limit === 1 ? { disable_parallel_tool_use: true } : {};
    return typeof c === 'object'
      ? { type: 'tool', name: c.name, ...serial }
      : { type: 'auto', ...serial };
  }

  /**
   * The wire content of one message. A message without blocks is sent exactly as before. With blocks and a tool request they become tool_use / tool_result / text blocks
   * (results first, as the API requires); when the request carries NO tools (the forced last turn of the agent loop) the API would refuse tool blocks, so they are
   * written as plain text instead (the result text is already fenced as untrusted data by the caller).
   */
  private wireContent(m: ModelMessage, withTools: boolean): string | Record<string, unknown>[] {
    if (!m.blocks) return m.content;
    const text = (b: Extract<ContentBlock, { type: 'text' }>) => ({ type: 'text', text: b.text });
    if (!withTools) {
      const parts = m.blocks.map((b) =>
        b.type === 'text'
          ? b.text
          : b.type === 'tool_call'
            ? `[tool call ${b.name}: ${safeJson(b.args)}]`
            : `[tool result${b.isError ? ' (error)' : ''}]\n${b.content}`,
      );
      return parts.filter((x) => x.length > 0).join('\n\n') || ' ';
    }
    const out: Record<string, unknown>[] = [];
    if (m.role === 'user')
      for (const b of m.blocks)
        if (b.type === 'tool_result') {
          if (!WIRE_TOOL_ID.test(b.callId))
            throw new ModelAdapterError(
              'invalid_request',
              'a tool result carries an invalid call id',
              false,
            );
          out.push({
            type: 'tool_result',
            tool_use_id: b.callId,
            content: b.content,
            ...(b.isError ? { is_error: true } : {}),
          });
        }
    for (const b of m.blocks) {
      if (b.type === 'text' && b.text.length > 0) out.push(text(b));
      else if (b.type === 'tool_call') {
        if (m.role !== 'assistant' || !WIRE_TOOL_ID.test(b.id))
          throw new ModelAdapterError(
            'invalid_request',
            'a tool call is misplaced or has an invalid id',
            false,
          );
        out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.args ?? {} });
      } else if (b.type === 'tool_result' && m.role !== 'user')
        throw new ModelAdapterError(
          'invalid_request',
          'a tool result must be in a user message',
          false,
        );
    }
    if (out.length === 0)
      throw new ModelAdapterError('invalid_request', 'a message has no content', false);
    return out;
  }

  /** The API refuses a conversation in which a tool call is not answered by a result in the very next message, or a result has no call: caught here, before a billed call. */
  private assertToolHistory(messages: ModelMessage[]): void {
    const turns = messages.filter((m) => m.role !== 'system');
    for (let i = 0; i < turns.length; i++) {
      const m = turns[i]!;
      const calls = (m.blocks ?? [])
        .filter((b) => b.type === 'tool_call')
        .map((b) => (b as { id: string }).id);
      const results = (m.blocks ?? [])
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

  private response(model: string, msg: ClaudeMessage, req?: CompleteRequest): CompleteResponse {
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const usage: Usage = {
      inputTokens:
        msg.usage.input_tokens +
        (msg.usage.cache_creation_input_tokens ?? 0) +
        (msg.usage.cache_read_input_tokens ?? 0),
      outputTokens: msg.usage.output_tokens,
    };
    let finishReason: CompleteResponse['finishReason'] =
      msg.stop_reason === 'max_tokens'
        ? 'length'
        : msg.stop_reason === 'refusal'
          ? 'refusal'
          : 'stop';
    if (!this.v11) return { text, finishReason, usage, model };

    // ---- contract 1.1: tool calls
    const used = msg.content.filter((b) => b.type === 'tool_use');
    const toolCalls: ToolCall[] = used.map((b) => ({
      id: String(b.id ?? ''),
      name: String(b.name ?? ''),
      args: b.input,
    }));
    if (msg.stop_reason === 'pause_turn')
      throw new ModelAdapterError(
        'invalid_response',
        'the provider paused the turn (a server tool): not supported',
        false,
      );
    if (msg.stop_reason === 'tool_use') finishReason = 'tool_calls';
    if (toolCalls.length === 0) {
      if (finishReason === 'tool_calls')
        throw new ModelAdapterError(
          'invalid_response',
          'the provider stopped for a tool call but sent none',
          false,
        );
      return { text, finishReason, usage, model };
    }
    if (finishReason !== 'tool_calls')
      // a call cut off by max_tokens would carry truncated arguments: never passed on
      throw new ModelAdapterError(
        'invalid_response',
        'the answer ended in the middle of a tool call',
        false,
      );
    // streamed calls were already assembled and validated chunk by chunk by the caller; a non-streamed response is validated here
    assertToolCalls(toolCalls, req?.tools, req ? allowedToolCalls(this.models()[0]!, req) : 1);
    return { text, finishReason, toolCalls, usage, model };
  }

  /** The SDK's typed errors, most specific first. The upstream message is never passed on (it could carry request details): only a fixed sentence and the HTTP status. */
  private mapError(e: unknown, signal?: AbortSignal): ModelAdapterError {
    if (e instanceof ModelAdapterError) return e;
    if (signal?.aborted || e instanceof Anthropic.APIUserAbortError)
      return new ModelAdapterError('aborted', ERR.aborted);
    if (e instanceof Anthropic.APIConnectionTimeoutError)
      return new ModelAdapterError('timeout', ERR.timeout);
    // the vendor's SPENDING limit is not a rate limit: it lifts only at the next billing month or when the owner raises it, so retrying (or falling back and coming back) is pointless
    if (isSpendLimitError(e)) return new ModelAdapterError('rate_limited', ERR.spend_limit, false);
    if (e instanceof Anthropic.RateLimitError)
      return new ModelAdapterError(
        'rate_limited',
        ERR.rate_limited,
        true,
        parseRetryAfterMs((e as { headers?: unknown }).headers),
      );
    if (e instanceof Anthropic.APIConnectionError)
      return new ModelAdapterError('unavailable', 'could not reach the model provider (network)');
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
      return new ModelAdapterError(
        'invalid_request',
        `the model provider rejected the key (HTTP ${e.status})`,
        false,
      );
    if (e instanceof Anthropic.APIError) {
      if (typeof e.status === 'number' && e.status >= 500)
        return new ModelAdapterError(
          'unavailable',
          `the model provider answered with an error (HTTP ${e.status})`,
          true,
          parseRetryAfterMs((e as { headers?: unknown }).headers),
        ); // includes 529 overloaded
      return new ModelAdapterError(
        'invalid_request',
        `the model provider rejected the request (HTTP ${e.status ?? 'unknown'})`,
        false,
      );
    }
    return new ModelAdapterError(
      'unavailable',
      `unexpected error in the model adapter (${e instanceof Error ? e.name : 'unknown'})`,
    );
  }
}

/**
 * The vendor documents two ways a spend limit shows up (read 2026-11-24, platform.claude.com/docs/en/api/rate-limits and manage-claude/workspaces): the tier cap answers HTTP 429
 * `rate_limit_error` with `details.error_code = "enforced_spend_limit_reached"` and no retry-after; an owner-set organization or workspace limit answers HTTP 400
 * `invalid_request_error` whose message starts "You have reached your specified". Only those documented shapes are recognised; anything else keeps its ordinary mapping.
 */
export function isSpendLimitError(e: unknown): boolean {
  const x = e as { status?: unknown; error?: unknown };
  const body = (x?.error ?? {}) as {
    error?: { message?: unknown; details?: { error_code?: unknown } };
  };
  if (x?.status === 429) return body.error?.details?.error_code === 'enforced_spend_limit_reached';
  if (x?.status === 400)
    return (
      typeof body.error?.message === 'string' &&
      /^You have reached your specified (workspace )?API usage limits/.test(body.error.message)
    );
  return false;
}
