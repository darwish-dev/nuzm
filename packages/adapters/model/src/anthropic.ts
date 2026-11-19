import Anthropic from '@anthropic-ai/sdk';
import {
  MODEL_CONTRACT_VERSION,
  ModelAdapterError,
  estimateTokens,
  type CallContext,
  type CompleteRequest,
  type CompleteResponse,
  type DataTerms,
  type ModelAdapter,
  type ModelInfo,
  type ModelMessage,
  type ProviderPricing,
  type StreamChunk,
  type Usage,
} from './types';

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

const MODELS: ModelInfo[] = [
  {
    modelId: CLAUDE_MODEL_ID,
    capabilities: ['chat', 'structured-output', 'long-context'],
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

/** The ONE host this adapter talks to: fixed in code, never from the environment, a request or the database. */
const BASE_URL = 'https://api.anthropic.com';
const SDK_TIMEOUT_MS = 120_000; // a backstop: the gateway aborts a call on its own, shorter, timer

/** What the adapter needs of the SDK client: small on purpose, so a test can supply a deterministic one. */
export interface ClaudeMessage {
  content: { type: string; text?: string }[];
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
  delta?: { type?: string; text?: string };
}
export interface ClaudeClient {
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
}

const JSON_ONLY =
  'Reply with exactly one JSON value and nothing else: no code fences and no commentary.';
const ERR = {
  timeout: 'the model did not answer in time',
  rate_limited: 'the model provider is limiting requests',
  unavailable: 'the model provider is unavailable',
  content_filtered: 'the model provider declined the request',
  invalid_request: 'the model provider rejected the request',
  aborted: 'the call was aborted',
} as const;

export class AnthropicModelAdapter implements ModelAdapter {
  readonly kind = 'model' as const;
  readonly contractVersion = MODEL_CONTRACT_VERSION;
  readonly id = CLAUDE_PROVIDER_ID;
  readonly region: string;
  readonly dataTerms: DataTerms;
  readonly pricing = PRICING;
  private cached: { key: string; client: ClaudeClient } | null = null;

  constructor(private readonly o: AnthropicAdapterOptions) {
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
    return MODELS.map((m) => ({ ...m, capabilities: [...m.capabilities] }));
  }

  tokenCount(_model: string, messages: ModelMessage[]): number {
    return estimateTokens(messages); // a local estimate; the provider's own count is used whenever it reports one
  }

  async complete(ctx: CallContext, req: CompleteRequest): Promise<CompleteResponse> {
    const params = this.params(ctx, req);
    const client = await this.client();
    try {
      const msg = await client.messages.create(params, { signal: ctx.signal });
      return this.response(req.model, msg);
    } catch (e) {
      throw this.mapError(e, ctx.signal);
    }
  }

  async *stream(ctx: CallContext, req: CompleteRequest): AsyncGenerator<StreamChunk> {
    const params = this.params(ctx, req);
    const client = await this.client();
    try {
      const s = client.messages.stream(params, { signal: ctx.signal });
      for await (const ev of s) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text)
          yield { delta: ev.delta.text };
      }
      const r = this.response(req.model, await s.finalMessage());
      yield { done: true, finishReason: r.finishReason, usage: r.usage };
    } catch (e) {
      throw this.mapError(e, ctx.signal);
    }
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------------------------------------

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
    if (!MODELS.some((m) => m.modelId === req.model))
      throw new ModelAdapterError('invalid_request', `unknown model ${req.model}`, false);
    const system: string[] = [];
    const messages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') system.push(m.content);
      else messages.push({ role: m.role, content: m.content });
    }
    if (messages.length === 0 || messages[0]!.role !== 'user')
      throw new ModelAdapterError(
        'invalid_request',
        'a conversation must start with a user message',
        false,
      );
    if (req.responseFormat === 'json') system.push(JSON_ONLY);
    return {
      model: req.model,
      max_tokens: req.maxTokens, // a hard ceiling
      ...(system.length ? { system: system.join('\n\n') } : {}),
      messages,
      output_config: { effort: 'medium' },
    };
  }

  private response(model: string, msg: ClaudeMessage): CompleteResponse {
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
    const finishReason =
      msg.stop_reason === 'max_tokens'
        ? 'length'
        : msg.stop_reason === 'refusal'
          ? 'refusal'
          : 'stop';
    return { text, finishReason, usage, model };
  }

  /** The SDK's typed errors, most specific first. The upstream message is never passed on (it could carry request details). */
  private mapError(e: unknown, signal?: AbortSignal): ModelAdapterError {
    if (e instanceof ModelAdapterError) return e;
    if (signal?.aborted || e instanceof Anthropic.APIUserAbortError)
      return new ModelAdapterError('aborted', ERR.aborted);
    if (e instanceof Anthropic.APIConnectionTimeoutError)
      return new ModelAdapterError('timeout', ERR.timeout);
    if (e instanceof Anthropic.RateLimitError)
      return new ModelAdapterError('rate_limited', ERR.rate_limited);
    if (e instanceof Anthropic.APIConnectionError)
      return new ModelAdapterError('unavailable', ERR.unavailable);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
      return new ModelAdapterError('invalid_request', ERR.invalid_request, false);
    if (e instanceof Anthropic.APIError) {
      if (typeof e.status === 'number' && e.status >= 500)
        return new ModelAdapterError('unavailable', ERR.unavailable); // includes 529 overloaded
      return new ModelAdapterError('invalid_request', ERR.invalid_request, false);
    }
    return new ModelAdapterError('unavailable', ERR.unavailable);
  }
}
