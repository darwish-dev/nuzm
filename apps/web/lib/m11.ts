/**
 * Pure helpers and DTO shapes of the M11 customer screens (automation, marketplace, agency and reseller programs; UI-M11-01..19). No I/O: unit-tested in `m11.spec.ts`.
 *
 * The OpenAPI schemas of the M11 routes are intentionally loose (`M11Object`, `M11Page`), so the response shapes below mirror the DTOs the API controllers return
 * (apps/api/src/modules/{automation,marketplace,programs}). A field that is not in those DTOs is not used.
 */
import { formatMinor, t, type Locale, type MessageKey } from '@nuzm/i18n';
import { dataError, problemOf, type ProblemInfo, type Tone } from './data';

/* ------------------------------------------------------------------ flags, ids, feature gate */

export const FLAGS = {
  automation: 'automation.enabled',
  marketplace: 'marketplace.enabled',
  agency: 'agency.enabled',
  reseller: 'reseller.enabled',
} as const;
export const ACTING_COOKIE = 'nuzm_acting_org';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/* ------------------------------------------------------------------ DTOs (mirror the API controllers) */

export interface TriggerDto {
  type: 'schedule' | 'webhook' | 'platform_event' | 'manual';
  cron?: string;
  timezone?: string;
  topic?: string;
}
export interface StepDef {
  id: string;
  type: string;
  name?: string;
  params: Record<string, unknown>;
  next?: string;
  onTrue?: string;
  onFalse?: string;
  retry?: { maxAttempts?: number };
  idempotencyKey?: string;
  body?: StepDef[];
}
export interface WorkflowDefinition {
  schemaVersion: 1;
  start: string;
  steps: StepDef[];
}
export interface WorkflowDto {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'disabled';
  activeVersionId: string | null;
  activeVersion: number | null;
  triggers: TriggerDto[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  pausedReason: string | null;
  pausedByAdmin: boolean;
  sourceListingVersionId: string | null;
  definition?: WorkflowDefinition;
  versions?: { id: string; version: number; createdAt: string; notes: string | null }[];
  webhook?: { path: string; secret: string };
  etag: number;
  createdAt: string;
}
export interface ExecutionStepDto {
  stepKey: string;
  attempt: number;
  status: string;
  idempotent: boolean;
  input: unknown;
  output: unknown;
  error: unknown;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ExecutionDto {
  id: string;
  workflowId: string;
  versionId: string;
  trigger: string;
  status: string;
  input: unknown;
  operationId: string | null;
  error: unknown;
  stepsRun: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  duplicate?: boolean;
  steps?: ExecutionStepDto[];
  deadLetters?: { id: string; stepKey: string; reason: string; replayedAt: string | null }[];
}
export interface ConnectorDto {
  id: string;
  type: 'nuzm' | 'http' | 'oauth2' | 'email';
  name: string;
  scopes: string[];
  rateLimit: { perMinute: number; burst: number };
  config: Record<string, unknown>;
  status: 'pending' | 'active' | 'revoked' | 'disabled';
  authorization: {
    status: 'none' | 'pending' | 'active' | 'revoked' | 'expired';
    expiresAt: string | null;
    scopes: string[];
  } | null;
  dataRegion: string;
  etag: number;
  createdAt: string;
}
export interface WebhookEndpointDto {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  status: 'active' | 'paused' | 'disabled';
  consecutiveFailures: number;
  secretRotation: { overlapUntil: string | null };
  secret?: string;
  rotated?: boolean;
  etag: number;
  createdAt: string;
}
export interface VersionDto {
  id: string;
  version: string;
  moderationStatus: 'pending' | 'approved' | 'rejected' | 'suspended';
  changelog: string | null;
  contentHash: string;
  createdAt: string;
  artifactRef?: string;
  scan?: { verdict: string; findings: ScanFinding[]; rulesetVersion: string } | null;
}
export interface ScanFinding {
  rule: string;
  severity: 'block' | 'warn';
  where: string;
  detail: string;
}
export interface ListingDto {
  id: string;
  type: 'website-template' | 'app-template' | 'workflow-template';
  title: { ar: string; en: string };
  description: { ar: string | null; en: string | null };
  status: 'draft' | 'published' | 'suspended' | 'archived';
  licence: 'single_org' | 'multi_seat';
  seats: number;
  price: { amount: string; currency: string };
  priceWithTax?: { taxMinor: string; totalMinor: string; rateBps: number; status: 'provisional' };
  versions: VersionDto[];
  mine: boolean;
  accrual?: { grossMinor: string; shareMinor: string; currency: string; purchases: number };
  etag: number;
  createdAt: string;
}
export interface PurchaseDto {
  purchaseId: string;
  listingId: string;
  listingVersionId: string;
  invoiceId: string | null;
  entitlementId: string;
  status: 'pending_payment' | 'paid' | 'failed' | 'refunded';
  entitlementStatus: 'pending' | 'active' | 'revoked';
  amount: { amount: string; currency: string };
  paidAt: string | null;
  createdAt: string;
}
export interface InstallationDto {
  id: string;
  listingId: string;
  listingVersionId: string;
  entitlementId: string;
  targetType: 'workflow' | 'project';
  targetId: string | null;
  workspaceId: string | null;
  status: 'pending' | 'succeeded' | 'failed';
  error: unknown;
  createdAt: string;
}
/** One element of `GET /v1/billing/entitlements` → `marketplace[]`. */
export interface MarketEntitlementDto {
  entitlementId: string;
  listingId: string;
  type: string | null;
  title: { ar: string | null; en: string | null };
  versionRange: string;
  licence: string;
  seats: number;
  status: string;
  purchaseId: string;
  createdAt: string;
}
export interface AgencyDto {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  role: 'agency' | 'client';
  consolidatedBilling: boolean;
  etag: number;
  createdAt: string;
}
export interface LinkDto {
  id: string;
  agencyId: string;
  clientOrgId: string;
  status: 'pending' | 'active' | 'revoked' | 'declined';
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface GrantDto {
  id: string;
  agencyId: string;
  clientOrgId: string;
  scopes: string[];
  expiresAt: string;
  status: 'pending' | 'active' | 'revoked' | 'expired' | 'declined';
  grantedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface ResellerDto {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  currency: string;
  role: 'reseller' | 'sub_organization';
  etag: number;
  createdAt: string;
}
export interface SubOrgDto {
  id: string;
  resellerId: string;
  subOrgId: string;
  subOrgName: string | null;
  priceBookRef: string | null;
  status: 'pending' | 'active' | 'removed' | 'declined';
  acceptedAt: string | null;
  createdAt: string;
}
export type Markup =
  { type: 'percent'; bps: number } | { type: 'fixed'; amountMinor: string; currency: string };
export interface PriceRuleDto {
  scope: 'plan' | 'meter';
  scopeKey: string;
  markup: Markup;
  effectiveFrom: string;
}
export interface RuleSetDto {
  version: number;
  etag: string;
  rules: PriceRuleDto[];
  history: { version: number; createdAt: string; rules: number }[];
}
export interface StatementLine {
  subOrgId: string;
  meterId: string;
  quantity: string;
  wholesaleMinor: string;
  retailMinor: string;
  marginMinor: string;
  ruleSetVersion: number | null;
}
export interface StatementDto {
  resellerId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  provisional: boolean;
  totals: { wholesaleMinor: string; retailMinor: string; marginMinor: string; taxMinor: string };
  taxStatus: 'provisional';
  ledger: { wholesaleMinor: string; varianceMinor: string };
  issuer: {
    model: string;
    status: 'disabled' | 'BLOCKED' | 'enabled';
    requested: string | null;
    reason: string;
  };
  subOrganizations: number;
  lines: StatementLine[];
  createdAt: string | null;
}

/** The items of a page response, typed by the caller (the schema says only `object`). */
export const itemsOf = <T>(page: { items: unknown[] }): T[] => page.items as T[];

/* ------------------------------------------------------------------ status tones */

export const workflowTone = (s: string): Tone =>
  s === 'active'
    ? 'success'
    : s === 'paused' || s === 'draft'
      ? 'warn'
      : s === 'disabled'
        ? 'danger'
        : undefined;
export const executionTone = (s: string): Tone =>
  s === 'succeeded'
    ? 'success'
    : s === 'failed'
      ? 'danger'
      : s === 'queued' || s === 'running' || s === 'waiting'
        ? 'warn'
        : undefined;
export const connectorTone = (s: string): Tone =>
  s === 'active'
    ? 'success'
    : s === 'pending'
      ? 'warn'
      : s === 'revoked' || s === 'disabled' || s === 'expired'
        ? 'danger'
        : undefined;
export const moderationTone = (s: string): Tone =>
  s === 'approved' ||
  s === 'published' ||
  s === 'clean' ||
  s === 'succeeded' ||
  s === 'paid' ||
  s === 'active'
    ? 'success'
    : s === 'rejected' ||
        s === 'suspended' ||
        s === 'flagged' ||
        s === 'failed' ||
        s === 'refunded' ||
        s === 'revoked'
      ? 'danger'
      : s === 'pending' || s === 'draft' || s === 'pending_payment'
        ? 'warn'
        : undefined;
export const linkTone = (s: string): Tone =>
  s === 'active'
    ? 'success'
    : s === 'pending'
      ? 'warn'
      : s === 'revoked' || s === 'declined' || s === 'expired' || s === 'removed'
        ? 'danger'
        : undefined;

/** `title` of a listing in the user's language (the other language is the fallback). */
export const listingTitle = (l: Pick<ListingDto, 'title'>, locale: Locale) =>
  (locale === 'ar' ? l.title.ar || l.title.en : l.title.en || l.title.ar) || '';
export const listingDescription = (l: Pick<ListingDto, 'description'>, locale: Locale) =>
  (locale === 'ar' ? l.description.ar || l.description.en : l.description.en || l.description.ar) ??
  '';
export const entitlementTitle = (e: MarketEntitlementDto, locale: Locale) =>
  (locale === 'ar' ? e.title.ar || e.title.en : e.title.en || e.title.ar) || e.listingId;

/** Integer minor units as text with the currency; an unknown currency falls back to the raw figures (never a float). */
export function moneyText(minor: string, currency: string, locale: Locale): string {
  try {
    return formatMinor(minor, currency, locale);
  } catch {
    return `${minor} ${currency}`;
  }
}

/** A decimal amount typed by a person ("49.90") as integer minor units text ("4990"), or null when it is not a price with at most two decimals. */
export function toMinor(text: string): string | null {
  const m = /^(\d{1,13})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]! + (m[2] ?? '').padEnd(2, '0')).toString();
}

/* ------------------------------------------------------------------ problems */

export interface Issue {
  code: string;
  path: string;
  message: string;
}
/** `errors[]` of a 422 problem (workflow definition, grant, price rules): code, path and message, never trusting the shape. */
export function issuesOf(error: unknown): Issue[] {
  const e = (error as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(e)) return [];
  return e
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({
      code: typeof x.code === 'string' ? x.code : 'invalid',
      path: typeof x.path === 'string' ? x.path : typeof x.field === 'string' ? x.field : '$',
      message: typeof x.message === 'string' ? x.message : '',
    }));
}

const BY_CODE: Record<string, MessageKey> = {
  feature_disabled: 'm11.err.featureDisabled',
  publisher_not_verified: 'm11.err.publisherNotVerified',
  below_cost: 'm11.err.belowCost',
  etag_mismatch: 'm11.err.stale',
  ssrf_denied: 'm11.err.ssrf',
  credential_value_rejected: 'm11.err.credential',
  connector_not_authorized: 'm11.err.connectorNotAuthorized',
  validation_failed: 'm11.err.validation',
  rate_limited: 'm11.err.rate',
  invalid_state: 'm11.err.invalidState',
  already_entitled: 'm11.err.alreadyEntitled',
  not_purchasable: 'm11.err.notPurchasable',
  price_changed: 'm11.err.priceChanged',
  quote_expired: 'm11.err.quoteExpired',
  quote_conflict: 'm11.err.quoteConflict',
  payment_required: 'm11.err.paymentRequired',
  not_entitled: 'm11.err.notEntitled',
  residency_denied: 'm11.err.residency',
  delegation_expired: 'm11.err.delegationExpired',
  issuer_model_blocked: 'm11.err.issuerBlocked',
  name_taken: 'm11.err.nameTaken',
  conflict: 'm11.err.conflict',
  invalid_token: 'm11.err.oauthState',
  unsupported_capability: 'm11.err.unsupported',
};
/** Plain-language message for a failed M11 call; unknown codes fall back to the shared data/email messages. For `unsupported_capability` the API's own reason is returned as `detail`. */
export function m11Error(locale: Locale, p: ProblemInfo): { text: string; detail?: string } {
  const key = p.code ? BY_CODE[p.code] : undefined;
  if (key)
    return {
      text: t(locale, key),
      detail: p.code === 'unsupported_capability' ? p.detail : undefined,
    };
  if (p.status === 404) return { text: t(locale, 'm11.err.notFound') };
  return dataError(locale, p);
}
export { problemOf };

/* ------------------------------------------------------------------ workflow definition: starter, validation hints, layout */

export const STEP_TYPES = [
  'http_request',
  'nuzm_api',
  'send_email',
  'start_ai_run',
  'create_deployment',
  'delay',
  'condition',
  'loop',
  'transform',
] as const;
export const EVENT_TOPICS = [
  'invoice.issued',
  'ai.run.completed',
  'site.deployed',
  'domain.registered',
  'payment.succeeded',
  'payment.failed',
  'org.created',
  'resource.state_changed',
] as const;
export const LIMITS = {
  maxSteps: 100,
  maxLoopIterations: 100,
  maxLoopBody: 20,
  maxDelaySeconds: 86_400,
  maxRetryAttempts: 10,
  maxDefinitionBytes: 256 * 1024,
} as const;
const STEP_ID = /^[a-z][a-z0-9_]{0,39}$/;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SECRETISH_KEY =
  /(secret|password|passwd|token|api[-_]?key|authorization|private[-_]?key|credential)/i;
const SECRETISH_VALUE: RegExp[] = [
  /^\s*(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bnzk_[A-Za-z0-9]{8,}/,
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export const starterDefinition = (): WorkflowDefinition => ({
  schemaVersion: 1,
  start: 'prepare',
  steps: [
    {
      id: 'prepare',
      type: 'transform',
      name: 'Prepare',
      params: { output: { greeting: 'Hello {{ input.name }}' } },
      next: 'wait',
    },
    { id: 'wait', type: 'delay', name: 'Wait', params: { seconds: 5 } },
  ],
});

/** Starting parameters of a new step of each type (a valid shape the person then edits). */
export function defaultParams(type: string): Record<string, unknown> {
  switch (type) {
    case 'http_request':
      return { method: 'GET', url: 'https://example.com/' };
    case 'nuzm_api':
      return { method: 'GET', path: '/v1/projects', connectorId: '' };
    case 'send_email':
      return {
        senderId: '',
        to: ['someone@example.com'],
        subject: 'Subject',
        text: 'Message',
        category: 'transactional',
      };
    case 'start_ai_run':
      return { kind: 'chat', prompt: 'Describe the task' };
    case 'create_deployment':
      return { projectId: '' };
    case 'delay':
      return { seconds: 60 };
    case 'condition':
      return { expr: 'input.value > 0' };
    case 'loop':
      return { over: 'input.items', maxIterations: 10 };
    case 'transform':
      return { output: { value: '{{ input.value }}' } };
    default:
      return {};
  }
}

export function newStepId(def: WorkflowDefinition, type: string): string {
  const ids = new Set(def.steps.flatMap((s) => [s.id, ...(s.body ?? []).map((b) => b.id)]));
  const base = type.replace(/[^a-z0-9_]/g, '_');
  for (let i = 1; i < 1000; i++) if (!ids.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now()}`.slice(0, 40);
}

/** Add a step and, when `after` names a step with a free successor slot, link it in. The first step becomes the start. */
export function addStep(
  def: WorkflowDefinition,
  type: string,
  after?: string,
): { def: WorkflowDefinition; id: string } {
  const id = newStepId(def, type);
  const step: StepDef = { id, type, params: defaultParams(type) };
  if (type === 'loop')
    step.body = [
      { id: `${id}_body`, type: 'transform', params: { output: { item: '{{ item }}' } } },
    ];
  const steps = def.steps.map((s) => ({ ...s }));
  const prev = after ? steps.find((s) => s.id === after) : undefined;
  if (prev) {
    if (prev.type === 'condition') {
      if (!prev.onTrue) prev.onTrue = id;
      else if (!prev.onFalse) prev.onFalse = id;
    } else if (!prev.next) prev.next = id;
  }
  return {
    def: {
      ...def,
      start: def.start && steps.some((s) => s.id === def.start) ? def.start : id,
      steps: [...steps, step],
    },
    id,
  };
}

/** Remove a step and every link that pointed at it; the start moves to the removed step's successor (or the first step left). */
export function removeStep(def: WorkflowDefinition, id: string): WorkflowDefinition {
  const gone = def.steps.find((s) => s.id === id);
  const steps = def.steps
    .filter((s) => s.id !== id)
    .map((s) => {
      const c: StepDef = { ...s };
      for (const k of ['next', 'onTrue', 'onFalse'] as const) if (c[k] === id) delete c[k];
      return c;
    });
  const successor = gone?.next ?? gone?.onTrue ?? gone?.onFalse;
  const start =
    def.start === id
      ? successor && steps.some((s) => s.id === successor)
        ? successor
        : (steps[0]?.id ?? '')
      : def.start;
  return { ...def, start, steps };
}

export function replaceStep(
  def: WorkflowDefinition,
  id: string,
  next: StepDef,
): WorkflowDefinition {
  const renamed = next.id !== id;
  const steps = def.steps.map((s) => {
    const c = s.id === id ? { ...next } : { ...s };
    if (renamed)
      for (const k of ['next', 'onTrue', 'onFalse'] as const) if (c[k] === id) c[k] = next.id;
    return c;
  });
  return { ...def, start: renamed && def.start === id ? next.id : def.start, steps };
}

export type JsonParse<T = unknown> = { ok: true; value: T } | { ok: false; message: string };
export function parseJson(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
export function parseJsonObject(text: string): JsonParse<Record<string, unknown>> {
  const r = parseJson(text);
  if (!r.ok) return r;
  if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value))
    return { ok: false, message: 'not an object' };
  return { ok: true, value: r.value as Record<string, unknown> };
}

/** Whether a parsed value has the shape of a definition (so the canvas can draw it); the full check is `validateDefinition`. */
export function asDefinition(v: unknown): WorkflowDefinition | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = v as Partial<WorkflowDefinition>;
  if (
    !Array.isArray(d.steps) ||
    !d.steps.every((s) => s && typeof s === 'object' && typeof (s as StepDef).id === 'string')
  )
    return null;
  return {
    schemaVersion: 1,
    start: typeof d.start === 'string' ? d.start : '',
    steps: d.steps.map((s) => ({
      ...s,
      params: s.params && typeof s.params === 'object' ? s.params : {},
    })) as StepDef[],
  };
}

const edgesOf = (s: StepDef): string[] =>
  (s.type === 'condition' ? [s.onTrue, s.onFalse] : [s.next]).filter(
    (x): x is string => typeof x === 'string' && x !== '',
  );

/**
 * Client-side validation HINTS: the same structural rules the server applies at publish (schema, ids, params, graph, cycles, reachability, credential-looking values).
 * Expressions are parsed by the server only; a definition that passes here can still be refused there, and the server's answer is shown unchanged.
 */
export function validateDefinition(def: unknown): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const bad = (code: string, path: string, message: string) => errors.push({ code, path, message });
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    bad('invalid_definition', '$', 'definition must be an object');
    return { errors, warnings };
  }
  const d = def as Partial<WorkflowDefinition> & Record<string, unknown>;
  if (JSON.stringify(def).length > LIMITS.maxDefinitionBytes)
    bad('too_large', '$', `definition is larger than ${LIMITS.maxDefinitionBytes} bytes`);
  for (const k of Object.keys(d))
    if (!['schemaVersion', 'start', 'steps'].includes(k))
      bad('invalid_definition', `$.${k}`, 'unknown property');
  if (d.schemaVersion !== 1)
    bad('invalid_definition', '$.schemaVersion', 'schemaVersion must be 1');
  if (!Array.isArray(d.steps) || d.steps.length < 1) {
    bad('invalid_definition', '$.steps', 'at least one step is required');
    return { errors, warnings };
  }
  if (d.steps.length > LIMITS.maxSteps)
    bad('too_large', '$.steps', `at most ${LIMITS.maxSteps} steps`);
  scanSecrets(d, '$', errors);
  const ids = new Set<string>();
  const top = new Map<string, StepDef>();
  const checkStep = (raw: unknown, path: string, inLoop: boolean): StepDef | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      bad('invalid_step', path, 'a step must be an object');
      return null;
    }
    const s = raw as StepDef & Record<string, unknown>;
    if (typeof s.id !== 'string' || !STEP_ID.test(s.id)) {
      bad('invalid_step', `${path}.id`, 'id must match ^[a-z][a-z0-9_]{0,39}$');
      return null;
    }
    if (ids.has(s.id)) bad('duplicate_step_id', `${path}.id`, `duplicate step id '${s.id}'`);
    ids.add(s.id);
    if (!(STEP_TYPES as readonly string[]).includes(s.type)) {
      bad('invalid_step', `${path}.type`, `type must be one of ${STEP_TYPES.join(', ')}`);
      return s;
    }
    if (inLoop && (s.type === 'loop' || s.type === 'delay'))
      bad('invalid_step', `${path}.type`, `a loop body cannot contain a ${s.type}`);
    const p = s.params && typeof s.params === 'object' && !Array.isArray(s.params) ? s.params : {};
    if (
      s.retry?.maxAttempts !== undefined &&
      (!Number.isInteger(s.retry.maxAttempts) ||
        s.retry.maxAttempts < 1 ||
        s.retry.maxAttempts > LIMITS.maxRetryAttempts)
    )
      bad(
        'invalid_step',
        `${path}.retry.maxAttempts`,
        `maxAttempts must be 1..${LIMITS.maxRetryAttempts}`,
      );
    const need = (k: string, max = 2000) => {
      if (typeof p[k] !== 'string' || (p[k] as string).length < 1 || (p[k] as string).length > max)
        bad('invalid_params', `${path}.params.${k}`, `${k} is required (1..${max} characters)`);
    };
    switch (s.type) {
      case 'http_request':
        if (!METHODS.includes(String(p.method ?? 'GET').toUpperCase()))
          bad(
            'invalid_params',
            `${path}.params.method`,
            `method must be one of ${METHODS.join(', ')}`,
          );
        need('url');
        if (typeof p.url === 'string' && !/^(https:\/\/|\{\{)/i.test(p.url.trim()))
          bad('invalid_params', `${path}.params.url`, 'url must be https://');
        if (
          ['POST', 'PATCH'].includes(String(p.method ?? 'GET').toUpperCase()) &&
          typeof s.idempotencyKey !== 'string'
        )
          warnings.push({
            code: 'non_idempotent',
            path,
            message:
              'this POST/PATCH is not retried automatically unless an idempotencyKey mapping is given',
          });
        break;
      case 'nuzm_api':
        if (typeof p.path !== 'string' || !p.path.startsWith('/v1/') || p.path.includes('..'))
          bad(
            'invalid_params',
            `${path}.params.path`,
            'path must start with /v1/ and contain no ..',
          );
        if (typeof p.connectorId !== 'string' || p.connectorId === '')
          bad(
            'invalid_params',
            `${path}.params.connectorId`,
            'a Nuzm API step needs the first-party connector (connectorId)',
          );
        break;
      case 'send_email':
        need('senderId', 200);
        if (!Array.isArray(p.to) || p.to.length < 1 || p.to.length > 50)
          bad('invalid_params', `${path}.params.to`, 'to must be 1..50 recipients');
        if (p.category !== undefined && p.category !== 'transactional')
          bad(
            'invalid_params',
            `${path}.params.category`,
            "only the 'transactional' category is allowed",
          );
        break;
      case 'start_ai_run':
        need('prompt', 20_000);
        break;
      case 'create_deployment':
        need('projectId', 200);
        break;
      case 'delay':
        if (
          !Number.isInteger(p.seconds) ||
          (p.seconds as number) < 1 ||
          (p.seconds as number) > LIMITS.maxDelaySeconds
        )
          bad(
            'invalid_params',
            `${path}.params.seconds`,
            `seconds must be an integer 1..${LIMITS.maxDelaySeconds}`,
          );
        break;
      case 'condition':
        if (typeof p.expr !== 'string' || p.expr.trim() === '')
          bad('invalid_params', `${path}.params.expr`, 'a condition needs an expression');
        break;
      case 'transform':
        if (!p.output || typeof p.output !== 'object' || Array.isArray(p.output))
          bad('invalid_params', `${path}.params.output`, 'output must be an object of templates');
        break;
      default:
        break;
    }
    return s;
  };
  (d.steps as unknown[]).forEach((raw, i) => {
    const s = checkStep(raw, `$.steps[${i}]`, false);
    if (!s) return;
    top.set(s.id, s);
    if (s.type === 'loop') {
      const p = s.params ?? {};
      if (typeof p.over !== 'string' || p.over.trim() === '')
        bad(
          'invalid_params',
          `$.steps[${i}].params.over`,
          'a loop needs the list expression it runs over',
        );
      if (
        !Number.isInteger(p.maxIterations) ||
        (p.maxIterations as number) < 1 ||
        (p.maxIterations as number) > LIMITS.maxLoopIterations
      )
        bad(
          'invalid_params',
          `$.steps[${i}].params.maxIterations`,
          `maxIterations must be an integer 1..${LIMITS.maxLoopIterations}`,
        );
      const body = s.body;
      if (!Array.isArray(body) || body.length < 1 || body.length > LIMITS.maxLoopBody)
        bad(
          'invalid_step',
          `$.steps[${i}].body`,
          `a loop needs a body of 1..${LIMITS.maxLoopBody} steps`,
        );
      else body.forEach((b, j) => checkStep(b, `$.steps[${i}].body[${j}]`, true));
    }
  });
  if (errors.some((e) => e.code === 'duplicate_step_id')) return { errors, warnings };
  if (typeof d.start !== 'string' || !top.has(d.start))
    bad('invalid_graph', '$.start', 'start must name a step');
  for (const s of top.values()) {
    if (s.type === 'condition') {
      if (!s.onTrue && !s.onFalse)
        bad('invalid_graph', `$.steps.${s.id}`, 'a condition needs onTrue and/or onFalse');
      if (s.next !== undefined)
        bad('invalid_graph', `$.steps.${s.id}.next`, 'a condition uses onTrue/onFalse, not next');
    } else if (s.onTrue !== undefined || s.onFalse !== undefined)
      bad('invalid_graph', `$.steps.${s.id}`, 'onTrue/onFalse are only for conditions');
    for (const e of edgesOf(s))
      if (!top.has(e)) bad('invalid_graph', `$.steps.${s.id}`, `unknown successor '${e}'`);
  }
  if (errors.some((e) => e.code === 'invalid_graph')) return { errors, warnings };
  // cycles and reachability (iterative DFS, three colours)
  const colour = new Map<string, 1 | 2>();
  const reachable = new Set<string>();
  let cyclic = false;
  const visit = (root: string) => {
    const stack: { id: string; i: number }[] = [{ id: root, i: 0 }];
    colour.set(root, 1);
    reachable.add(root);
    while (stack.length && !cyclic) {
      const top_ = stack[stack.length - 1]!;
      const succ = edgesOf(top.get(top_.id)!);
      if (top_.i < succ.length) {
        const n = succ[top_.i++]!;
        const c = colour.get(n);
        if (c === 1) {
          cyclic = true;
          bad(
            'cycle',
            `$.steps.${top_.id}`,
            `the graph has a cycle through '${n}' (use a loop step for repetition)`,
          );
        } else if (!c) {
          colour.set(n, 1);
          reachable.add(n);
          stack.push({ id: n, i: 0 });
        }
      } else {
        colour.set(top_.id, 2);
        stack.pop();
      }
    }
  };
  if (typeof d.start === 'string' && top.has(d.start)) visit(d.start);
  if (!cyclic)
    for (const id of top.keys())
      if (!reachable.has(id))
        bad('unreachable_step', `$.steps.${id}`, `step '${id}' cannot be reached from start`);
  return { errors, warnings };
}

function scanSecrets(v: unknown, path: string, out: Issue[], depth = 0): void {
  if (depth > 12) return;
  if (typeof v === 'string') {
    if (SECRETISH_VALUE.some((re) => re.test(v)) && !/^vault:\/\//.test(v))
      out.push({
        code: 'secret_in_definition',
        path,
        message: 'a credential-like value is not allowed in a definition; use a connector',
      });
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => scanSecrets(x, `${path}[${i}]`, out, depth + 1));
  if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      if (
        SECRETISH_KEY.test(k) &&
        typeof x === 'string' &&
        x.length > 0 &&
        !/\{\{/.test(x) &&
        !/^vault:\/\//.test(x)
      )
        out.push({
          code: 'secret_in_definition',
          path: `${path}.${k}`,
          message: `'${k}' must not hold a literal credential; use a connector`,
        });
      scanSecrets(x, `${path}.${k}`, out, depth + 1);
    }
}

/** One-line summary of what a step does, for its card. */
export function describeStep(s: StepDef): string {
  const p = s.params ?? {};
  switch (s.type) {
    case 'http_request':
      return `${String(p.method ?? 'GET')} ${String(p.url ?? '')}`.trim();
    case 'nuzm_api':
      return `${String(p.method ?? 'GET')} ${String(p.path ?? '')}`.trim();
    case 'delay':
      return `${String(p.seconds ?? '')} s`;
    case 'condition':
      return String(p.expr ?? '');
    case 'loop':
      return `${String(p.over ?? '')} ≤ ${String(p.maxIterations ?? '')}`;
    case 'send_email':
      return String(p.subject ?? p.templateId ?? '');
    case 'start_ai_run':
      return `${String(p.kind ?? '')}`;
    case 'create_deployment':
      return String(p.projectId ?? '');
    default:
      return '';
  }
}

export interface CanvasNode {
  id: string;
  step: StepDef;
  row: number;
  lane: number;
  /** Not reachable from `start` (placed below the flow). */
  orphan: boolean;
}
export interface CanvasEdge {
  from: string;
  to: string;
  kind: 'next' | 'true' | 'false';
}
export const CARD = { w: 232, h: 84, gapX: 40, gapY: 44 } as const;

/**
 * Layout of the step cards: a row per depth (longest path from the start), a lane per branch (a condition's false branch opens a new lane, its true branch and `next` stay in the lane
 * of their predecessor, a rejoin keeps the lane it was first given). The result is in reading order (by row, then lane), which is also the DOM and tab order.
 */
export function layoutDefinition(def: WorkflowDefinition): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  lanes: number;
  rows: number;
} {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const edges: CanvasEdge[] = [];
  for (const s of def.steps) {
    if (s.type === 'condition') {
      if (s.onTrue && byId.has(s.onTrue)) edges.push({ from: s.id, to: s.onTrue, kind: 'true' });
      if (s.onFalse && byId.has(s.onFalse))
        edges.push({ from: s.id, to: s.onFalse, kind: 'false' });
    } else if (s.next && byId.has(s.next)) edges.push({ from: s.id, to: s.next, kind: 'next' });
  }
  const row = new Map<string, number>();
  const lane = new Map<string, number>();
  const reach: string[] = [];
  let maxLane = 0;
  if (byId.has(def.start)) {
    // breadth-first by depth with longest-path relaxation (bounded: a cycle cannot raise a row beyond the step count)
    const limit = def.steps.length;
    row.set(def.start, 0);
    lane.set(def.start, 0);
    const queue = [def.start];
    let guard = 0;
    while (queue.length && guard++ < limit * limit + 10) {
      const id = queue.shift()!;
      for (const e of edges.filter((x) => x.from === id)) {
        const r = (row.get(id) ?? 0) + 1;
        if (r > limit) continue;
        if ((row.get(e.to) ?? -1) < r) {
          row.set(e.to, r);
          queue.push(e.to);
        }
        if (!lane.has(e.to)) {
          if (e.kind === 'false') lane.set(e.to, ++maxLane);
          else lane.set(e.to, lane.get(id) ?? 0);
        }
      }
    }
    reach.push(...row.keys());
  }
  let below = reach.length ? Math.max(...row.values()) + 1 : 0;
  const nodes: CanvasNode[] = [];
  for (const s of def.steps) {
    if (row.has(s.id))
      nodes.push({
        id: s.id,
        step: s,
        row: row.get(s.id)!,
        lane: lane.get(s.id) ?? 0,
        orphan: false,
      });
    else nodes.push({ id: s.id, step: s, row: below++, lane: 0, orphan: true });
  }
  nodes.sort((a, b) => a.row - b.row || a.lane - b.lane);
  return {
    nodes,
    edges,
    lanes: Math.max(1, maxLane + 1),
    rows: Math.max(1, below || nodes.length),
  };
}

/* ------------------------------------------------------------------ cron hint, redaction, execution view */

export const validCronShape = (v: string) => /^\S+(\s+\S+){4}$/.test(v.trim());

const SECRET_KEY =
  /(secret|password|passwd|token|api[-_]?key|authorization|cookie|private[-_]?key|credential|signature)/i;
/** Defence in depth for the execution log view: the API redacts before it stores, and a credential-looking key that arrives anyway is masked again. */
export function maskSecrets(v: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(v)) return v.map((x) => maskSecrets(x, depth + 1));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        SECRET_KEY.test(k) && typeof x === 'string' && x !== '[redacted]'
          ? '[redacted]'
          : maskSecrets(x, depth + 1),
      ]),
    );
  return v;
}
export const prettyJson = (v: unknown): string => {
  try {
    return JSON.stringify(maskSecrets(v), null, 2) ?? '';
  } catch {
    return '';
  }
};

/** Steps grouped by step key, attempts in order, for the timeline. */
export function groupAttempts(
  steps: ExecutionStepDto[],
): { key: string; attempts: ExecutionStepDto[] }[] {
  const out: { key: string; attempts: ExecutionStepDto[] }[] = [];
  for (const s of steps) {
    const g = out.find((x) => x.key === s.stepKey);
    if (g) g.attempts.push(s);
    else out.push({ key: s.stepKey, attempts: [s] });
  }
  for (const g of out) g.attempts.sort((a, b) => a.attempt - b.attempt);
  return out;
}
export const durationMs = (a: string | null, b: string | null): number | null =>
  a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null;

/* ------------------------------------------------------------------ marketplace */

export const LISTING_TYPES = ['website-template', 'app-template', 'workflow-template'] as const;
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Artifact references live in the publisher's own namespace (the API refuses anything else). */
export const artifactPrefix = (orgId: string) => `artifact://${orgId}/`;
/** Latest approved version of a listing (the API lists versions newest first). */
export const latestApproved = (l: Pick<ListingDto, 'versions'>): VersionDto | null =>
  l.versions.find((v) => v.moderationStatus === 'approved') ?? null;
export function scanSummary(
  v: VersionDto,
): { verdict: string; block: number; warn: number } | null {
  if (!v.scan) return null;
  const f = v.scan.findings ?? [];
  return {
    verdict: v.scan.verdict,
    block: f.filter((x) => x.severity === 'block').length,
    warn: f.filter((x) => x.severity === 'warn').length,
  };
}

/* ------------------------------------------------------------------ agency: delegable catalogue and grant expiry */

/**
 * The delegable-scope catalogue. NOT served by the API (there is no catalogue endpoint): this is the list in `apps/api/src/modules/programs/internal/delegation.ts`
 * (DELEGABLE_SCOPES); the API re-validates every grant (422 `scopes_not_delegable`), so a stale copy can only make the picker show too much or too little, never widen access.
 */
export const DELEGABLE_SCOPES = [
  'automation:read',
  'automation:write',
  'automation:run',
  'hosting:site:read',
  'hosting:site:create',
  'hosting:site:update',
  'hosting:backup:read',
  'hosting:backup:create',
  'hosting:domain:manage',
  'hosting:ssl:manage',
  'hosting:plan:read',
  'domain:read',
  'domain:search',
  'dns:read',
  'dns:write',
  'project:read',
  'workspace:read',
  'resource:read',
  'usage:read',
  'email:read',
  'offers:read',
  'quote:read',
  'marketplace:read',
  'operation:read',
] as const;
export const DEFAULT_GRANT_DAYS = 90;
export const MAX_GRANT_DAYS = 365;
export const MIN_GRANT_MINUTES = 15;
const DAY = 86_400_000;
/** `YYYY-MM-DD` of `now + days` (UTC), for a date input. */
export const dateIn = (days: number, now = Date.now()) =>
  new Date(now + days * DAY).toISOString().slice(0, 10);
/** The expiry the API receives for a chosen day: the end of that day (UTC). */
export const expiryOf = (day: string) => `${day}T23:59:59.000Z`;
export type ExpiryCheck = 'ok' | 'missing' | 'invalid' | 'too_soon' | 'too_far';
export function checkExpiry(day: string, now = Date.now()): ExpiryCheck {
  if (!day) return 'missing';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'invalid';
  const at = Date.parse(expiryOf(day));
  if (Number.isNaN(at)) return 'invalid';
  if (at < now + MIN_GRANT_MINUTES * 60_000) return 'too_soon';
  if (at > now + MAX_GRANT_DAYS * DAY) return 'too_far';
  return 'ok';
}
export const grantLive = (g: Pick<GrantDto, 'status' | 'expiresAt'>, now = Date.now()) =>
  g.status === 'active' && Date.parse(g.expiresAt) > now;
/** Clients a member may act in: an ACTIVE link and an active, unexpired grant carrying the scope. */
export function actingClients(
  links: LinkDto[],
  grants: GrantDto[],
  now = Date.now(),
): { clientOrgId: string; scopes: string[]; expiresAt: string }[] {
  const out: { clientOrgId: string; scopes: string[]; expiresAt: string }[] = [];
  for (const l of links) {
    if (l.status !== 'active') continue;
    const live = grants.filter((g) => g.clientOrgId === l.clientOrgId && grantLive(g, now));
    if (live.length === 0) continue;
    out.push({
      clientOrgId: l.clientOrgId,
      scopes: [...new Set(live.flatMap((g) => g.scopes))].sort(),
      expiresAt: live
        .map((g) => g.expiresAt)
        .sort()
        .at(-1)!,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ reseller: markup arithmetic (display only; the API is the authority) */

/**
 * Percentage text ("12.5") to basis points; a negative value is kept negative so the caller can block it as below cost. Null when it is not a percentage with at most two decimals.
 */
export function percentToBps(text: string): number | null {
  const m = /^(-?)(\d{1,4})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -bps : bps;
}
export const bpsToPercent = (bps: number) => `${bps / 100}`;
/** A markup that would sell below the wholesale cost: refused by the API with `below_cost`, and blocked here before sending. */
export const isBelowCost = (m: Markup): boolean =>
  m.type === 'percent' ? m.bps < 0 : m.amountMinor.trim().startsWith('-');
/** retail = wholesale + markup, in integer minor units (percent: floor; fixed: per unit, quantity 1 in the preview). Null for an invalid figure. */
export function retailPreview(wholesaleMinor: string, m: Markup, quantity = 1n): string | null {
  if (!/^\d{1,15}$/.test(wholesaleMinor)) return null;
  const w = BigInt(wholesaleMinor);
  if (m.type === 'percent') {
    if (!Number.isInteger(m.bps)) return null;
    return (w + (w * BigInt(m.bps)) / 10_000n).toString();
  }
  if (!/^-?\d{1,15}$/.test(m.amountMinor)) return null;
  return (w + BigInt(m.amountMinor) * quantity).toString();
}
export const marginPreview = (wholesaleMinor: string, m: Markup): string | null => {
  const r = retailPreview(wholesaleMinor, m);
  return r === null ? null : (BigInt(r) - BigInt(wholesaleMinor)).toString();
};
/** Earliest accepted effective date: the API wants at least one day ahead; the input offers `now + 2 days`. */
export const defaultEffectiveFrom = (now = Date.now()) => dateIn(2, now);
export const effectiveFromIso = (day: string) => `${day}T00:00:00.000Z`;
export const effectiveFromOk = (day: string, now = Date.now()) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) && Date.parse(effectiveFromIso(day)) >= now + DAY;
export const SCOPE_KEY = /^[a-z][a-z0-9_.-]{0,119}$/;

/** The statement's issuer banner: `enabled` never occurs while D-24 is open; anything but `enabled` is shown as blocked/disabled. */
export const issuerBlocked = (i: Pick<StatementDto['issuer'], 'status'>) => i.status !== 'enabled';
/** `YYYY-MM` of the previous month (the API default period). */
export function previousPeriod(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
export const validPeriod = (v: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
