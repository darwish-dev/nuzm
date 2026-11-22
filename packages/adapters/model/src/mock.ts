import { createHash } from 'node:crypto';
import {
  MODEL_CONTRACT_VERSION_1_1,
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
  type ToolCall,
  type Usage,
} from './types';
import { allowedToolCalls, assertToolCalls, assertToolRequest, parseToolArgs } from './tools';

export type ScriptHandler = (req: CompleteRequest, ctx: CallContext) => string | Promise<string>;

/**
 * What a scripted model does with a request that carries tools (contract 1.1). `calls[].args` is the parsed arguments; `rawArgs` is argument TEXT, which lets a test script a
 * malformed answer (the adapter must reject it as `invalid_response`; a stream carries the raw text to its consumer, whose assembler rejects it). A call to a tool that was not
 * declared simulates a faulty provider.
 */
export interface MockToolScript {
  text?: string;
  calls?: { name: string; args?: unknown; rawArgs?: string; id?: string }[];
}
export type ToolScriptHandler = (
  req: CompleteRequest,
  ctx: CallContext,
) => MockToolScript | Promise<MockToolScript>;

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
  /** contract 1.1: the scripted answer to a request with tools; without it a tool request is answered with the text handler and no calls */
  toolHandler?: ToolScriptHandler;
  /** a pause before every streamed chunk (ms): lets a test cancel in the middle of a stream */
  chunkDelayMs?: number;
}

