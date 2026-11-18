import type { Capability, DataClass } from '@nuzm/domain';

export type Row = Record<string, unknown>;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

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
  };
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
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  responseFormat?: 'json' | 'text';
  /** deterministic per logical call (`<runId>:<step>:<attempt>`): usage and metering dedupe on it */
  callId: string;
  /** caps of this run (tokens / credits) as given at creation */
  runBudget?: { maxTokens?: number; maxCredits?: number };
  signal?: AbortSignal;
  actorUserId?: string;
}
export interface GatewayResult {
  text: string;
  finishReason: 'stop' | 'length' | 'refusal';
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
