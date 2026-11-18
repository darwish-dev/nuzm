/** Pure helpers of the admin AI screens (UI-M09-12 model providers, UI-M09-13 run oversight, UI-M09-14 quality). No I/O: unit-tested in `ai.spec.ts`. */

/* ------------------------------------------------------------------ model providers */

export type Tri = boolean | 'unknown';
export interface ProviderRow {
  id: string;
  code: string;
  adapter: string;
  displayName: string;
  region: string;
  dataTerms: Record<string, unknown>;
  attestationRef?: string | null;
  vaultRef?: string | null;
  rateCardVersion?: string;
  rateCard?: Record<string, unknown>;
  enabled: boolean;
  enableRequestedBy?: string | null;
  enabledBy?: string | null;
  adapterRegistered: boolean;
  version: number;
}

/** A dev-reference provider (mock-*, local-*) exists only outside production and needs no attestation or second person: a stand-in, NOT VERIFIED. */
export const isDevReference = (code: string): boolean => /^(mock|local)-/.test(code);

const tri = (v: unknown): Tri => (v === true || v === false ? v : 'unknown');

/** What the stored data terms say, safely read. Anything not stated is "unknown", never a guess. */
export function termsOf(p: Pick<ProviderRow, 'dataTerms'>): {
  attested: boolean;
  retainsPrompts: Tri;
  trainsOnData: Tri;
  processingRegion?: string;
} {
  const d = p.dataTerms ?? {};
  return {
    attested: d.attested === true,
    retainsPrompts: tri(d.retainsPrompts),
    trainsOnData: tri(d.trainsOnData),
    ...(typeof d.processingRegion === 'string' ? { processingRegion: d.processingRegion } : {}),
  };
}

