/**
 * Pure helpers and hand-typed API shapes of the admin provider and cloud screens (UI-M05-08..15). No I/O: unit-tested in
 * `providers.spec.ts`.
 *
 * Types marked "mirrors" copy the OpenAPI of the S17 branch (routing rules, resources) and of the provider-cost and live-verification
 * endpoints added in this stream. They are replaced by SDK types once those branches are merged and `pnpm sdk:generate` has run.
 * The S16 shapes (providers, accounts, capability matrix, regions, plans, jobs) come from the SDK itself.
 */
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import type { Schemas } from '@nuzm/sdk';

export type Tone = 'success' | 'warn' | 'danger' | undefined;

export type ProviderDto = Schemas['Provider'];
export type AccountDto = Schemas['ProviderAccount'];
export type JobDto = Schemas['ProviderJob'];
export type CapabilityRow = Schemas['CapabilityMatrix']['items'][number];
export type RegionRow = Schemas['ProviderRegionList']['items'][number];
export type PlanRow = Schemas['ProviderPlanList']['items'][number];

/** Mirrors S17 `RoutingRule`. */
export interface RoutingRuleDto {
  id: string;
  ruleKey: string;
  version: number;
  priority: number;
  match: { country?: string[]; geoGroup?: string[]; mode?: string };
  action: { type?: string; providerKey?: string; accountId?: string; providerRegionId?: string };
  enabled: boolean;
  note?: string | null;
  createdAt?: string;
}
/** Mirrors S17 `CloudResource`. */
export interface CloudResourceDto {
  id: string;
  orgId: string;
  kind: string;
  providerAccountId: string;
  providerKey?: string | null;
  providerRef?: string | null;
  state: string;
  dataRegion: string;
  country: string;
  providerRegionId: string;
  driftState: string;
  lastSeenAt?: string | null;
  caseOpenedAt?: string | null;
  caseDetail?: Record<string, unknown> | null;
  createdAt?: string;
}
/** Mirrors the S17 `AdminOfferList` item: the data of the routing dry run. */
export interface AdminOfferDto {
  offerId?: string;
  country?: string;
  dataRegion?: string;
  provider?: { key?: string } & Record<string, unknown>;
  providerRegionId?: string;
  planRef?: string;
  plan?: { vcpu?: number; memoryMb?: number; diskGb?: number };
  price?: { amount?: string; currency?: string; period?: string };
  evidenceKind?: string | null;
  eligible?: boolean;
  failures?: string[];
}
/** Mirrors `GET /v1/admin/provider-costs` (amounts are integer minor units in strings). */
export interface ProviderCostDto {
  id: string;
  providerAccountId: string;
  providerKey: string;
  resourceId: string | null;
  orgId: string | null;
  periodStart: string;
  periodEnd: string;
  meterOrSku: string;
  quantity: string;
  costMinor: string;
  currency: string;
  source: 'api' | 'bill_import';
  providerLineRef: string;
  capturedAt: string;
}
export interface ProviderCostPage {
  items: ProviderCostDto[];
  nextCursor: string | null;
  totals: { currency: string; costMinor: string; records: number; unattributed: number }[];
}
export type LvLabel = 'NOT RUN' | 'NOT VERIFIED' | 'LIVE-VERIFIED' | 'FAIL';
/** Mirrors `GET /v1/admin/live-verification`. READ-ONLY: live verification is started by a human outside this product. */
export interface LvJob {
  jobId: string;
  provider: string;
  gate: string;
  gateStatus: 'PENDING' | 'GRANTED';
  label: LvLabel;
  lastRunAt: string | null;
}
export interface LvRun {
  id: string;
  jobId: string;
  status: LvLabel;
  reason: string;
  steps: { step: string; status: 'pass' | 'fail' | 'skipped'; detail?: string }[];
  evidenceIds: string[];
  gateEvidenceId: string | null;
  spendCapMinor: string | null;
  currency: string | null;
  residualResources: number;
  createdAt: string;
}
export interface LiveVerification {
  jobs: LvJob[];
  runs: LvRun[];
}

// ---- loosely typed client for endpoints the SDK does not know yet --------------------------------------------------------------

