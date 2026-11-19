/**
 * Types, pure helpers and a small fetch wrapper for the compute screens (UI-M05-01..07, 16).
 *
 * The types below are hand-written and mirror the S17 OpenAPI contract (commit f88b8ec on the M05 provider-core branch:
 * /v1/offers, /v1/quotes kind=compute, /v1/compute/instances..., /v1/operations/{id}). That branch is not merged into this tree,
 * so `@nuzm/sdk` has no generated types for it yet. TODO(M05 merge): replace these with `Schemas[...]` from the SDK and delete the wrapper.
 *
 * Customers never see provider identity or provider region ids: none of those fields exist in these types and no screen renders one.
 */
import { ApiError } from '@nuzm/sdk';
import { formatMinor, type Locale, type MessageKey } from '@nuzm/i18n';

export const CLOUD_FLAG = 'cloud.provisioning';
/** Proposed key (M11 owns the real one): the agency compute view stays hidden until delegation is switched on. */
export const AGENCY_DELEGATION_FLAG = 'agency.delegation';

export type Tone = 'success' | 'warn' | 'danger' | undefined;

/** `me.featureFlags` is an untyped object: only a literal `true` switches a capability on (default OFF). */
export const flagOn = (flags: unknown, key: string): boolean =>
  typeof flags === 'object' && flags !== null && (flags as Record<string, unknown>)[key] === true;

// ---- contract types (mirror S17) --------------------------------------------------------------------------------------------

export interface ComputePlan {
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  bandwidth?: string;
}
export interface Offer {
  offerId: string;
  kind: 'compute';
  /** The Nuzm Cloud product line (nova, atlas, orbit, spark): a Nuzm name only, never infrastructure identity. Absent on older API versions. */
  family?: string;
  country: string;
  dataRegion: string;
  plan: ComputePlan;
  price: { amount: string; currency: string; period: 'month' };
  capabilities: string[];
  verifiedAt: string | null;
}
export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}
export type InstanceStatus =
  'provisioning' | 'running' | 'stopped' | 'failed' | 'deleting' | 'deleted' | 'unknown';
export type DriftState = 'in_sync' | 'drift' | 'orphan_suspected' | 'missing';
export interface Instance {
  id: string;
  name: string;
  status: InstanceStatus | string;
  dataRegion: string;
  country: string;
  plan: ComputePlan;
  publicIps: string[];
  createdAt: string;
  capabilities: string[];
  operationId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
  tags?: Record<string, string>;
  deletionProtected?: boolean;
  driftState: DriftState | string;
  version: number;
}
export interface QuoteLine {
  position: number;
  description: string;
  quantity: string;
  unit: string;
  unitPriceMinor: string | null;
  amountMinor: string;
}
export interface Quote {
  id: string;
  kind: string;
  status: 'issued' | 'expired' | string;
  expiresAt: string;
  currency: string;
  items: QuoteLine[];
  subtotalMinor: string;
  taxEstimate: {
    status: string;
    rateBps: number;
    taxMinor: string;
    note: string;
    reviewRequired?: boolean;
  };
  totalMinor: string;
  requiresApproval: boolean;
  /** compute quotes embed the residency decision (S17); the generic quote only says `not_evaluated`. */
  residency: {
    status?: string;
    decision?: string;
    policyVersion?: number | string;
    dataRegion?: string;
  };
}
export interface OperationView {
  id: string;
  kind: string;
  state: string;
  resourceKind?: string | null;
  resourceId?: string | null;
  attempts: number;
  cancelRequested: boolean;
  traceId?: string | null;
  result?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
}

// ---- money --------------------------------------------------------------------------------------------------------------------

/**
 * Integer minor units + currency for display. `formatMinor` knows a few currencies; for any other it throws, so fall back to the
 * integer rendered as a decimal string (string arithmetic only, 2 digits) followed by the currency code. Never a float.
 */