/** The rate card as table rows (model id, credits per million input / output tokens), sorted by model id. */
export function rateCardRows(
  p: Pick<ProviderRow, 'rateCard'>,
): { model: string; input: string; output: string }[] {
  const models = (p.rateCard as { models?: unknown } | undefined)?.models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return [];
  return Object.entries(models as Record<string, unknown>)
    .map(([model, v]) => {
      const x = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
      return {
        model,
        input: typeof x.creditsPerMillionInput === 'string' ? x.creditsPerMillionInput : '—',
        output: typeof x.creditsPerMillionOutput === 'string' ? x.creditsPerMillionOutput : '—',
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

export type Blocker = 'adapter_not_registered' | 'no_rate_card' | 'not_attested' | 'not_requested';

/** Why the provider cannot be enabled yet (the API repeats every one of these checks; this only explains them). */
export function blockers(p: ProviderRow): Blocker[] {
  const out: Blocker[] = [];
  if (!p.adapterRegistered) out.push('adapter_not_registered');
  if (rateCardRows(p).length === 0) out.push('no_rate_card');
  if (!isDevReference(p.code)) {
    if (!termsOf(p).attested || !p.attestationRef) out.push('not_attested');
    if (!p.enableRequestedBy) out.push('not_requested');
  }
  return out;
}

/**
 * Why a control is unavailable to this person (shown instead of hiding it), or null when it can be used. The API stays the authority.
 * `enable` needs the approve permission and, outside the dev references, a request by a DIFFERENT person (two-person rule).
 */
export function enableBlock(
  p: ProviderRow,
  me: { id: string; can: (perm: string) => boolean },
): 'no_permission' | 'two_person' | 'blocked' | null {
  if (!me.can('admin:ai:approve')) return 'no_permission';
  if (!isDevReference(p.code) && p.enableRequestedBy && p.enableRequestedBy === me.id)
    return 'two_person';
  return blockers(p).length > 0 ? 'blocked' : null;
}

/** Why "request enabling" is unavailable: the preconditions the API checks before it records a request (no request is part of the list). */
export function requestBlock(p: ProviderRow): Blocker[] {
  return blockers(p).filter((b) => b !== 'not_requested');
}

const SLUG = /^[a-z][a-z0-9-]{1,40}$/;
const VAULT = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$/;
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,80}$/;
const INT = /^\d{1,15}$/;
const HOST = /^[a-z0-9.-]{3,200}$/;

export type ConfigureError =
  'code' | 'adapter' | 'displayName' | 'region' | 'vault' | 'rateCard' | 'egress';

/** Parses the rate card text: `{"models":{"<model id>":{"creditsPerMillionInput":"…","creditsPerMillionOutput":"…"}}}`, integer strings only. */
export function parseRateCard(text: string): Record<string, unknown> | null {
  const v = text.trim();
  if (v === '') return { models: {} };
  let j: unknown;
  try {
    j = JSON.parse(v);
  } catch {
    return null;
  }
  const models = (j as { models?: unknown } | null)?.models;
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return null;
  const out: Record<string, { creditsPerMillionInput: string; creditsPerMillionOutput: string }> =
    {};
  for (const [id, m] of Object.entries(models)) {
    const x = m as { creditsPerMillionInput?: unknown; creditsPerMillionOutput?: unknown } | null;
    if (
      !MODEL_ID.test(id) ||
      typeof x?.creditsPerMillionInput !== 'string' ||
      !INT.test(x.creditsPerMillionInput) ||
      typeof x.creditsPerMillionOutput !== 'string' ||
      !INT.test(x.creditsPerMillionOutput)
    )
      return null;
    out[id] = {
      creditsPerMillionInput: x.creditsPerMillionInput,
      creditsPerMillionOutput: x.creditsPerMillionOutput,
    };
  }
  return { models: out };
}

export interface ConfigureForm {
  code: string;
  adapter: string;
  displayName: string;
  region: string;
  vaultRef: string;
  rateCardVersion: string;
  rateCard: string;
  egress: string;
}

/**
 * The body of a `configure` action. A credential is only ever a vault REFERENCE (`vault://…`): there is no field for a secret value and anything that does not
 * look like a reference is refused here as well as by the API (422 `credential_value_rejected`).
 */
export function configureBody(f: ConfigureForm): {
  body?: Record<string, unknown>;
  error?: ConfigureError;
} {
  if (!SLUG.test(f.code.trim())) return { error: 'code' };
  if (!SLUG.test(f.adapter.trim())) return { error: 'adapter' };
  const name = f.displayName.trim();
  if (name.length < 1 || name.length > 100) return { error: 'displayName' };
  const region = f.region.trim();
  if (region.length < 2 || region.length > 64) return { error: 'region' };
  const vault = f.vaultRef.trim();
  if (vault !== '' && !VAULT.test(vault)) return { error: 'vault' };
  const rateCard = parseRateCard(f.rateCard);
  if (!rateCard) return { error: 'rateCard' };
  const egress = f.egress
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (egress.some((h) => !HOST.test(h))) return { error: 'egress' };
  const version = f.rateCardVersion.trim();
  return {
    body: {
      action: 'configure',
      code: f.code.trim(),
      adapter: f.adapter.trim(),
      displayName: name,
      region,
      ...(vault ? { vaultRef: vault } : {}),
      rateCard,
      ...(version && version.length <= 40 ? { rateCardVersion: version } : {}),
      egressAllow: egress,
    },
  };
}

/** The form text of an existing row (the egress list is not returned by the API, so it starts empty and the form says saving replaces it). */
export function configureFormOf(p: ProviderRow | null): ConfigureForm {
  return {
    code: p?.code ?? '',
    adapter: p?.adapter ?? '',
    displayName: p?.displayName ?? '',
    region: p?.region ?? '',
    vaultRef: p?.vaultRef ?? '',
    rateCardVersion: p?.rateCardVersion ?? '1',
    rateCard: p?.rateCard && rateCardRows(p).length > 0 ? JSON.stringify(p.rateCard, null, 2) : '',
    egress: '',
  };
}

export type AttestError = 'ref' | 'terms';
/** The body of an `attest` action: the signed attestation's reference and what the contract says (true, false or "unknown": never defaulted to a favourable answer). */
export function attestBody(
  id: string,
  f: { ref: string; retains: string; trains: string },
): { body?: Record<string, unknown>; error?: AttestError } {
  const ref = f.ref.trim();
  if (ref.length < 3 || ref.length > 200) return { error: 'ref' };
  const parse = (v: string): Tri | null =>
    v === 'true' ? true : v === 'false' ? false : v === 'unknown' ? 'unknown' : null;
  const retains = parse(f.retains);
  const trains = parse(f.trains);
  if (retains === null || trains === null) return { error: 'terms' };
  return {
    body: {
      action: 'attest',
      id,
      attestationRef: ref,
      dataTerms: { retainsPrompts: retains, trainsOnData: trains },
    },
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The body of a kill-switch action: global when the organization is empty, otherwise for that organization (a UUID); null = the organization is not valid. */
export function killSwitchBody(on: boolean, orgId: string): Record<string, unknown> | null {
  const o = orgId.trim().toLowerCase();
  if (o !== '' && !UUID.test(o)) return null;
  return { action: 'kill_switch', on, ...(o ? { orgId: o } : {}) };
}

/* ------------------------------------------------------------------ run oversight */

export const RUN_STATES = [
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exceeded',
] as const;

export interface AdminRun {
  id: string;
  orgId: string;
  sessionId: string;
  projectId: string | null;
  kind: string;
  state: string;
  tokensIn: number;
  tokensOut: number;
  spentCredits: string;
  modelRef: string | null;
  dataRegion: string;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Reads the loosely typed run rows defensively. Only metadata exists in the response: there is nothing else to read, and nothing else is kept. */
export function runRows(items: unknown[]): AdminRun[] {
  return items
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      id: str(r.id) ?? '',
      orgId: str(r.orgId) ?? '',
      sessionId: str(r.sessionId) ?? '',
      projectId: str(r.projectId),
      kind: str(r.kind) ?? '—',
      state: str(r.state) ?? '—',
      tokensIn: num(r.tokensIn),
      tokensOut: num(r.tokensOut),
      spentCredits:
        typeof r.spentCredits === 'string' && /^\d+$/.test(r.spentCredits) ? r.spentCredits : '0',
      modelRef: str(r.modelRef),
      dataRegion: str(r.dataRegion) ?? '—',
      errorCode: str(r.errorCode),
      createdAt: str(r.createdAt) ?? '',
      finishedAt: str(r.finishedAt),
    }))
    .filter((r) => r.id !== '');
}

export const runTone = (state: string): 'success' | 'danger' | 'warn' | undefined =>
  state === 'succeeded'
    ? 'success'
    : state === 'failed' || state === 'budget_exceeded'
      ? 'danger'
      : state === 'waiting_approval' || state === 'running' || state === 'queued'
        ? 'warn'
        : undefined;

/** A filter value of the run list: an organization id must be a UUID, a state one of the known states; anything else is dropped (never sent). */
export function runFilters(q: { orgId?: string; state?: string }): {
  orgId?: string;
  state?: string;
  invalidOrg: boolean;
} {
  const org = (q.orgId ?? '').trim().toLowerCase();
  const invalidOrg = org !== '' && !UUID.test(org);
  return {
    ...(org && !invalidOrg ? { orgId: org } : {}),
    ...(q.state && (RUN_STATES as readonly string[]).includes(q.state) ? { state: q.state } : {}),
    invalidOrg,
  };
}

/* ------------------------------------------------------------------ quality */

export const QUALITY_METRICS = [
  'htmlErrorFreeSites',
  'a11yScore',
  'seoScore',
  'performanceScore',
  'requirementCoverage',
  'humanRubricMean',
] as const;
export type QualityMetric = (typeof QUALITY_METRICS)[number];

export interface QualityReport {
  id: string;
  createdAt: string;
  model: string;
  modelQuality: 'NOT VERIFIED' | 'VERIFIED';
  sites: number;
  metrics: Partial<Record<QualityMetric, number>>;
  breaches: string[];
}
export interface Quality {
  thresholds: Partial<Record<QualityMetric, number>>;
  reports: QualityReport[];
}

const metricMap = (v: unknown): Partial<Record<QualityMetric, number>> => {
  const out: Partial<Record<QualityMetric, number>> = {};
  if (typeof v !== 'object' || v === null) return out;
  for (const k of QUALITY_METRICS) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  }
  return out;
};

/**
 * Reads the evaluation response defensively (the harness is new): unknown fields are ignored, a missing metric stays missing (shown as "not measured",
 * never as zero), and a report that does not say its model quality is treated as NOT VERIFIED.
 */
export function parseQuality(raw: unknown): Quality {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const reports = Array.isArray(o.reports) ? o.reports : [];
  return {
    thresholds: metricMap(o.thresholds),
    reports: reports
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map((r) => ({
        id: str(r.id) ?? '',
        createdAt: str(r.createdAt) ?? '',
        model: str(r.model) ?? '—',
        modelQuality:
          r.modelQuality === 'VERIFIED' ? ('VERIFIED' as const) : ('NOT VERIFIED' as const),
        sites: num(r.sites),
        metrics: metricMap(r.metrics),
        breaches: Array.isArray(r.breaches) ? r.breaches.filter((b) => typeof b === 'string') : [],
      }))
      .filter((r) => r.id !== '')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

/** The metrics a report breaches, as the harness reported them (the harness decides; the screen never recomputes a verdict). */
export const breached = (r: QualityReport, m: QualityMetric): boolean => r.breaches.includes(m);

/** A metric value for display: integers as they are, others with two decimals; missing = null. */
export const metricText = (v: number | undefined): string | null =>
  v === undefined ? null : Number.isInteger(v) ? String(v) : v.toFixed(2);

/** The change of a metric against the next older report (the list is newest first), as a signed text; null when either side is missing. */
export function metricDelta(reports: QualityReport[], i: number, m: QualityMetric): string | null {
  const cur = reports[i]?.metrics[m];
  const prev = reports[i + 1]?.metrics[m];
  if (cur === undefined || prev === undefined) return null;
  const d = Math.round((cur - prev) * 100) / 100;
  return d === 0 ? '0' : `${d > 0 ? '+' : '-'}${Math.abs(d)}`;
}

/** Whether any report breaches a threshold: drives the page-level warning. */
export const anyBreach = (q: Quality): boolean => q.reports.some((r) => r.breaches.length > 0);