export interface LooseInit {
  params?: {
    query?: Record<string, string | number | boolean | undefined>;
    path?: Record<string, string>;
  };
  body?: unknown;
  headers?: Record<string, string>;
}
export interface LooseResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}
export interface LooseClient {
  GET<T>(path: string, init?: LooseInit): Promise<LooseResult<T>>;
  POST<T>(path: string, init?: LooseInit): Promise<LooseResult<T>>;
}
/**
 * The SDK client resolves any path at run time; only its generated types are missing for the S17 / cost / live-verification endpoints.
 * This narrow view lets the pages call them with hand-typed results until the SDK is regenerated.
 */
export const loose = (api: unknown): LooseClient => api as LooseClient;

/** A fresh `Idempotency-Key` for one user-visible attempt (a double click replays it; a new attempt gets a new key). */
export const newKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ---- shared small helpers ---------------------------------------------------------------------------------------------------------

export const isUuid = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
export const shortId = (id: string): string => id.slice(0, 8);
export const REGION_GROUPS = ['in_kingdom', 'gcc', 'eu', 'other'] as const;

/** Comma / semicolon / whitespace separated ISO 3166 alpha-2 list; null when an entry is not a two-letter code. */
export function parseCountries(input: string): string[] | null {
  const parts = input
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.every((c) => /^[A-Za-z]{2}$/.test(c))
    ? [...new Set(parts.map((c) => c.toUpperCase()))]
    : null;
}

/** `YYYY-MM` and a real month. */
export const isPeriod = (v: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** Cursor-page query that keeps the active filters; empty values are dropped. */
export function pageQuery(filters: Record<string, string | undefined>, cursor: string): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  p.set('cursor', cursor);
  return `?${p.toString()}`;
}

// ---- money: integer minor units as strings, never floats ------------------------------------------------------------------

const ZERO_DIGITS = new Set(['JPY', 'KRW', 'VND']);
const THREE_DIGITS = new Set(['KWD', 'BHD', 'OMR']);
export const currencyDigits = (currency: string): number =>
  ZERO_DIGITS.has(currency) ? 0 : THREE_DIGITS.has(currency) ? 3 : 2;

/**
 * Integer minor-unit string → "1,234.56 CNY" by string arithmetic only. Provider bills come in the vendor's own currency (CNY, USD, EUR,
 * THB, ...), so this accepts any ISO code and never converts. Not an integer string → the raw text (never throws, never guesses).
 */
export function formatCost(minor: string, currency: string): string {
  if (!/^-?\d+$/.test(minor)) return minor;
  const neg = minor.startsWith('-');
  const digits = currencyDigits(currency);
  const s = (neg ? minor.slice(1) : minor).padStart(digits + 1, '0');
  const whole = digits === 0 ? s : s.slice(0, -digits);
  const frac = digits === 0 ? '' : `.${s.slice(-digits)}`;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac} ${currency}`;
}
export const isNegativeMinor = (v: unknown): boolean => typeof v === 'string' && /^-\d+$/.test(v);

// ---- credentials: vault references only ----------------------------------------------------------------------------------------

/** What the form accepts: a `vault://` reference. Anything else (a key, a secret, a token) is refused before a request is made. */
export const VAULT_REF = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._~/:@-]{0,200}$/;
export const isVaultRef = (v: string): boolean => VAULT_REF.test(v.trim());
/** A reference that is safe to show; anything that is not a vault reference is never rendered (defence in depth: it could be a value). */
export const safeCredentialRef = (v: unknown): string | null =>
  typeof v === 'string' && isVaultRef(v) ? v.trim() : null;

// ---- problem+json -> message key ---------------------------------------------------------------------------------------------------

export interface Problem {
  code?: string;
  detail?: string;
  traceId?: string;
}
export const problemCode = (p: unknown): string | undefined => (p as Problem | null)?.code;

/** Codes that have their own localized text on these screens; anything else falls back to its HTTP status. */
export const PROBLEM_CODES = [
  'credential_value_rejected',
  'unsupported_capability',
  'adapter_not_available',
  'invalid_filter',
  'validation_failed',
  'conflict',
  'not_found',
  'precondition_failed',
  'precondition_required',
  'idempotency_in_progress',
  'idempotency_key_reuse',
  'rate_limited',
  'service_unavailable',
  'forbidden',
] as const;

