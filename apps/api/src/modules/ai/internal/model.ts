import { parseFallbackPolicy, type FallbackPolicy } from '@nuzm/adapter-model';
import type {
  ContentBlock,
  StreamChunk,
  ToolCall,
  ToolChoice,
  ToolSpec,
} from '@nuzm/adapter-model';
import type { Capability, DataClass, RejectedCall } from '@nuzm/domain';
import { UUID, isUuid } from '@nuzm/domain';
export { UUID, isUuid };

export type Row = Record<string, unknown>;

export const AI_CONFIG = Symbol('AI_CONFIG');
export interface AiConfig {
  /** minor units of the wallet one credit is worth (D-23 OPEN: parameterised, default 1) */
  creditUnitMinor: number;
  /** wallet currency credits are drawn from */
  currency: string;
  /** how long a pre-flight reservation is held before the sweeper may release it */
  reservationTtlSeconds: number;
  callTimeoutMs: number;
  /** attempts per candidate for a retryable provider error (budget-aware: the same reservation) */
  attemptsPerCandidate: number;
  /** backoff between attempts on one candidate: exponential from the base, capped, with full jitter (a provider's Retry-After is honoured up to the cap) */
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  /** circuit breaker per provider/model: consecutive health failures (timeout, unavailable, rate limited) that open it, and how long it stays open before one trial call */
  breakerFailureThreshold: number;
  breakerOpenMs: number;
  /** which allowed candidates may stand in for another (null = every allowed candidate: the original behaviour). `AI_FALLBACK_POLICY` as JSON; malformed = null. */
  fallbackPolicy: FallbackPolicy | null;
  /** `AI_MAX_OUTPUT_TOKENS`: a ceiling on the output tokens of EVERY model call, whatever a run kind asks for (it only lowers). null = no ceiling. */
  maxOutputTokensCeiling: number | null;
  /** `AI_MAX_REPAIR_ATTEMPTS` (0..2, default 2): how many times an invalid answer is sent back to the model for correction. Each one is a further model request. */
  repairAttempts: number;
  /** DEV ONLY: registers the in-memory mock model provider */
  localReference: boolean;
  /** platform secret canaries that must never reach a prompt (tests plant them; production lists real fingerprints' plaintext is NOT used) */
  canaries: string[];
  /** may unattested providers receive personal/customer-content? default FALSE; only HG-04-01 / owner policy may change it */
  allowUnattestedForSensitive: boolean;
  /** run-event poll interval for SSE (ms) */
  ssePollMs: number;
  /** region id stored prompts and artifacts are placed in (the platform database is in-Kingdom; D-34/HG-04-01 own retention) */
  dataRegion: string;
  /** concurrent active runs per organization */
  maxConcurrentRuns: number;
  /** how long a pending approval stays valid (hours; PROPOSAL 24) */
  approvalTtlHours: number;
  /**
   * Provider codes the owner has approved for LIVE calls in this environment (`AI_LIVE_PROVIDERS`, comma separated; default none). A provider that is not listed refuses every
   * call before its key is read, whatever its row says: storing a key, attesting terms and enabling a provider do NOT by themselves allow a live request (S-AG4).
   */
  liveProviders: string[];
  /**
   * The owner's recorded approvals of the bounded capability probe (D9), `AI_PROBE_APPROVALS` as a JSON array of {ref, approvedBy, environment: "non-production", maxRequests,
   * maxTotalTokens}. Default none: without a matching entry the probe is refused before anything is sent. Never read in production.
   */
  probeApprovals: {
    ref: string;
    approvedBy: string;
    environment: 'non-production';
    maxRequests: number;
    maxTotalTokens: number;
  }[];
}
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const n = (k: string, d: number, min = 0) => {
    const v = env[k] === undefined ? d : Number(env[k]);
    return Number.isFinite(v) && v >= min ? v : d;
  };
  return {
    creditUnitMinor: Math.max(1, Math.floor(n('AI_CREDIT_UNIT_MINOR', 1, 1))),
    currency: (env.AI_CREDIT_CURRENCY ?? 'SAR').toUpperCase(),
    reservationTtlSeconds: n('AI_RESERVATION_TTL_SECONDS', 300, 1),
    callTimeoutMs: n('AI_CALL_TIMEOUT_MS', 60_000, 1),
    attemptsPerCandidate: Math.max(1, Math.floor(n('AI_ATTEMPTS_PER_CANDIDATE', 2, 1))),
    retryBaseDelayMs: Math.floor(n('AI_RETRY_BASE_MS', 200, 0)),
    retryMaxDelayMs: Math.floor(n('AI_RETRY_MAX_MS', 5_000, 0)),
    breakerFailureThreshold: Math.max(1, Math.floor(n('AI_BREAKER_THRESHOLD', 5, 1))),
    breakerOpenMs: Math.floor(n('AI_BREAKER_OPEN_MS', 30_000, 0)),
    fallbackPolicy: parseFallbackEnv(env.AI_FALLBACK_POLICY),
    maxOutputTokensCeiling: strictInt(env, 'AI_MAX_OUTPUT_TOKENS', null, 1, 200_000),
    repairAttempts: strictInt(env, 'AI_MAX_REPAIR_ATTEMPTS', 2, 0, 2)!,
    localReference: env.AI_LOCAL_REFERENCE === 'true' && env.NODE_ENV !== 'production',
    canaries: (env.AI_SECRET_CANARIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length >= 8),
    allowUnattestedForSensitive: env.AI_ALLOW_UNATTESTED_SENSITIVE === 'true',
    ssePollMs: n('AI_SSE_POLL_MS', 500, 10),
    dataRegion: env.AI_DATA_REGION ?? 'sa-central',
    maxConcurrentRuns: Math.max(1, Math.floor(n('AI_MAX_CONCURRENT_RUNS', 5, 1))),
    approvalTtlHours: n('AI_APPROVAL_TTL_HOURS', 24, 0.0001),
    probeApprovals: parseProbeApprovals(env),
    // Read in production too: the owner turns a provider on by writing AI_LIVE_PROVIDERS into the root-owned /etc/nuzm/api.env on the server (an explicit
    // human action outside the app). Default none. The provider still needs a stored key, attested terms, a rate card and a second person's approval.
    liveProviders: (env.AI_LIVE_PROVIDERS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => /^[a-z][a-z0-9-]{0,62}$/.test(x)),
  };
}

