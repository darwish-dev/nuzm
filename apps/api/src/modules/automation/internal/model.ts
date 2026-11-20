import { ProblemException } from '../../../common/errors';
import { UUID, isUuid } from '@nuzm/domain';
export { UUID, isUuid };

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loosely-typed JSON rows
export const iso = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);
export const pgCode = (e: unknown): string | undefined => (e as { code?: string }).code;
export const hint = (e: unknown): string | undefined => (e as { hint?: string }).hint;

export const AUTOMATION_FLAG = 'automation.enabled';
export const WEBHOOKS_FLAG = 'webhooks.enabled';

/** Outbox topics a workflow may trigger on, and an outbound webhook endpoint may subscribe to (allow-list, docs/05 §5; M11 S51.2). */
export const ALLOWED_EVENT_TOPICS = [
  'invoice.issued',
  'ai.run.completed',
  'site.deployed',
  'domain.registered',
  'payment.succeeded',
  'payment.failed',
  'org.created',
  'resource.state_changed',
] as const;
export type AllowedTopic = (typeof ALLOWED_EVENT_TOPICS)[number];
export const isAllowedTopic = (t: unknown): t is AllowedTopic =>
  (ALLOWED_EVENT_TOPICS as readonly string[]).includes(t as string);

export interface Trigger {
  type: 'schedule' | 'webhook' | 'platform_event' | 'manual';
  cron?: string;
  timezone?: string;
  topic?: string;
}

export function badRequest(detail: string, errors?: unknown[]): ProblemException {
  return new ProblemException('validation_failed', detail, errors);
}

/** Environment-driven limits of the automation module (all have safe defaults). */
export interface AutomationConfig {
  maxConcurrentPerOrg: number;
  maxExecutionsPerMinutePerOrg: number;
  retryBaseSeconds: number;
  retryCapSeconds: number;
  retryMaxAttempts: number;
  leaseSeconds: number;
  /** Anomaly rules: executions of one workflow in a minute above this pauses it. */
  spikePerMinute: number;
  /** Anomaly rules: 4xx share of the last `rateWindow` HTTP step results above this (0..1) pauses the workflow. */
  http4xxRate: number;
  rateWindow: number;
  maxChainDepth: number;
  outputCapBytes: number;
  scopeCapBytes: number;
  /** Declared target region used when a connector/step names none (fail-closed default: the residency decision decides). */
  defaultTargetRegion: string;
  inboundBodyMaxBytes: number;
}
export const loadAutomationConfig = (env: NodeJS.ProcessEnv = process.env): AutomationConfig => {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    maxConcurrentPerOrg: n('AUTOMATION_MAX_CONCURRENT', 10),
    maxExecutionsPerMinutePerOrg: n('AUTOMATION_MAX_EXECUTIONS_PER_MINUTE', 600),
    retryBaseSeconds: n('AUTOMATION_RETRY_BASE_SECONDS', 2),
    retryCapSeconds: n('AUTOMATION_RETRY_CAP_SECONDS', 300),
    retryMaxAttempts: n('AUTOMATION_RETRY_MAX_ATTEMPTS', 5),
    leaseSeconds: n('AUTOMATION_LEASE_SECONDS', 60),
    spikePerMinute: n('AUTOMATION_SPIKE_PER_MINUTE', 300),
    http4xxRate: n('AUTOMATION_HTTP_4XX_RATE', 0.8),
    rateWindow: n('AUTOMATION_RATE_WINDOW', 20),
    maxChainDepth: n('AUTOMATION_MAX_CHAIN_DEPTH', 5),
    outputCapBytes: n('AUTOMATION_OUTPUT_CAP_BYTES', 64 * 1024),
    scopeCapBytes: n('AUTOMATION_SCOPE_CAP_BYTES', 512 * 1024),
    defaultTargetRegion: env.AUTOMATION_DEFAULT_TARGET_REGION ?? 'unverified',
    inboundBodyMaxBytes: n('AUTOMATION_INBOUND_BODY_MAX_BYTES', 256 * 1024),
  };
};
export const AUTOMATION_CONFIG = Symbol('AUTOMATION_CONFIG');

const SECRET_KEY =
  /(secret|password|passwd|token|api[-_]?key|authorization|private[-_]?key|credential|client[-_]?secret)/i;
const VAULT_REF = /^vault:\/\/[A-Za-z0-9/_.-]{1,200}$/;
/** 422 `credential_value_rejected` when a body carries a literal credential: only vault REFERENCES are accepted (docs/04 §6: raw secret in body rejected). */
export function rejectRawSecrets(v: unknown, path = '$', depth = 0): void {
  if (depth > 10 || v === null || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (
      SECRET_KEY.test(k) &&
      x !== null &&
      x !== undefined &&
      !(typeof x === 'string' && VAULT_REF.test(x)) &&
      !/^(vaultRef|secretRef|tokenRef)$/.test(k) &&
      k !== 'secretRotation' &&
      !/^(tokenUrl|tokenEndpoint|secretsRequired)$/.test(k)
    )
      throw new ProblemException(
        'credential_value_rejected',
        `'${path}.${k}' looks like a credential: send a vault reference (vaultRef), never the value`,
      );
    rejectRawSecrets(x, `${path}.${k}`, depth + 1);
  }
}

/** Tenant secrets live under a per-organization id so a tenant can NEVER point a connector at a platform secret (confused-deputy / exfiltration). */
export const tenantSecretId = (orgId: string, kind: string, id: string) =>
  `tenant-${orgId}-${kind}-${id}`;
export const isTenantRef = (orgId: string, ref: unknown): ref is string =>
  typeof ref === 'string' &&
  new RegExp(`^vault://[a-z]+/tenant-${orgId}-[A-Za-z0-9_-]{1,120}$`).test(ref);
export const NO_SECRET_REF = 'vault://none/internal';
export const DEFAULT_DATA_REGION = 'sa-pending';

/** Does the declared scope set cover the required scope? Exact, or `resource:*`. */
export const scopeCovers = (have: readonly string[], need: string): boolean =>
  have.some((s) => s === need || (s.endsWith(':*') && need.startsWith(s.slice(0, -1))));