/** Localized message of a failed provider call: by problem `code`, then by HTTP status, then a generic one. */
export function problemMessage(locale: Locale, code: string | undefined, status: number): string {
  if (code && (PROBLEM_CODES as readonly string[]).includes(code))
    return tDynamic(locale, `m05.adm.err.${code}`, t(locale, 'state.error.title'));
  if (status === 403) return t(locale, 'state.forbidden.title');
  if (status === 404) return t(locale, 'm05.adm.err.not_found');
  if (status === 409) return t(locale, 'm05.adm.err.conflict');
  if (status === 422) return t(locale, 'm05.adm.err.validation_failed');
  return t(locale, 'state.error.title');
}
/** The server's English explanation is hidden for a rejected credential: it must never echo what was typed. */
export const showServerDetail = (code: string | undefined): boolean =>
  code !== 'credential_value_rejected';

// ---- providers, health, circuit breaker --------------------------------------------------------------------------------------------

export type BreakerState = 'closed' | 'open' | 'half_open' | 'unknown';
/** The breaker snapshot is an open object in the API; only `state` is read and anything unexpected is `unknown`. */
export function breakerState(breaker: unknown): BreakerState {
  const s = (breaker as { state?: unknown } | null | undefined)?.state;
  return s === 'closed' || s === 'open' || s === 'half_open' ? s : 'unknown';
}
export const breakerTone = (s: BreakerState): Tone =>
  s === 'open' ? 'danger' : s === 'half_open' ? 'warn' : s === 'closed' ? 'success' : undefined;
export const healthTone = (s: string | undefined): Tone =>
  s === 'healthy'
    ? 'success'
    : s === 'degraded'
      ? 'warn'
      : s === 'unhealthy'
        ? 'danger'
        : undefined;

/** Worst circuit state over a provider's accounts (open > half_open > closed > unknown). */
export function worstBreaker(accounts: readonly Pick<AccountDto, 'health'>[]): BreakerState {
  const rank: Record<BreakerState, number> = { open: 3, half_open: 2, closed: 1, unknown: 0 };
  return accounts.reduce<BreakerState>((w, a) => {
    const b = breakerState(a.health?.breaker);
    return rank[b] > rank[w] ? b : w;
  }, 'unknown');
}
/** Accounts that have never passed a verification run: nothing about them is established. */
export const unverifiedAccounts = (accounts: readonly Pick<AccountDto, 'verifiedAt'>[]): number =>
  accounts.filter((a) => !a.verifiedAt).length;

// ---- capability matrix: unknown is unsupported --------------------------------------------------------------------------------------

export type CapabilityView = 'supported' | 'unsupported';
/** `unknown` (and anything unexpected) is shown as, and treated as, unsupported. Only an explicit `supported` is supported. */
export const capabilityView = (state: string): CapabilityView =>
  state === 'supported' ? 'supported' : 'unsupported';
/** Supported is only highlighted when the probe left evidence; supported without evidence is a warning, never plain success. */
export const capabilityTone = (c: Pick<CapabilityRow, 'state' | 'evidenceRef'>): Tone =>
  capabilityView(c.state) === 'supported' ? (c.evidenceRef ? 'success' : 'warn') : undefined;

// ---- regions: verified only with live evidence ----------------------------------------------------------------------------------------

export type RegionVerification = 'verified_live' | 'not_verified' | 'listed' | 'withdrawn';
/**
 * A region is "verified" only when the API says verified AND the evidence is live, with a reference and a time. Verified on fixture or mock
 * evidence (or on evidence of an unknown kind) is NOT VERIFIED: a green badge for it would be a claim nobody has evidence for.
 */
export function regionVerification(
  r: Pick<RegionRow, 'state' | 'evidenceKind' | 'evidenceRef' | 'verifiedAt'>,
): RegionVerification {
  if (r.state === 'withdrawn') return 'withdrawn';
  if (r.state === 'verified')
    return r.evidenceKind === 'live' && !!r.evidenceRef && !!r.verifiedAt
      ? 'verified_live'
      : 'not_verified';
  return 'listed';
}
export const regionTone = (v: RegionVerification): Tone =>
  v === 'verified_live'
    ? 'success'
    : v === 'not_verified' || v === 'withdrawn'
      ? 'warn'
      : undefined;
