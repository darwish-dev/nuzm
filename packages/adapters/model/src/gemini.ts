import { createHash } from 'node:crypto';
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
} from './types';
import { allowedToolCalls, assertToolCalls, assertToolRequest } from './tools';
import {
  ADAPTER_TIMEOUT_MS,
  errorFromResponse,
  linkSignal,
  mapTransportError,
  readJsonBody,
  readSse,
  type FetchLike,
} from './http-transport';

/**
 * Google Gemini (Developer API, `generateContent`) behind the `ModelAdapter` contract. STATUS: IMPLEMENTED BEHIND D11, NEVER EXERCISED LIVE. Written from the vendor's official
 * documentation read on 2026-11-24 (docs/adapters/gemini.md: every page, every field relied on, and every statement that stayed NOT FOUND). It is not registered anywhere, holds
 * no key, and refuses every call unless the owner's live gate (`liveEnabled`) lists it.
 *
 * What the documentation read does NOT settle is declared as unsupported rather than guessed: parallel function calls and streamed function calls (no statement for generateContent),
 * so the model declares `tool-use` only; the streaming framing is read as SSE (`alt=sse`) and the role of a function-result turn is `user` (the only roles documented are user and
 * model). Every one of these is a probe obligation before any capability counts (D8).
 */
export const GEMINI_PROVIDER_ID = 'gemini';
/** The stable model declared; limits and list price: docs/adapters/gemini.md §8 (read 2026-11-24). */
export const GEMINI_MODEL_ID = 'gemini-3.8-flash';

const BASE_CAPABILITIES: ModelInfo['capabilities'] = ['chat', 'structured-output', 'long-context'];
const modelsFor = (v11: boolean): ModelInfo[] => [
  {
    modelId: GEMINI_MODEL_ID,
    capabilities: v11 ? [...BASE_CAPABILITIES, 'tool-use'] : [...BASE_CAPABILITIES],
    contextTokens: 1_048_576,
    maxOutputTokens: 65_536,
    latencyClass: 'low',
  },
];
/**
 * List price, USD per million tokens, paid tier, standard. The vendor documents a CHANGE on 2027-01-01 (to 1.50 / 7.50): this adapter must be re-read before then
 * (`GEMINI_PRICING_VALID_UNTIL`); `pricingStale` lets a caller refuse or warn.
 */
const PRICING: ProviderPricing = {
  currency: 'USD',
  inputPerMillion: '0.75',
  outputPerMillion: '3.75',
};
export const GEMINI_PRICING_VALID_UNTIL = '2026-12-31';
export const geminiPricingStale = (now: Date = new Date()): boolean =>
  now.toISOString().slice(0, 10) > GEMINI_PRICING_VALID_UNTIL;

const TOKENIZER_MARGIN = 1.25; // OUR assumption (the vendor states none): keeps a pre-flight reservation from being too low
const BASE_URL = 'https://generativelanguage.googleapis.com';
const API_VERSION = 'v1beta'; // every documented example for these methods uses v1beta
const JSON_ONLY =
  'Reply with exactly one JSON value and nothing else: no code fences and no commentary.';
const FAIL_FINISH = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'MISSING_THOUGHT_SIGNATURE',
  'MALFORMED_RESPONSE',
]);
const REFUSE_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'OTHER',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

export interface GeminiAdapterOptions {
  getApiKey: () => Promise<string | null>;
  region?: string;
  fetchImpl?: FetchLike;
  contract?: '1.0' | '1.1';
  liveEnabled?: () => boolean;
  timeoutMs?: number;
}
type Wire = Record<string, unknown>;
const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
};
interface Part {
  text?: string;
  functionCall?: { name?: string; args?: unknown; id?: string };
}
interface GenResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Wire;
}

export class GeminiModelAdapter implements ModelAdapter {
  readonly kind = 'model' as const;
  readonly contractVersion: string;
  readonly id = GEMINI_PROVIDER_ID;
  readonly region: string;
  readonly dataTerms: DataTerms;
  readonly pricing = PRICING;
  private readonly v11: boolean;
  private readonly f: FetchLike;