export function moneyText(minor: string, currency: string, locale: Locale): string {
  try {
    return formatMinor(minor, currency, locale);
  } catch {
    if (!/^-?\d+$/.test(minor)) return `— ${currency}`;
    const neg = minor.startsWith('-');
    const s = (neg ? minor.slice(1) : minor).padStart(3, '0');
    return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)} ${currency}`;
  }
}

// ---- offers ----------------------------------------------------------------------------------------------------------------------

export const GEO_GROUPS = ['in_kingdom', 'gcc', 'eu', 'other'] as const;

export interface OfferFilters {
  country?: string;
  geoGroup?: string;
  minVcpu?: number;
  minMemoryMb?: number;
}
export type OfferFilterErrors = Partial<Record<keyof OfferFilters, true>>;

export const one = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
const posInt = (s: string): number | null =>
  /^[1-9]\d{0,8}$/.test(s) ? Number(s) : s === '' ? null : Number.NaN;

/** Search params → validated API filters; invalid entries are dropped and reported so the form can say which field is wrong. */
export function parseOfferFilters(sp: Record<string, string | string[] | undefined>): {
  filters: OfferFilters;
  errors: OfferFilterErrors;
} {
  const filters: OfferFilters = {};
  const errors: OfferFilterErrors = {};
  const country = one(sp.country);
  if (country) {
    if (/^[A-Za-z]{2}$/.test(country)) filters.country = country.toUpperCase();
    else errors.country = true;
  }
  const group = one(sp.geoGroup);
  if (group) {
    if (/^[a-z][a-z_]{0,31}$/.test(group)) filters.geoGroup = group;
    else errors.geoGroup = true;
  }
  for (const k of ['minVcpu', 'minMemoryMb'] as const) {
    const n = posInt(one(sp[k]));
    if (n === null) continue;
    if (Number.isNaN(n)) errors[k] = true;
    else filters[k] = n;
  }
  return { filters, errors };
}

/** Query object for the fetch wrapper: undefined values are skipped. */
export const offerQuery = (
  f: OfferFilters,
  cursor?: string,
  limit = 24,
): Record<string, string | number | undefined> => ({
  kind: 'compute',
  country: f.country,
  geoGroup: f.geoGroup,
  minVcpu: f.minVcpu,
  minMemoryMb: f.minMemoryMb,
  cursor,
  limit,
});

/** Query string for page links (filters + cursor); empty values are omitted. */
export function queryString(q: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const memoryLabel = (mb: number): string =>
  mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;

// ---- capabilities and actions ----------------------------------------------------------------------------------------------

export const ACTION_TYPES = ['start', 'stop', 'reboot', 'resize', 'snapshot'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** `compute.action.stop` and `stop` both mean the stop capability; `compute.metrics` and `metrics` both mean metrics. */
export const normCapability = (c: string): string =>
  c.replace(/^compute\.action\./, '').replace(/^compute\./, '');
export const capabilitySet = (caps: readonly string[] | undefined): Set<string> =>
  new Set((caps ?? []).map(normCapability));

/** The action menu: ONLY the actions in the instance's capability set are offered (unsupported ones are absent, never disabled). */
export const visibleActions = (caps: readonly string[] | undefined): ActionType[] => {
  const set = capabilitySet(caps);
  return ACTION_TYPES.filter((a) => set.has(a));
};
export const supportsMetrics = (caps: readonly string[] | undefined): boolean =>
  capabilitySet(caps).has('metrics');
export const supportsSnapshot = (caps: readonly string[] | undefined): boolean =>
  capabilitySet(caps).has('snapshot');

/** Whether an action makes sense in the current state (the API still answers 409 invalid_state authoritatively). */
export function actionAllowed(type: ActionType, status: string): boolean {
  if (type === 'start') return status === 'stopped';
  if (type === 'stop' || type === 'reboot') return status === 'running';
  return status === 'running' || status === 'stopped';
}

// ---- instance state -----------------------------------------------------------------------------------------------------------

const STATUS_TONES: Record<string, Tone> = {
  running: 'success',
  provisioning: 'warn',
  deleting: 'warn',
  unknown: 'warn',
  failed: 'danger',
  stopped: undefined,
  deleted: undefined,
};
export const statusTone = (status: string): Tone => STATUS_TONES[status.toLowerCase()];
export const driftTone = (drift: string): Tone => (drift === 'in_sync' ? undefined : 'warn');
export const TRANSIENT = new Set(['provisioning', 'deleting']);
export const isTransient = (status: string): boolean => TRANSIENT.has(status.toLowerCase());

/**
 * UNKNOWN / needs_reconcile: the platform is not sure what exists at the provider and is reconciling before it acts again.
 * The state comes from the instance (`unknown`) or from its operation (`needs_reconcile` / `unknown`).
 */
export function isUncertain(
  status: string,
  operationState?: string | null,
  drift?: string | null,
): boolean {
  const ops = (operationState ?? '').toLowerCase();
  return (
    status.toLowerCase() === 'unknown' ||
    ops === 'needs_reconcile' ||
    ops === 'unknown' ||
    drift === 'missing' ||
    drift === 'orphan_suspected'
  );
}

// ---- operation timeline ---------------------------------------------------------------------------------------------------------

export interface TimelineEntry {
  key: string;
  kind: 'created' | 'step' | 'attempts' | 'state' | 'cancel' | 'error';
  /** machine value (step name, state, error code) the view maps to a message */
  value: string;
  at?: string;
  tone?: Tone;
}
export const OP_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const OP_TONES: Record<string, Tone> = {
  succeeded: 'success',
  failed: 'danger',
  cancelled: undefined,
  needs_reconcile: 'warn',
  unknown: 'warn',
  running: 'warn',
  pending: 'warn',
};
export const opTone = (state: string): Tone => OP_TONES[state];

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Timeline of one operation. The S17 operation exposes id/kind/state/attempts/timestamps/error and a free-form `result`; durable
 * steps are read from `steps` or `result.steps` when present (name/state/at) and skipped otherwise. Only the error CODE is shown:
 * detail text is never rendered (it could carry provider wording).
 */
export function timelineOf(op: OperationView): TimelineEntry[] {
  const out: TimelineEntry[] = [
    { key: 'created', kind: 'created', value: op.kind, at: op.createdAt },
  ];
  const raw = (op as unknown as { steps?: unknown }).steps ?? rec(op.result)?.steps;
  if (Array.isArray(raw))
    raw.forEach((s, i) => {
      const r = rec(s);
      const name = str(r?.name) ?? str(r?.step);
      if (!r || !name) return;
      const state = str(r.state) ?? str(r.status) ?? '';
      out.push({
        key: `step-${i}`,
        kind: 'step',
        value: name,
        at: str(r.at) ?? str(r.timestamp),
        tone: opTone(state) ?? undefined,
      });
    });
  if (op.attempts > 1)
    out.push({ key: 'attempts', kind: 'attempts', value: String(op.attempts), at: op.updatedAt });
  if (op.cancelRequested)
    out.push({ key: 'cancel', kind: 'cancel', value: 'cancel', at: op.updatedAt });
  const code = str(rec(op.error)?.code);
  if (code)
    out.push({ key: 'error', kind: 'error', value: code, at: op.updatedAt, tone: 'danger' });
  out.push({
    key: 'state',
    kind: 'state',
    value: op.state,
    at: op.updatedAt,
    tone: opTone(op.state),
  });
  return out;
}

// ---- create wizard -------------------------------------------------------------------------------------------------------------

/** One OpenSSH public key per line. Private keys are rejected on sight: only the public half may ever be sent. */
const SSH_KEY =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]{16,} ?[^\r\n]{0,128}$/;
export function parseSshKeys(input: string): { keys: string[]; invalid: number[] } {
  const keys: string[] = [];
  const invalid: number[] = [];
  input.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (SSH_KEY.test(line)) keys.push(line);
    else invalid.push(i + 1);
  });
  return { keys: [...new Set(keys)], invalid };
}
export const MAX_SSH_KEYS = 10;

export const isImageId = (s: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(s.trim());
export const isInstanceName = (s: string): boolean =>
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(s.trim());
/** Optional disk size in GB: empty → undefined, a positive integer → number, anything else → null (invalid). */
export function parseDiskGb(s: string): number | undefined | null {
  const v = s.trim();
  if (!v) return undefined;
  return /^[1-9]\d{0,5}$/.test(v) ? Number(v) : null;
}

export const isQuoteExpired = (expiresAt: string, nowMs: number): boolean =>
  new Date(expiresAt).getTime() <= nowMs;
export const secondsLeft = (expiresAt: string, nowMs: number): number =>
  Math.max(0, Math.floor((new Date(expiresAt).getTime() - nowMs) / 1000));

export type ResidencyView = 'allowed' | 'denied' | 'not_evaluated' | 'other';
/** The embedded residency result of a compute quote, normalised for display. */
export function residencyOf(q: Pick<Quote, 'residency'>): {
  verdict: ResidencyView;
  raw: string;
  policyVersion?: string;
  dataRegion?: string;
} {
  const raw = q.residency?.decision ?? q.residency?.status ?? '';
  const v = raw.toLowerCase();
  const verdict: ResidencyView = /^(allow|allowed|permit|permitted|ok)$/.test(v)
    ? 'allowed'
    : /^(deny|denied|block|blocked)$/.test(v)
      ? 'denied'
      : v === '' || v === 'not_evaluated'
        ? 'not_evaluated'
        : 'other';
  return {
    verdict,
    raw,
    policyVersion:
      q.residency?.policyVersion === undefined ? undefined : String(q.residency.policyVersion),
    dataRegion: q.residency?.dataRegion,
  };
}

// ---- metrics ---------------------------------------------------------------------------------------------------------------------

export interface SeriesView {
  name: string;
  unit?: string;
  points: number;
  latest?: number;
  min?: number;
  max?: number;
}
/** Metrics series are loosely typed in S17 (`{window, series[]}`): narrow each series defensively (name, unit, points of {value}). */
export function readSeries(raw: unknown): SeriesView[] {
  if (!Array.isArray(raw)) return [];
  const out: SeriesView[] = [];
  for (const s of raw) {
    const r = rec(s);
    if (!r) continue;
    const name = str(r.name) ?? str(r.metric) ?? str(r.id);
    if (!name) continue;
    const values: number[] = [];
    if (Array.isArray(r.points))
      for (const p of r.points) {
        const v = Array.isArray(p) ? p[1] : (rec(p)?.value ?? rec(p)?.v);
        if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
      }
    out.push({
      name,
      unit: str(r.unit),
      points: values.length,
      latest: values.at(-1),
      min: values.length ? Math.min(...values) : undefined,
      max: values.length ? Math.max(...values) : undefined,
    });
  }
  return out;
}

export const METRIC_WINDOWS = ['1h', '24h', '7d'] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];
const WINDOW_MS: Record<MetricWindow, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
};
export const isMetricWindow = (s: string): s is MetricWindow => s in WINDOW_MS;
export function windowRange(w: MetricWindow, now: Date): { from: string; to: string } {
  return { from: new Date(now.getTime() - WINDOW_MS[w]).toISOString(), to: now.toISOString() };
}

// ---- spend approvals recognisable as provisioning (UI-M05-07) --------------------------------------------------------------------

export interface ProvisioningHint {
  /** "2 vCPU · 4 GB" style line from the quote's first item description, when present */
  summary: string;
  totalMinor: string;
  currency: string;
}
/** A quote subject of a spend approval is "provisioning" when the quote is of kind compute. */
export function provisioningHint(q: unknown): ProvisioningHint | null {
  const r = rec(q);
  if (!r || r.kind !== 'compute') return null;
  const first = Array.isArray(r.items) ? rec(r.items[0]) : null;
  const total = str(r.totalMinor);
  const currency = str(r.currency);
  if (!total || !currency || !/^\d+$/.test(total)) return null;
  return { summary: str(first?.description) ?? '', totalMinor: total, currency };
}

// ---- problem+json ----------------------------------------------------------------------------------------------------------------

export interface ComputeProblem {
  status: number;
  code?: string;
  approvalId?: string;
  traceId?: string;
}
const PROBLEM_KEYS: Record<string, MessageKey> = {
  quote_expired: 'm05.web.err.quote_expired',
  quote_consumed: 'm05.web.err.quote_consumed',
  price_changed: 'm05.web.err.price_changed',
  spend_approval_required: 'm05.web.err.spend_approval_required',
  residency_denied: 'm05.web.err.residency_denied',
  quota_exceeded: 'm05.web.err.quota_exceeded',
  unsupported_capability: 'm05.web.err.unsupported_capability',
  invalid_state: 'm05.web.err.invalid_state',
  deletion_protected: 'm05.web.err.deletion_protected',
  no_eligible_offer: 'm05.web.err.no_eligible_offer',
  invalid_filter: 'm05.web.err.invalid_filter',
  idempotency_in_progress: 'm05.web.err.in_progress',
  network_error: 'm05.web.err.network',
};
/** Localised message key for a problem: by code first, then by status (412 stale, 428 missing precondition, 403, 404, 429). */
export function problemKey(p: ComputeProblem): MessageKey {
  if (p.code && PROBLEM_KEYS[p.code]) return PROBLEM_KEYS[p.code]!;
  if (p.status === 412 || p.status === 428) return 'm05.web.err.stale';
  if (p.status === 429) return 'm05.web.err.rate_limited';
  if (p.status === 403) return 'state.forbidden.title';
  if (p.status === 404) return 'm05.web.err.not_found';
  if (p.status === 409) return 'err.conflict';
  if (p.status === 422) return 'err.validation';
  return 'state.error.title';
}

// ---- fetch wrapper ---------------------------------------------------------------------------------------------------------------

export interface CallEnv {
  /** '' in the browser (the app proxies /v1/*), the API origin on the server */
  baseUrl: string;
  /** cookies / org / csrf / realm headers, evaluated per call */
  headers: () => Record<string, string>;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}
export interface CallOptions {
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  /** side-effecting POST/DELETE: generate with crypto.randomUUID() */
  idempotencyKey?: string;
  ifMatch?: string;
}
/** Same shape `useAction().run` expects. `error` is the problem+json body. */
export interface CallResult<T> {
  data?: T;
  error?: { code?: string; approvalId?: string; traceId?: string } & Record<string, unknown>;
  response: Response;
}

/**
 * Never throws: a network failure becomes status 599 `network_error` (an uncertain result: the caller must look before retrying).
 * Mutations carry `Idempotency-Key` (and `If-Match` for delete) as headers.
 */
export async function apiCall<T>(
  env: CallEnv,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  o: CallOptions = {},
): Promise<CallResult<T>> {
  const qs = queryString(o.query ?? {});
  const headers: Record<string, string> = { accept: 'application/json', ...env.headers() };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.idempotencyKey) headers['idempotency-key'] = o.idempotencyKey;
  if (o.ifMatch) headers['if-match'] = o.ifMatch;
  try {
    const response = await (env.fetch ?? fetch)(`${env.baseUrl}${path}${qs}`, {
      method,
      headers,
      credentials: env.credentials,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      cache: 'no-store',
    });
    const text = response.status === 204 ? '' : await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return response.ok
      ? { data: json as T, response }
      : { error: (rec(json) ?? {}) as CallResult<T>['error'], response };
  } catch {
    return {
      error: { code: 'network_error' },
      response: new Response(null, { status: 599, statusText: 'network_error' }),
    };
  }
}

export const problemOf = (r: CallResult<unknown>): ComputeProblem => ({
  status: r.response.status,
  code: str(r.error?.code),
  approvalId: str(r.error?.approvalId),
  traceId: str(r.error?.traceId) ?? r.response.headers.get('x-trace-id') ?? undefined,
});

/** Server side: turn a failed call into the ApiError the shared `view()` already knows how to render. */
export async function unwrapCall<T>(p: Promise<CallResult<T>>): Promise<T> {
  const r = await p;
  if (r.response.ok) return r.data as T;
  const e = problemOf(r);
  throw new ApiError(
    e.status,
    e.code ?? 'unknown_error',
    undefined,
    e.traceId,
    undefined,
    (r.error ?? {}) as Record<string, unknown>,
  );
}

/** A UUID (any version), as it appears in route params. */
export const isUuid = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