/** A setting that exists to LIMIT spending must never be dropped silently: unset = the default, anything else must be a whole number in range or the process stops. */
function strictInt(
  env: NodeJS.ProcessEnv,
  key: string,
  dflt: number | null,
  min: number,
  max: number,
): number | null {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max)
    throw new Error(`${key} must be a whole number from ${min} to ${max}`);
  return v;
}

export const AI_FLAG = 'ai.enabled';
export const AI_KILLSWITCH = 'ai.killswitch';
export const AI_OP_KIND = 'ai.run';

export interface GatewayCall {
  orgId: string;
  runId?: string;
  projectId?: string;
  runKind?: string;
  task: string;
  capability: Capability;
  /** the class of the CONTENT in the prompt: decides residency + data-terms handling */
  dataClass: DataClass;
  /** `blocks` (contract 1.1): tool calls and tool results of an agent loop; absent for every other caller */
  messages: { role: 'system' | 'user' | 'assistant'; content: string; blocks?: ContentBlock[] }[];
  maxTokens: number;
  responseFormat?: 'json' | 'text';
  /** deterministic per logical call (`<runId>:<step>:<attempt>`): usage and metering dedupe on it */
  callId: string;
  /** caps of this run (tokens / credits) as given at creation */
  runBudget?: { maxTokens?: number; maxCredits?: number };
  signal?: AbortSignal;
  actorUserId?: string;
  /**
   * Tool calling (ModelAdapter contract 1.1, D-46). Only a model that declares `tool-use` under an adapter that implements 1.1 is a candidate; none = 422 `unsupported_capability`.
   * The gateway never runs a tool: it validates what the model asked for and returns it (`toolCalls`, plus `rejectedToolCalls` with reasons).
   */
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  maxToolCalls?: number;
  /** read the answer as a stream (text and tool-call deltas arrive at `onChunk`); the result is the same. A candidate is then also required to declare `streaming-tool-calls` when tools are given. */
  stream?: boolean;
  onChunk?: (chunk: StreamChunk) => void;
}
export interface GatewayResult {
  text: string;
  finishReason: 'stop' | 'length' | 'refusal' | 'tool_calls';
  /** tool calls whose tool is declared and whose arguments satisfy its schema */
  toolCalls?: ToolCall[];
  /** calls the model asked for that failed validation, with the reasons: the caller tells the model, nothing is executed */
  rejectedToolCalls?: RejectedCall[];
  tokensIn: number;
  tokensOut: number;
  estimated: boolean;
  credits: bigint;
  providerCode: string;
  modelRef: string;
  region: string;
  callId: string;
  duplicate: boolean;
}

/** `AI_FALLBACK_POLICY`: JSON `{mode, approved}`; absent or malformed yields null (every allowed candidate is a fallback, as before). */
function parseFallbackEnv(raw: string | undefined): FallbackPolicy | null {
  if (!raw) return null;
  try {
    return parseFallbackPolicy(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** `AI_PROBE_APPROVALS`: a malformed value, a production process or an entry that is not fully specified yields no approval (fail closed). */
function parseProbeApprovals(env: NodeJS.ProcessEnv): AiConfig['probeApprovals'] {
  if (env.NODE_ENV === 'production' || !env.AI_PROBE_APPROVALS) return [];
  try {
    const raw = JSON.parse(env.AI_PROBE_APPROVALS) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (x): x is AiConfig['probeApprovals'][number] =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as { ref?: unknown }).ref === 'string' &&
        typeof (x as { approvedBy?: unknown }).approvedBy === 'string' &&
        (x as { environment?: unknown }).environment === 'non-production' &&
        Number.isInteger((x as { maxRequests?: unknown }).maxRequests) &&
        Number.isInteger((x as { maxTotalTokens?: unknown }).maxTotalTokens),
    );
  } catch {
    return [];
  }
}