/** The evidence kind badge: live is the only kind that is ever green. */
export const evidenceKindTone = (k: string | null | undefined): Tone =>
  k === 'live' ? 'success' : k === 'fixture' || k === 'mock' ? 'warn' : undefined;

// ---- jobs --------------------------------------------------------------------------------------------------------------------------

const JOB_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
export const jobDone = (state: string): boolean => JOB_TERMINAL.has(state);
export const jobTone = (state: string): Tone =>
  state === 'succeeded'
    ? 'success'
    : state === 'failed' || state === 'cancelled'
      ? 'danger'
      : state === 'needs_reconcile'
        ? 'warn'
        : undefined;
/** `error.code` of a failed job, when the API gave one. */
export const jobErrorCode = (j: Pick<JobDto, 'error'>): string | undefined => {
  const c = (j.error as { code?: unknown } | null | undefined)?.code;
  return typeof c === 'string' ? c : undefined;
};
/** Poll schedule: 1 s, doubling to 8 s, up to a 5 minute ceiling; `null` when the budget is spent. */
export function pollDelay(attempt: number): number | null {
  const ms = Math.min(8000, 1000 * 2 ** attempt);
  const spent = Array.from({ length: attempt }, (_, i) => Math.min(8000, 1000 * 2 ** i)).reduce(
    (a, b) => a + b,
    0,
  );
  return spent >= 300_000 ? null : ms;
}

// ---- routing -----------------------------------------------------------------------------------------------------------------------

export const RULE_ACTIONS = ['prefer', 'exclude', 'pin'] as const;
export const RULE_MODES = ['explicit', 'automatic'] as const;

export interface RuleForm {
  ruleKey: string;
  priority: string;
  countries: string;
  geoGroups: string[];
  mode: string;
  actionType: string;
  providerKey: string;
  accountId: string;
  providerRegionId: string;
  note: string;
  enabled: boolean;
}
export const emptyRule = (): RuleForm => ({
  ruleKey: '',
  priority: '100',
  countries: '',
  geoGroups: [],
  mode: '',
  actionType: 'prefer',
  providerKey: '',
  accountId: '',
  providerRegionId: '',
  note: '',
  enabled: true,
});
export const ruleKeyOk = (k: string): boolean => /^[a-z][a-z0-9_.:-]{2,80}$/.test(k.trim());

/** Rule form → API body, or the list of field names that are invalid (an action needs a provider, account or region). */
export function toRuleBody(f: RuleForm): { body: Record<string, unknown> } | { invalid: string[] } {
  const invalid: string[] = [];
  if (!ruleKeyOk(f.ruleKey)) invalid.push('ruleKey');
  if (!/^-?\d{1,6}$/.test(f.priority.trim())) invalid.push('priority');
  const countries = f.countries.trim() === '' ? [] : parseCountries(f.countries);
  if (countries === null) invalid.push('countries');
  if (!(RULE_ACTIONS as readonly string[]).includes(f.actionType)) invalid.push('actionType');
  if (f.mode !== '' && !(RULE_MODES as readonly string[]).includes(f.mode)) invalid.push('mode');
  if (f.accountId.trim() && !isUuid(f.accountId)) invalid.push('accountId');
  if (!f.providerKey.trim() && !f.accountId.trim() && !f.providerRegionId.trim())
    invalid.push('target');
  if (invalid.length) return { invalid };
  return {
    body: {
      ruleKey: f.ruleKey.trim(),
      priority: Number(f.priority.trim()),
      match: {
        ...(countries && countries.length ? { country: countries } : {}),
        ...(f.geoGroups.length ? { geoGroup: f.geoGroups } : {}),
        ...(f.mode ? { mode: f.mode } : {}),
      },
      action: {
        type: f.actionType,
        ...(f.providerKey.trim() ? { providerKey: f.providerKey.trim() } : {}),
        ...(f.accountId.trim() ? { accountId: f.accountId.trim().toLowerCase() } : {}),
        ...(f.providerRegionId.trim() ? { providerRegionId: f.providerRegionId.trim() } : {}),
      },
      enabled: f.enabled,
      ...(f.note.trim() ? { note: f.note.trim() } : {}),
    },
  };
}
/** An existing rule → form (a change is a new version of the same key). */
export function ruleToForm(r: RoutingRuleDto): RuleForm {
  return {
    ruleKey: r.ruleKey,
    priority: String(r.priority),
    countries: (r.match.country ?? []).join(', '),
    geoGroups: r.match.geoGroup ?? [],
    mode: r.match.mode ?? '',
    actionType: r.action.type ?? 'prefer',
    providerKey: r.action.providerKey ?? '',
    accountId: r.action.accountId ?? '',
    providerRegionId: r.action.providerRegionId ?? '',
    note: r.note ?? '',
    enabled: r.enabled,
  };
}
/** Evaluation order of the router: priority ascending, then rule key. Pure: returns a new array. */
export const sortRules = <T extends Pick<RoutingRuleDto, 'priority' | 'ruleKey'>>(
  rules: T[],
): T[] => [...rules].sort((a, b) => a.priority - b.priority || a.ruleKey.localeCompare(b.ruleKey));