  constructor(private readonly o: GeminiAdapterOptions) {
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

  /** `GET /v1beta/models` (read-only, nothing billed). The list is of resource names (`models/{id}`); one bounded page. NOT live-verified. */
  async discoverModels(ctx: CallContext): Promise<DiscoveredModel[]> {
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', 'the call was aborted');
    this.assertLive();
    const key = await this.key();
    const l = linkSignal(ctx.signal, this.o.timeoutMs ?? ADAPTER_TIMEOUT_MS);
    try {
      const res = await this.f(`${BASE_URL}/${API_VERSION}/models?pageSize=100`, {
        method: 'GET',
        headers: this.headers(key),
        signal: l.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      const body = await readJsonBody(res);
      const out: DiscoveredModel[] = [];
      for (const m of (Array.isArray(body.models) ? (body.models as unknown[]) : []).slice(
        0,
        100,
      )) {
        const x = m as { name?: unknown; displayName?: unknown };
        const id = typeof x?.name === 'string' ? x.name.replace(/^models\//, '') : '';
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) continue;
        out.push({
          modelId: id,
          ...(typeof x.displayName === 'string'
            ? { displayName: x.displayName.slice(0, 120) }
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
    const body = this.body(ctx, req);
    this.assertLive();
    const key = await this.key();
    const l = linkSignal(ctx.signal, this.o.timeoutMs ?? ADAPTER_TIMEOUT_MS);
    try {
      const res = await this.f(`${BASE_URL}/${API_VERSION}/models/${req.model}:generateContent`, {
        method: 'POST',
        headers: this.headers(key),
        body: JSON.stringify(body),
        signal: l.signal,
      });
      if (!res.ok) throw await errorFromResponse(res);
      return this.response(req, (await readJsonBody(res)) as GenResponse);
    } catch (e) {
      throw mapTransportError(e, l, ctx.signal);
    } finally {
      l.dispose();
    }
  }

  /**
   * Streaming (`streamGenerateContent?alt=sse`). The documentation read does not describe the framing or where the usage appears: this reads SSE `data:` events, each a whole
   * response object, takes text from every chunk, and the usage from the LAST chunk that carries `usageMetadata`. A function call is read whole from the chunk that carries it.
   * NOT VERIFIED against the real service.
   */
  async *stream(ctx: CallContext, req: CompleteRequest): AsyncGenerator<StreamChunk> {
    const body = this.body(ctx, req);
    this.assertLive();
    const key = await this.key();
    const l = linkSignal(ctx.signal, this.o.timeoutMs ?? ADAPTER_TIMEOUT_MS);
    try {
      const res = await this.f(
        `${BASE_URL}/${API_VERSION}/models/${req.model}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: this.headers(key),
          body: JSON.stringify(body),
          signal: l.signal,
        },
      );
      if (!res.ok) throw await errorFromResponse(res);
      let usage: Usage | null = null;
      let finish: string | undefined;
      let blocked: string | undefined;
      let n = 0;
      for await (const data of readSse(res)) {
        let chunk: GenResponse;
        try {
          chunk = JSON.parse(data) as GenResponse;
        } catch {
          throw new ModelAdapterError(
            'invalid_response',
            'a stream chunk is not valid JSON',
            false,
          );
        }
        if (chunk.usageMetadata) usage = this.usage(chunk.usageMetadata) ?? usage;
        if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
        const cand = chunk.candidates?.[0];
        if (cand?.finishReason) finish = cand.finishReason;
        for (const p of cand?.content?.parts ?? []) {
          if (typeof p.text === 'string' && p.text) yield { delta: p.text };
          else if (this.v11 && p.functionCall) {
            const idx = n++;
            const c = this.call(p.functionCall, idx);
            yield { toolCallDelta: { index: idx, id: c.id, name: c.name } };
            yield { toolCallDelta: { index: idx, argsDelta: safeJson(c.args) } };
            yield { toolCallDone: { index: idx } };
          }
        }
      }
      if (finish === undefined && blocked === undefined)
        throw new ModelAdapterError(
          'unavailable',
          'the provider stream ended before it finished',
          true,
        );
      yield { done: true, finishReason: this.finishReason(finish, blocked, n > 0), usage };
    } catch (e) {
      throw mapTransportError(e, l, ctx.signal);
    } finally {
      l.dispose();
    }
  }

  // ---- internals --------------------------------------------------------------------------------------------------------------------------------------------

  private assertLive(): void {
    if (this.o.liveEnabled && !this.o.liveEnabled())
      throw new ModelAdapterError(
        'unavailable',
        'live calls to this model provider are not approved in this environment',
        false,
      );
  }
  private async key(): Promise<string> {
    const key = await this.o.getApiKey().catch(() => null);
    if (!key)
      throw new ModelAdapterError('unavailable', 'no API key is stored for this provider', false);
    return key;
  }
  /** The key travels in the documented `x-goog-api-key` HEADER, never in the URL (a query string ends up in logs). */
  private headers(key: string): Record<string, string> {
    return { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
  }

  private usage(u: Wire): Usage | null {
    const p = u.promptTokenCount;
    const c = u.candidatesTokenCount;
    if (typeof p !== 'number') return null;
    const tool = typeof u.toolUsePromptTokenCount === 'number' ? u.toolUsePromptTokenCount : 0;
    // thinking tokens are billed as output ("Output price (including thinking tokens)")
    const think = typeof u.thoughtsTokenCount === 'number' ? u.thoughtsTokenCount : 0;
    const out = (typeof c === 'number' ? c : 0) + think;
    if (!Number.isFinite(p + tool + out)) return null;
    return { inputTokens: p + tool, outputTokens: out };
  }

  /** The documentation says a function call's `id` is optional: when absent one is derived (stable for the same call), so the neutral contract always has a unique id. */
  private call(fc: NonNullable<Part['functionCall']>, index: number): ToolCall {
    const name = String(fc.name ?? '');
    const id =
      typeof fc.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(fc.id)
        ? fc.id
        : `gc${index}_${createHash('sha256')
            .update(`${name}|${safeJson(fc.args ?? {})}`)
            .digest('hex')
            .slice(0, 12)}`;
    return { id, name, args: fc.args ?? {} };
  }

  private finishReason(
    v: string | undefined,
    blocked: string | undefined,
    hasCalls: boolean,
  ): CompleteResponse['finishReason'] {
    if (v === undefined) {
      if (blocked) return 'refusal'; // no candidate: the PROMPT was blocked
      throw new ModelAdapterError(
        'invalid_response',
        'the provider answer has no finish reason',
        false,
      );
    }
    if (FAIL_FINISH.has(v))
      throw new ModelAdapterError(
        'invalid_response',
        'the provider could not produce a valid answer',
        false,
      );
    if (REFUSE_FINISH.has(v)) return 'refusal';
    if (v === 'MAX_TOKENS') return 'length';
    if (v === 'STOP') return hasCalls ? 'tool_calls' : 'stop';
    throw new ModelAdapterError(
      'invalid_response',
      'the provider sent an unknown finish reason',
      false,
    );
  }

  private body(ctx: CallContext, req: CompleteRequest): Wire {
    if (ctx.signal?.aborted) throw new ModelAdapterError('aborted', 'the call was aborted');
    const model = this.models().find((m) => m.modelId === req.model);
    if (!model) throw new ModelAdapterError('invalid_request', `unknown model ${req.model}`, false);
    assertToolRequest(this, model, req);
    const withTools = this.v11 && !!req.tools?.length;
    const system: string[] = [];
    const contents: { role: 'user' | 'model'; parts: Wire[] }[] = [];
    // the function name of each call id seen so far: a result part must name its function
    const names = new Map<string, string>();
    for (const m of req.messages) {
      if (m.role === 'system') {
        system.push(m.content);
        continue;
      }
      for (const b of m.blocks ?? []) if (b.type === 'tool_call') names.set(b.id, b.name);
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: this.parts(m, withTools, names),
      });
    }
    if (contents.length === 0 || contents[0]!.role !== 'user')
      throw new ModelAdapterError(
        'invalid_request',
        'a conversation must start with a user message',
        false,
      );
    if (withTools) this.assertToolHistory(req.messages);
    if (req.responseFormat === 'json') system.push(JSON_ONLY);
    const limit = withTools ? allowedToolCalls(model, req) : 1;
    void limit; // parallel calls are not declared for this model: at most one call per response is accepted below
    return {
      contents,
      ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens, // a hard ceiling
        ...(req.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
      },
      ...(withTools
        ? {
            tools: [
              {
                functionDeclarations: req.tools!.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.inputSchema,
                })),
              },
            ],
            toolConfig: { functionCallingConfig: this.toolMode(req) },
          }
        : {}),
    };
  }

  private toolMode(req: CompleteRequest): Wire {
    const c = req.toolChoice ?? 'auto';
    if (c === 'none') return { mode: 'NONE' };
    if (c === 'auto') return { mode: 'AUTO' };
    return { mode: 'ANY', allowedFunctionNames: [c.name] };
  }

  private parts(m: ModelMessage, withTools: boolean, names: Map<string, string>): Wire[] {
    if (!m.blocks) return [{ text: m.content.length ? m.content : ' ' }];
    if (!withTools) {
      const t = m.blocks
        .map((b) =>
          b.type === 'text'
            ? b.text
            : b.type === 'tool_call'
              ? `[tool call ${b.name}: ${safeJson(b.args)}]`
              : `[tool result${b.isError ? ' (error)' : ''}]\n${b.content}`,
        )
        .filter((x) => x.length > 0)
        .join('\n\n');
      return [{ text: t || ' ' }];
    }
    const out: Wire[] = [];
    for (const b of m.blocks) {
      if (b.type === 'text') {
        if (b.text.length) out.push({ text: b.text });
      } else if (b.type === 'tool_call') {
        if (m.role !== 'assistant')
          throw new ModelAdapterError(
            'invalid_request',
            'a tool call must be in an assistant message',
            false,
          );
        out.push({ functionCall: { name: b.name, args: b.args ?? {}, id: b.id } });
      } else {
        if (m.role !== 'user')
          throw new ModelAdapterError(
            'invalid_request',
            'a tool result must be in a user message',
            false,
          );
        const name = names.get(b.callId);
        if (!name)
          throw new ModelAdapterError(
            'invalid_request',
            'a tool result does not answer a known call',
            false,
          );
        // documented: the response is an object, and "can have an 'error' key" when the function failed
        out.push({
          functionResponse: {
            name,
            id: b.callId,
            response: b.isError ? { error: b.content } : { output: b.content },
          },
        });
      }
    }
    if (out.length === 0)
      throw new ModelAdapterError('invalid_request', 'a message has no content', false);
    return out;
  }

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

  private response(req: CompleteRequest, body: GenResponse): CompleteResponse {
    const usage = body.usageMetadata ? this.usage(body.usageMetadata) : null;
    const cand = body.candidates?.[0];
    const blocked = body.promptFeedback?.blockReason;
    if (!cand) {
      if (blocked) return { text: '', finishReason: 'refusal', usage, model: req.model };
      throw new ModelAdapterError(
        'invalid_response',
        'the provider answer has no candidate',
        false,
      );
    }
    const parts = cand.content?.parts ?? [];
    const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
    const calls = parts.filter((p) => p.functionCall).map((p, i) => this.call(p.functionCall!, i));
    const finishReason = this.finishReason(cand.finishReason, blocked, calls.length > 0);
    if (!this.v11 || calls.length === 0) {
      if (finishReason === 'tool_calls')
        throw new ModelAdapterError(
          'invalid_response',
          'the provider stopped for a tool call but sent none',
          false,
        );
      return { text, finishReason, usage, model: req.model };
    }
    if (finishReason !== 'tool_calls')
      throw new ModelAdapterError(
        'invalid_response',
        'the answer ended in the middle of a tool call',
        false,
      );
    // one call per response: parallel calls are not declared for this model (the documentation read does not state them for generateContent)
    assertToolCalls(calls, req.tools, 1);
    return { text, finishReason, toolCalls: calls, usage, model: req.model };
  }
}