export const MOCK_MODEL_ID = 'mock-chat-1';
/** Models that declare the contract-1.1 capabilities, for tests of tool calling. They are NOT in the default list, so every existing consumer of the mock sees the same two models. */
export const MOCK_TOOL_MODEL_ID = 'mock-tools-1';
export const MOCK_SERIAL_TOOL_MODEL_ID = 'mock-tools-serial-1';
export const MOCK_TOOL_MODELS: ModelInfo[] = [
  {
    modelId: MOCK_TOOL_MODEL_ID,
    capabilities: [
      'chat',
      'structured-output',
      'tool-use',
      'streaming-tool-calls',
      'parallel-tool-calls',
    ],
    contextTokens: 64_000,
    maxOutputTokens: 16_000,
    latencyClass: 'low',
  },
  {
    modelId: MOCK_SERIAL_TOOL_MODEL_ID,
    capabilities: ['chat', 'tool-use'],
    contextTokens: 64_000,
    maxOutputTokens: 16_000,
    latencyClass: 'medium',
  },
];
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
  /** the mock implements contract 1.1 (tool calling is scripted); it still serves every 1.0 request exactly as before */
  readonly contractVersion = MODEL_CONTRACT_VERSION_1_1;
  readonly id: string;
  readonly region: string;
  readonly dataTerms: DataTerms;
  readonly pricing: ProviderPricing;
  /** every call made, in order (for assertions) */
  readonly calls: { callId: string; req: CompleteRequest }[] = [];
  handler: ScriptHandler;
  reportUsage: boolean;
  delayMs = 0;
  chunkDelayMs: number;
  toolHandler: ToolScriptHandler | undefined;
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
    this.toolHandler = o.toolHandler;
    this.chunkDelayMs = o.chunkDelayMs ?? 0;
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
  /** The scripted answer, before it is shaped for `complete` or `stream`. Argument TEXT is kept raw so a stream can carry exactly what a faulty provider would send. */
  private async produce(
    ctx: CallContext,
    req: CompleteRequest,
  ): Promise<{
    text: string;
    calls: { id: string; name: string; argsText: string }[];
    finishReason: CompleteResponse['finishReason'];
    usage: Usage | null;
  }> {
    this.check(req);
    assertToolRequest(
      this,
      this.infos.find((m) => m.modelId === req.model),
      req,
    );
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', 'aborted', false);
    this.calls.push({ callId: ctx.callId, req });
    const fault = this.faults.shift();
    if (fault) throw fault;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', 'aborted', false);
    const model = this.infos.find((m) => m.modelId === req.model)!;
    let text: string;
    let calls: { id: string; name: string; argsText: string }[] = [];
    if (req.tools && this.toolHandler && req.toolChoice !== 'none') {
      const script = await this.toolHandler(req, ctx);
      text = script.text ?? '';
      calls = (script.calls ?? []).slice(0, allowedToolCalls(model, req)).map((c, i) => ({
        id: c.id ?? `call_${ctx.callId.replace(/[^A-Za-z0-9_-]/g, '_')}_${i}`,
        name: c.name,
        argsText: c.rawArgs ?? JSON.stringify(c.args ?? {}),
      }));
    } else text = await this.handler(req, ctx);
    const inTok =
      this.tokenCount(req.model, req.messages) +
      (req.tools ? Math.ceil(JSON.stringify(req.tools).length / 4) : 0);
    let outTok = Math.ceil(
      (text.length + calls.reduce((n, c) => n + c.name.length + c.argsText.length, 0)) / 4,
    );
    let finishReason: CompleteResponse['finishReason'] = calls.length ? 'tool_calls' : 'stop';
    if (outTok > req.maxTokens) {
      // a response cut at the ceiling cannot carry a complete tool call: the calls are dropped, as a provider's truncated arguments would be unusable
      text = text.slice(0, req.maxTokens * 4);
      calls = [];
      outTok = req.maxTokens;
      finishReason = 'length';
    }
    const usage: Usage | null = this.reportUsage
      ? { inputTokens: inTok, outputTokens: outTok }
      : null;
    return { text, calls, finishReason, usage };
  }
  async complete(ctx: CallContext, req: CompleteRequest): Promise<CompleteResponse> {
    const p = await this.produce(ctx, req);
    const toolCalls: ToolCall[] = p.calls.map((c) => ({
      id: c.id,
      name: c.name,
      args: parseToolArgs(c.argsText, c.name),
    }));
    const model = this.infos.find((m) => m.modelId === req.model)!;
    assertToolCalls(toolCalls, req.tools, allowedToolCalls(model, req));
    return {
      text: p.text,
      finishReason: p.finishReason,
      usage: p.usage,
      model: req.model,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
  async *stream(ctx: CallContext, req: CompleteRequest): AsyncIterable<StreamChunk> {
    const p = await this.produce(ctx, req);
    const pause = async () => {
      if (this.chunkDelayMs > 0) await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', 'aborted', false);
    };
    for (let i = 0; i < p.text.length; i += 16) {
      await pause();
      yield { delta: p.text.slice(i, i + 16) };
    }
    for (const [index, c] of p.calls.entries()) {
      for (let k = 0; k === 0 || k < c.argsText.length; k += 8) {
        await pause();
        yield {
          toolCallDelta: {
            index,
            ...(k === 0 ? { id: c.id, name: c.name } : {}),
            argsDelta: c.argsText.slice(k, k + 8),
          },
        };
        if (c.argsText.length === 0) break;
      }
      yield { toolCallDone: { index } };
    }
    await pause();
    yield { done: true, finishReason: p.finishReason, usage: p.usage };
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

/**
 * Scenario driver for the conformance kit (`runModelConformance(make, { tools: { arrange: mockToolArrange } })`): makes the scripted mock behave as each tool scenario requires.
 * Scripted behaviour proves the CONTRACT shape only; it says nothing about any real model.
 */
export function mockToolArrange(
  adapter: unknown,
  scenario: 'single' | 'parallel' | 'none' | 'malformed' | 'undeclared' | 'long',
): void {
  const a = adapter as MockModelAdapter;
  a.toolHandler = (req) => {
    switch (scenario) {
      case 'none':
        return { text: 'no tool needed' };
      case 'single':
        return { calls: [{ name: 'echo', args: { text: 'hi' } }] };
      case 'parallel':
        return {
          calls: [
            { name: 'echo', args: { text: 'a' } },
            { name: 'lookup', args: { key: 'k' } },
          ],
        };
      case 'malformed':
        return { calls: [{ name: 'echo', rawArgs: '{"text": "unterminated' }] };
      case 'undeclared':
        return { calls: [{ name: 'delete_everything', args: {} }] };
      case 'long':
        return {
          text: 'x'.repeat(400),
          calls: [{ name: 'echo', args: { text: 'y'.repeat(400) } }],
        };
    }
    return { text: String(req.task ?? '') };
  };
}
