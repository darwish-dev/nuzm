/**
 * ModelAdapter contract (docs/09 §7). The gateway (apps/api `ai` module) is the only caller: it enforces residency (D-18), the data-terms check, the budget
 * reservation and the secret scan BEFORE `complete`/`stream` is reached. An adapter never decides policy; it declares facts and performs calls.
 *
 * Nothing here asserts what a real provider can do: capabilities, context sizes and prices of a real provider come from its official documentation and a probe.
 */
export type ModelCapability =
  | 'chat'
  | 'structured-output'
  | 'long-context'
  | 'embeddings'
  | 'vision'
  // contract 1.1 (D-46, ADR-066): declared per model from official documentation and a probe; unknown = unsupported
  | 'tool-use'
  | 'streaming-tool-calls'
  | 'parallel-tool-calls';
/** The capabilities that exist only from contract 1.1: an adapter on 1.0 must not declare them, and the gateway ignores them from an adapter that does. */
export const V1_1_CAPABILITIES: readonly ModelCapability[] = [
  'tool-use',
  'streaming-tool-calls',
  'parallel-tool-calls',
];
export type ModelRole = 'system' | 'user' | 'assistant';

/**
 * Neutral content blocks (contract 1.1). A provider adapter renders them into its own wire format; no provider-specific shape ever leaves an adapter.
 * A tool RESULT is a block of a `user` message (the provider formats differ: adapters map it); a tool CALL is a block of an `assistant` message.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean };
export interface ModelMessage {
  role: ModelRole;
  /** the text of the message; with `blocks` it is the concatenated text of the text blocks (or empty) and is what 1.0 callers read */
  content: string;
  /** contract 1.1: structured content (text, tool calls, tool results). Absent for every 1.0 caller. */
  blocks?: ContentBlock[];
}

/** A tool the model may call. `inputSchema` is a JSON Schema OBJECT (the subset of `@nuzm/domain`): validated by the gateway, never trusted. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export type ToolChoice = 'auto' | 'none' | { name: string };
export interface ToolCall {
  /** unique within the response; the matching `tool_result` block refers to it */
  id: string;
  name: string;
  /** the parsed arguments: always a JSON value the adapter parsed itself; a malformed argument string is an `invalid_response` error, never passed on */
  args: unknown;
}
export const TOOL_LIMITS = {
  maxTools: 32,
  nameMax: 64,
  descriptionMax: 1_024,
  schemaMaxBytes: 8_192,
  maxToolCallsPerResponse: 16,
  argsMaxBytes: 65_536,
} as const;
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

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

/** What a provider's model-listing endpoint reports: an id and display metadata, nothing the platform may trust for limits, prices or capabilities. */
export interface DiscoveredModel {
  modelId: string;
  displayName?: string;
  createdAt?: string;
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
  /** contract 1.1: tools the model may call. Only for a model that declares `tool-use`; otherwise the adapter throws `unsupported_capability`. */
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  /** contract 1.1: at most this many calls in one response (default 1 unless the model declares `parallel-tool-calls`) */
  maxToolCalls?: number;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
export interface CompleteResponse {
  text: string;
  /** `tool_calls` (contract 1.1): the model stopped to ask for tool results; `toolCalls` is non-empty */
  finishReason: 'stop' | 'length' | 'refusal' | 'tool_calls';
  /** contract 1.1: validated shape only (names are the declared tools', arguments parsed); the GATEWAY validates the arguments against each schema */
  toolCalls?: ToolCall[];
  /** provider-reported counts; `null` when the provider did not report (the gateway then estimates and flags `estimated`) */
  usage: Usage | null;
  model: string;
}
export type StreamChunk =
  | { delta: string }
  /** contract 1.1: a piece of one tool call. `id` and `name` arrive with the first piece of a call; `argsDelta` is a fragment of the JSON text of the arguments. */
  | { toolCallDelta: { index: number; id?: string; name?: string; argsDelta?: string } }
  /** contract 1.1: the call at `index` is complete (its arguments text is complete JSON) */
  | { toolCallDone: { index: number } }
  | { done: true; finishReason: CompleteResponse['finishReason']; usage: Usage | null };

export type ModelErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'content_filtered'
  | 'invalid_request'
  | 'aborted'
  // contract 1.1: the provider answered, but not with something this contract can carry (malformed tool arguments, an undeclared tool, a call over the limits)
  | 'invalid_response'
  // contract 1.1: the request asked for a capability the model does not declare (tools, streamed tool calls, parallel calls)
  | 'unsupported_capability';
export class ModelAdapterError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryable: boolean = code === 'timeout' ||
      code === 'rate_limited' ||
      code === 'unavailable',
    /** the provider's own wait hint (Retry-After) in ms, when it sent one; the gateway's retry policy decides whether to honour it */
    readonly retryAfterMs?: number,
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
  /**
   * OPTIONAL (S-AG4): ask the provider which models the key can see. A live, read-only, key-validating request that needs the same gates as a call; it sends no prompt.
   * The result is reconciled against `models()` (see `reconcileDiscovery`): a model the adapter does not declare is reported, never offered.
   */
  discoverModels?(ctx: CallContext): Promise<DiscoveredModel[]>;
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

/** The contract every existing adapter was written against; the version an adapter declares until it implements 1.1 and passes its conformance cases. */
export const MODEL_CONTRACT_VERSION = '1.0.0';
/** Contract 1.1 (D-46, ADR-066, SCR-K-10): additive to 1.0 (tool calling, neutral content blocks, streamed tool-call deltas, `invalid_response`, `unsupported_capability`). */
export const MODEL_CONTRACT_VERSION_1_1 = '1.1.0';

/** `a >= b` for `major.minor.patch` strings; anything that does not parse is "older than everything" (fail closed). */
export function contractAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

/**
 * Version negotiation (SCR-K-10 §2): the capabilities of `adapter`'s model that the gateway may rely on. A 1.0 adapter keeps its 1.0 capabilities; the 1.1 capabilities count
 * only when the adapter declares contract >= 1.1.0, and `streaming-tool-calls` / `parallel-tool-calls` only together with `tool-use`.
 */
export function effectiveCapabilities(
  contractVersion: string,
  declared: readonly ModelCapability[],
): ModelCapability[] {
  const v11 = contractAtLeast(contractVersion, MODEL_CONTRACT_VERSION_1_1);
  const hasTools = declared.includes('tool-use');
  return declared.filter(
    (c) => !V1_1_CAPABILITIES.includes(c) || (v11 && (c === 'tool-use' || hasTools)),
  );
}

/** Deterministic token estimate used by the mock and as the gateway fallback: ceil(chars / 4) per message plus 4 framing tokens. */
export function estimateTokens(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) n += Math.ceil(messageChars(m) / 4) + 4;
  return n;
}
/** The characters a message contributes to a prompt: its text, plus (contract 1.1) the text of its blocks, tool-call arguments and tool results. */
export function messageChars(m: ModelMessage): number {
  let n = m.content.length;
  for (const b of m.blocks ?? [])
    n +=
      b.type === 'text'
        ? b.text.length
        : b.type === 'tool_call'
          ? b.name.length + safeJsonLength(b.args)
          : b.content.length;
  return n;
}
const safeJsonLength = (v: unknown): number => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
};