export interface SimRequest {
  mode: 'explicit' | 'automatic';
  country?: string;
  geoGroup?: string;
}
/**
 * Enabled rules whose match conditions fit a request (preview only: the server applies rules to candidate offers when it quotes; this
 * shows which rules are in play, in evaluation order).
 */
export function matchingRules(rules: readonly RoutingRuleDto[], req: SimRequest): RoutingRuleDto[] {
  return sortRules(rules.filter((r) => r.enabled)).filter((r) => {
    if (r.match.mode && r.match.mode !== req.mode) return false;
    if (
      r.match.country?.length &&
      (!req.country ||
        !r.match.country.map((c) => c.toUpperCase()).includes(req.country.toUpperCase()))
    )
      return false;
    if (r.match.geoGroup?.length && (!req.geoGroup || !r.match.geoGroup.includes(req.geoGroup)))
      return false;
    return true;
  });
}
/** Offers of the dry run split into the ones that would be chosen from and the ones a condition removed (with the failing conditions). */
export function splitOffers(offers: readonly AdminOfferDto[]) {
  return {
    eligible: offers.filter((o) => o.eligible !== false),
    ineligible: offers.filter((o) => o.eligible === false),
  };
}

// ---- resources and operations ---------------------------------------------------------------------------------------------------------

export const DRIFT_STATES = ['in_sync', 'drift', 'orphan_suspected', 'missing'] as const;
export const RESOURCE_STATES = [
  'DRAFT',
  'QUOTED',
  'AWAITING_PAYMENT',
  'PROVISIONING',
  'ACTIVE',
  'FAILED',
  'DELETING',
  'DELETED',
  'UNKNOWN',
] as const;
export const driftTone = (s: string): Tone =>
  s === 'in_sync'
    ? 'success'
    : s === 'drift'
      ? 'warn'
      : s === 'orphan_suspected' || s === 'missing'
        ? 'danger'
        : undefined;
export const resourceStateTone = (s: string): Tone =>
  s === 'ACTIVE'
    ? 'success'
    : s === 'FAILED' || s === 'UNKNOWN'
      ? 'danger'
      : s === 'PROVISIONING' || s === 'DELETING'
        ? 'warn'
        : undefined;

/** An operation counts as stuck when a resource sits in a transitional state for longer than this (PROPOSAL, minutes). */
export const STUCK_AFTER_MINUTES = 30;
export type OperationClass = 'needs_reconcile' | 'stuck' | 'in_progress' | 'settled';
/**
 * The S17 API has no admin list of platform operations, so the monitor classifies resources by what they say:
 * UNKNOWN = the provider outcome is uncertain (needs_reconcile); PROVISIONING / DELETING older than the threshold = stuck.
 */
export function classifyResource(
  r: Pick<CloudResourceDto, 'state' | 'createdAt'>,
  now: Date,
  stuckAfterMinutes = STUCK_AFTER_MINUTES,
): OperationClass {
  if (r.state === 'UNKNOWN') return 'needs_reconcile';
  if (r.state === 'PROVISIONING' || r.state === 'DELETING') {
    const created = r.createdAt ? Date.parse(r.createdAt) : NaN;
    return Number.isFinite(created) && now.getTime() - created > stuckAfterMinutes * 60_000
      ? 'stuck'
      : 'in_progress';
  }
  return 'settled';
}
export const operationClassTone = (c: OperationClass): Tone =>
  c === 'needs_reconcile' ? 'danger' : c === 'stuck' ? 'warn' : undefined;
