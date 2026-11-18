/**
 * ModelAdapter contract (docs/09 §7). The gateway (apps/api `ai` module) is the only caller: it enforces residency (D-18), the data-terms check, the budget
 * reservation and the secret scan BEFORE `complete`/`stream` is reached. An adapter never decides policy; it declares facts and performs calls.
 *
 * Nothing here asserts what a real provider can do: capabilities, context sizes and prices of a real provider come from its official documentation and a probe.
 */
export type ModelCapability =
  'chat' | 'structured-output' | 'long-context' | 'embeddings' | 'vision';
export type ModelRole = 'system' | 'user' | 'assistant';
export interface ModelMessage {
  role: ModelRole;
  content: string;
}

export interface ModelInfo {
  modelId: string;
  capabilities: ModelCapability[];
  /** total context window in tokens (input + output) */
  contextTokens: number;
  maxOutputTokens: number;
  /** relative latency class used for routing only; not a promise */
  latencyClass: 'low' | 'medium' | 'high';
}

/**
 * Retention/training flags AS CONTRACTUALLY VERIFIED BY A HUMAN (HG-09-01). `attested=false` (the default) means the flags are unknown:
 * the gateway then treats the provider as "may retain and may train" and blocks `personal`/`customer-content` unless policy allows.
 */
export interface DataTerms {
  attested: boolean;
  /** reference to the signed attestation (docs/07), present only when `attested` */
  attestationRef?: string;
  retainsPrompts: boolean | 'unknown';
  trainsOnData: boolean | 'unknown';
  /** ISO country of processing, or a provider region id */
  processingRegion: string;
}

/** The provider's own price (our COST input) in decimal strings per million tokens: never floats. */
export interface ProviderPricing {
  currency: string;
  inputPerMillion: string;
  outputPerMillion: string;
}

export interface CallContext {
  /** stable id of this call: usage/metering dedupe on it */
  callId: string;
  traceId?: string;
  signal?: AbortSignal;
}

export interface CompleteRequest {
  model: string;
  messages: ModelMessage[];
  maxTokens: number;
  temperature?: number;
  /** ask for JSON output; the gateway's caller still validates against a schema */
  responseFormat?: 'text' | 'json';
  /** a short task tag (requirements, architecture, page, edit, chat) used by scripted mocks and by metering dimensions; never sent as an instruction */
  task?: string;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
export interface CompleteResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'refusal';
  /** provider-reported counts; `null` when the provider did not report (the gateway then estimates and flags `estimated`) */
  usage: Usage | null;
  model: string;
}
export type StreamChunk =
  | { delta: string }
  | { done: true; finishReason: CompleteResponse['finishReason']; usage: Usage | null };

export type ModelErrorCode =
  'timeout' | 'rate_limited' | 'unavailable' | 'content_filtered' | 'invalid_request' | 'aborted';
export class ModelAdapterError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryable: boolean = code === 'timeout' ||
      code === 'rate_limited' ||
      code === 'unavailable',
  ) {
    super(message);
    this.name = 'ModelAdapterError';
  }
}

export interface ModelAdapter {
  readonly id: string;
  readonly kind: 'model';
  readonly contractVersion: string;
  /** where the provider processes the data (a country code or region id) */
  readonly region: string;
  readonly dataTerms: DataTerms;
  readonly pricing: ProviderPricing;
  models(): ModelInfo[];
  complete(ctx: CallContext, req: CompleteRequest): Promise<CompleteResponse>;
  stream(ctx: CallContext, req: CompleteRequest): AsyncIterable<StreamChunk>;
  embed?(
    ctx: CallContext,
    model: string,
    input: string[],
  ): Promise<{ vectors: number[][]; usage: Usage | null }>;
  /** local estimate (no network): used for pre-flight reservation and as the flagged fallback when usage is not reported */
  tokenCount(model: string, messages: ModelMessage[]): number;
}

export const MODEL_CONTRACT_VERSION = '1.0.0';

/** Deterministic token estimate used by the mock and as the gateway fallback: ceil(chars / 4) per message plus 4 framing tokens. */
export function estimateTokens(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) n += Math.ceil(m.content.length / 4) + 4;
  return n;
}
