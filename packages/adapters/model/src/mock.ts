import { createHash } from 'node:crypto';
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

export type ScriptHandler = (req: CompleteRequest, ctx: CallContext) => string | Promise<string>;

export interface MockModelOptions {
  id?: string;
  region?: string;
  dataTerms?: Partial<DataTerms>;
  pricing?: Partial<ProviderPricing>;
  models?: ModelInfo[];
  /** scripted output; default echoes a tiny deterministic JSON/text so plumbing tests run */
  handler?: ScriptHandler;
  /** when false the mock reports no usage (exercises the estimated-token fallback) */
  reportUsage?: boolean;
}

export const MOCK_MODEL_ID = 'mock-chat-1';
const DEFAULT_MODELS: ModelInfo[] = [
  {
    modelId: MOCK_MODEL_ID,
    capabilities: ['chat', 'structured-output'],
    contextTokens: 32_000,
    maxOutputTokens: 8_000,
    latencyClass: 'low',
  },
  {
    modelId: 'mock-long-1',
    capabilities: ['chat', 'structured-output', 'long-context'],
    contextTokens: 200_000,
    maxOutputTokens: 16_000,
    latencyClass: 'high',
  },
];

/**
 * Deterministic scripted model for PLUMBING tests only (CLAUDE.md §5: mock output is never evidence of model quality; quality rows stay BLOCKED).
 * Fault injection: `failNext(error, times)`, `delayMs`, `reportUsage=false`, `outputTokens` override via the handler's text length.
 */
export class MockModelAdapter implements ModelAdapter {
  readonly kind = 'model' as const;
  readonly contractVersion = MODEL_CONTRACT_VERSION;
  readonly id: string;
  readonly region: string;
  readonly dataTerms: DataTerms;
  readonly pricing: ProviderPricing;
  /** every call made, in order (for assertions) */
  readonly calls: { callId: string; req: CompleteRequest }[] = [];
  handler: ScriptHandler;
  reportUsage: boolean;
  delayMs = 0;
  private readonly infos: ModelInfo[];
  private faults: ModelAdapterError[] = [];

  constructor(o: MockModelOptions = {}) {
    this.id = o.id ?? 'mock-model';
    this.region = o.region ?? 'sa-central';
    this.dataTerms = {
      attested: false,
      retainsPrompts: 'unknown',
      trainsOnData: 'unknown',
      processingRegion: this.region,
      ...o.dataTerms,
    };
    this.pricing = { currency: 'USD', inputPerMillion: '0', outputPerMillion: '0', ...o.pricing };
    this.infos = o.models ?? DEFAULT_MODELS;
    this.handler = o.handler ?? defaultHandler;
    this.reportUsage = o.reportUsage ?? true;
  }
  models(): ModelInfo[] {
    return this.infos.map((m) => ({ ...m, capabilities: [...m.capabilities] }));
  }
  clearFaults() {
    this.faults = [];
  }
  failNext(error: ModelAdapterError, times = 1) {
    for (let i = 0; i < times; i++) this.faults.push(error);
  }
  tokenCount(_model: string, messages: ModelMessage[]): number {
    return estimateTokens(messages);
  }
  private check(req: CompleteRequest) {
    if (!this.infos.some((m) => m.modelId === req.model))
      throw new ModelAdapterError('invalid_request', `unknown model ${req.model}`, false);
    if (!Number.isInteger(req.maxTokens) || req.maxTokens < 1)
      throw new ModelAdapterError('invalid_request', 'maxTokens must be a positive integer', false);
  }
  private async run(ctx: CallContext, req: CompleteRequest): Promise<CompleteResponse> {
    this.check(req);
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', 'aborted', false);
    this.calls.push({ callId: ctx.callId, req });
    const fault = this.faults.shift();
    if (fault) throw fault;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', 'aborted', false);
    let text = await this.handler(req, ctx);
    const inTok = this.tokenCount(req.model, req.messages);
    let outTok = Math.ceil(text.length / 4);
    let finishReason: CompleteResponse['finishReason'] = 'stop';
    if (outTok > req.maxTokens) {
      text = text.slice(0, req.maxTokens * 4);
      outTok = req.maxTokens;
      finishReason = 'length';
    }
    const usage: Usage | null = this.reportUsage
      ? { inputTokens: inTok, outputTokens: outTok }
      : null;
    return { text, finishReason, usage, model: req.model };
  }
  complete(ctx: CallContext, req: CompleteRequest): Promise<CompleteResponse> {
    return this.run(ctx, req);
  }
  async *stream(ctx: CallContext, req: CompleteRequest): AsyncIterable<StreamChunk> {
    const r = await this.run(ctx, req);
    for (let i = 0; i < r.text.length; i += 16) yield { delta: r.text.slice(i, i + 16) };
    yield { done: true, finishReason: r.finishReason, usage: r.usage };
  }
}

const defaultHandler: ScriptHandler = (req) =>
  req.responseFormat === 'json' ? '{"ok":true}' : `mock reply (${req.task ?? 'chat'})`;

/** Canonical key of a request for record/replay fixtures. */
export function fixtureKey(req: CompleteRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        m: req.model,
        msgs: req.messages,
        t: req.temperature ?? null,
        f: req.responseFormat ?? 'text',
        k: req.task ?? '',
      }),
    )
    .digest('hex');
}
export type FixtureStore = Record<string, string>;

/** Records the text answers of an inner handler into `store` (JSON-serialisable) so a later run can replay them with no model. */
export function recordingHandler(inner: ScriptHandler, store: FixtureStore): ScriptHandler {
  return async (req, ctx) => {
    const text = await inner(req, ctx);
    store[fixtureKey(req)] = text;
    return text;
  };
}
/** Replays recorded answers; an unknown request is an error (a replay never falls back to a live model). */
export function replayHandler(store: FixtureStore): ScriptHandler {
  return (req) => {
    const hit = store[fixtureKey(req)];
    if (hit === undefined)
      throw new ModelAdapterError('invalid_request', 'no recorded fixture for this request', false);
    return hit;
  };
}