/** Whole minutes between an ISO instant and now (never negative); null for a missing or invalid instant. */
export function ageMinutes(iso: string | null | undefined, now: Date): number | null {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.floor((now.getTime() - ms) / 60_000)) : null;
}

// ---- provider costs and RC-04 ----------------------------------------------------------------------------------------------------------

/** A cost record that no organization or resource owns: cannot be re-billed or matched to the ledger, so it is highlighted. */
export const isUnattributed = (c: Pick<ProviderCostDto, 'orgId' | 'resourceId'>): boolean =>
  c.orgId === null || c.resourceId === null;
/** Total records and unattributed records over all currencies (totals never sum across currencies). */
export function costSummary(totals: ProviderCostPage['totals']) {
  return {
    records: totals.reduce((n, x) => n + x.records, 0),
    unattributed: totals.reduce((n, x) => n + x.unattributed, 0),
  };
}
/** An RC-04 run is a variance when it found breaks, and an open variance while any is unresolved. */
export function runVariance(r: {
  status: string;
  breaksCount: number;
  openBreaks: number;
}): 'none' | 'resolved' | 'open' {
  if (r.status !== 'completed' || r.breaksCount === 0) return 'none';
  return r.openBreaks > 0 ? 'open' : 'resolved';
}
/** RC-04 compares provider bills only once an adapter supplies them: a run may report it skipped the comparison. */
export function runSkipped(summary: unknown): boolean {
  const s = summary as { skipped?: unknown; status?: unknown } | null | undefined;
  return !!s && (s.skipped === true || typeof s.skipped === 'string' || s.status === 'skipped');
}

// ---- live verification -----------------------------------------------------------------------------------------------------------------

export const LV_LABELS: readonly LvLabel[] = ['NOT RUN', 'NOT VERIFIED', 'LIVE-VERIFIED', 'FAIL'];
export const LV_GATES = ['HG-05-01', 'HG-05-02', 'HG-05-03'] as const;
export type LvKey = 'not_run' | 'not_verified' | 'live_verified' | 'fail';
export const lvKey = (label: LvLabel): LvKey =>
  label === 'NOT RUN'
    ? 'not_run'
    : label === 'LIVE-VERIFIED'
      ? 'live_verified'
      : label === 'FAIL'
        ? 'fail'
        : 'not_verified';
/**
 * The label a run may carry. LIVE-VERIFIED needs recorded evidence ids AND a gate evidence id; without them the run is shown as
 * NOT VERIFIED however it is labelled (CLAUDE.md §5: never claim live verification without evidence). Unknown labels become NOT VERIFIED.
 */
export function effectiveRunLabel(
  r: Pick<LvRun, 'status' | 'evidenceIds' | 'gateEvidenceId'>,
): LvLabel {
  if (r.status === 'LIVE-VERIFIED')
    return r.evidenceIds.length > 0 && r.gateEvidenceId ? 'LIVE-VERIFIED' : 'NOT VERIFIED';
  return LV_LABELS.includes(r.status) ? r.status : 'NOT VERIFIED';
}
/** The label of a job row: LIVE-VERIFIED only while its gate is granted. */
export function effectiveJobLabel(j: Pick<LvJob, 'label' | 'gateStatus'>): LvLabel {
  if (j.label === 'LIVE-VERIFIED')
    return j.gateStatus === 'GRANTED' ? 'LIVE-VERIFIED' : 'NOT VERIFIED';
  return LV_LABELS.includes(j.label) ? j.label : 'NOT VERIFIED';
}
export const lvTone = (l: LvLabel): Tone =>
  l === 'LIVE-VERIFIED'
    ? 'success'
    : l === 'FAIL'
      ? 'danger'
      : l === 'NOT VERIFIED'
        ? 'warn'
        : undefined;
export const stepTone = (s: string): Tone =>
  s === 'pass' ? 'success' : s === 'fail' ? 'danger' : undefined;
