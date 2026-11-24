/** Pure helpers of the admin benchmark dashboard (S-AG5). No I/O: unit-tested in `benchmarks.spec.ts`. The shapes mirror `GET /v1/admin/ai/benchmarks` (CONTRACT-S03-1). */

export type EvidenceLabel =
  | 'NONE'
  | 'OFFLINE_REFERENCE_ORACLE'
  | 'OFFLINE_MOCK_REPLAY'
  | 'OFFLINE_REPLAY_OF_RECORDED_RUN'
  | 'MIXED_ORIGINS_NOT_COMPARABLE';
const EVIDENCE: readonly EvidenceLabel[] = [
  'NONE',
  'OFFLINE_REFERENCE_ORACLE',
  'OFFLINE_MOCK_REPLAY',
  'OFFLINE_REPLAY_OF_RECORDED_RUN',
  'MIXED_ORIGINS_NOT_COMPARABLE',
];

export interface RunSummary {
  id: string;
  label: string;
  createdAt: string;
  datasetVersion: string;
  evidence: EvidenceLabel;
  adapters: string[];
  tasks: number;
  passRate: number;
  meanQuality: number;
  meanSecurity: number | null;
  modeViolations: number;
}
export interface ThresholdRow {
  id: string;
  scope: string;
  metric: string;
  op: string;
  value: number;
  why: string;
}
export interface QualificationRow {
  id: string;
  adapterId: string;
  model: string;
  effectiveState: string;
  datasetVersion: string;
}
export const GOVERNANCE_STATES = [
  'NOT_PROPOSED',
  'PROPOSED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'ACCEPTED',
  'REJECTED',
] as const;
export type GovernanceState = (typeof GOVERNANCE_STATES)[number];
export const VERDICTS = ['approve', 'request_changes', 'reject'] as const;
export interface Governance {
  state: GovernanceState;
  proposedBy: string | null;
  summary: string | null;
  reviews: { by: string; verdict: (typeof VERDICTS)[number]; note: string }[];
  decidedBy: string | null;
  reason: string | null;
}
export const STAGE_IDS = ['A', 'B', 'C', 'D', 'E'] as const;
export type StageId = (typeof STAGE_IDS)[number];
export const PREREQUISITE_IDS = [
  'FLAG_ON',
  'LIVE_GATE_OPEN',
  'ENVIRONMENT_NON_PRODUCTION',
  'PROVIDER_VERIFIED',
  'CAPTURE_SOURCE_BUILT',
  'RATES_CONFIRMED',
  'VENDOR_SPEND_CAP',
  'THRESHOLDS_ACCEPTED',
  'BUDGET_APPROVED_FOR_STAGE',
  'REVIEWERS_NAMED',
  'SECURITY_REVIEW_PASSED',
  'PREVIOUS_STAGE_EXITED',
  'BASELINE_RECORDED',
] as const;
export type PrerequisiteId = (typeof PREREQUISITE_IDS)[number];
export interface StagePlanRow {
  stage: StageId;
  tasks: number;
  runs: number;
  models: number;
  currency: string;
  /** minor units, decimal integer strings */
  estimateCostMinor: string;
  maxCostMinor: string;
  estimatedMinutes: number;
  maximumMinutes: number;
  maxTokens: number;
  prerequisites: PrerequisiteId[];
}
export interface StagesView {
  rateBasis: { status: string; model: string | null; source: string };
  usagePermille: number;
  inputSharePermille: number;
  plans: StagePlanRow[];
  monthly: { estimateCostMinor: string; maxCostMinor: string; currency: string } | null;
}
export interface Overview {
  enabled: boolean;
  dataset: {
    version: string;
    hash: string;
    tasks: number;
    perCategory: Record<string, number>;
    categories: string[];
  } | null;
  thresholds: {
    version: string;
    status: 'PROPOSED' | 'ACCEPTED';
    governance: Governance;
    acceptedBy: string | null;
    acceptedAt: string | null;
    items: ThresholdRow[];
  } | null;
  budget: {
    ref: string;
    currency: string;
    maxCostMinor: string;
    maxTokens: number;
    maxRequests: number;
  } | null;
  securityReview: { ref: string; passed: boolean } | null;
  reviewers: { id: string; name: string }[];
  runs: RunSummary[];
  qualifications: QualificationRow[];
  liveAvailable: boolean;
  stages: StagesView | null;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const nn = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reads whatever the API sent without trusting it: a malformed or missing part becomes empty, never an exception and never a guessed value. */
export function parseOverview(raw: unknown): Overview {
  const o = obj(raw);
  const empty: Overview = {
    enabled: false,
    dataset: null,
    thresholds: null,
    budget: null,
    securityReview: null,
    reviewers: [],
    runs: [],
    qualifications: [],
    liveAvailable: false,
    stages: null,
  };
  if (o.enabled !== true) return empty;
  const d = obj(o.dataset);
  const th = obj(o.thresholds);
  const acc = obj(th.acceptance);
  const b = obj(o.budget);
  const sec = obj(o.securityReview);
  const live = obj(o.live);
  return {
    enabled: true,
    dataset:
      typeof d.version === 'string'
        ? {
            version: d.version,
            hash: s(d.hash),
            tasks: n(d.tasks),
            perCategory: Object.fromEntries(
              Object.entries(obj(d.perCategory)).map(([k, v]) => [k, n(v)]),
            ),
            categories: arr(d.categories).filter((x): x is string => typeof x === 'string'),
          }
        : null,
    thresholds:
      typeof th.version === 'string'
        ? {
            version: th.version,
            status: th.status === 'ACCEPTED' ? 'ACCEPTED' : 'PROPOSED',
            governance: parseGovernance(th.governance),
            acceptedBy: typeof acc.acceptedBy === 'string' ? acc.acceptedBy : null,
            acceptedAt: typeof acc.acceptedAt === 'string' ? acc.acceptedAt : null,
            items: arr(th.items).map((i) => {
              const x = obj(i);
              return {
                id: s(x.id),
                scope: s(x.scope),
                metric: s(x.metric),
                op: s(x.op),
                value: n(x.value),
                why: s(x.why),
              };
            }),
          }
        : null,
    budget:
      typeof b.ref === 'string'
        ? {
            ref: b.ref,
            currency: s(b.currency),
            maxCostMinor: s(b.maxCostMinor),
            maxTokens: n(b.maxTokens),
            maxRequests: n(b.maxRequests),
          }
        : null,
    securityReview:
      typeof sec.ref === 'string' ? { ref: sec.ref, passed: sec.passed === true } : null,
    reviewers: arr(o.reviewers)
      .map((r) => ({ id: s(obj(r).id), name: s(obj(r).name) }))
      .filter((r) => r.id && r.name),
    runs: arr(o.runs)
      .map((r) => {
        const x = obj(r);
        const ev = EVIDENCE.find((e) => e === x.evidence) ?? 'NONE';
        return {
          id: s(x.id),
          label: s(x.label),
          createdAt: s(x.createdAt),
          datasetVersion: s(x.datasetVersion),
          evidence: ev,
          adapters: arr(x.adapters).filter((a): a is string => typeof a === 'string'),
          tasks: n(x.tasks),
          passRate: n(x.passRate),
          meanQuality: n(x.meanQuality),
          meanSecurity: nn(x.meanSecurity),
          modeViolations: n(x.modeViolations),
        };
      })
      .filter((r) => r.id),
    qualifications: arr(o.qualifications)
      .map((q) => {
        const x = obj(q);
        return {
          id: s(x.id),
          adapterId: s(x.adapterId),
          model: s(x.model),
          effectiveState: s(x.effectiveState, 'PROPOSED'),
          datasetVersion: s(x.datasetVersion),
        };
      })
      .filter((q) => q.id),
    liveAvailable: live.available === true,
    stages: parseStages(live.stages),
  };
}

/** The governance state as sent by the API; an unknown or missing state is NOT_PROPOSED (the safe reading: nothing is accepted). */
export function parseGovernance(raw: unknown): Governance {
  const g = obj(raw);
  const state = GOVERNANCE_STATES.find((x) => x === g.state) ?? 'NOT_PROPOSED';
  return {
    state,
    proposedBy: typeof g.proposedBy === 'string' ? g.proposedBy : null,
    summary: typeof g.summary === 'string' ? g.summary : null,
    reviews: arr(g.reviews)
      .map((r) => {
        const x = obj(r);
        const verdict = VERDICTS.find((v) => v === x.verdict);
        return verdict ? { by: s(x.by), verdict, note: s(x.note) } : null;
      })
      .filter((r): r is Governance['reviews'][number] => r !== null),
    decidedBy: typeof g.decidedBy === 'string' ? g.decidedBy : null,
    reason: typeof g.reason === 'string' ? g.reason : null,
  };
}

/** The body of a threshold-governance action. `requestId` makes a double click harmless. */
export type GovernanceAction = 'propose' | 'review' | 'accept' | 'reject';
export function governanceBody(
  action: GovernanceAction,
  version: string,
  fields: { text?: string; verdict?: string },
  requestId: string,
): Record<string, unknown> {
  const base = { action: `${action}_thresholds`, version, requestId };
  if (action === 'propose') return { ...base, summary: fields.text ?? '' };
  if (action === 'review')
    return { ...base, verdict: fields.verdict ?? '', note: fields.text ?? '' };
  if (action === 'reject') return { ...base, reason: fields.text ?? '' };
  return base;
}
/** Which governance actions make sense in a state (the server enforces the rules; this only hides the impossible ones). */
export function governanceActions(state: GovernanceState): GovernanceAction[] {
  switch (state) {
    case 'NOT_PROPOSED':
    case 'REJECTED':
      return ['propose'];
    case 'PROPOSED':
    case 'UNDER_REVIEW':
      return ['review', 'accept', 'reject', 'propose'];
    case 'CHANGES_REQUESTED':
      return ['propose', 'reject'];
    case 'ACCEPTED':
      return ['reject'];
  }
}

const minorOf = (v: unknown): string => (typeof v === 'string' && /^\d+$/.test(v) ? v : '0');
/** The staged plan as sent by the API; anything malformed is dropped (a missing stage is shown as missing, never invented). */
export function parseStages(raw: unknown): StagesView | null {
  const o = obj(raw);
  const rb = obj(o.rateBasis);
  if (arr(o.plans).length === 0) return null;
  const a = obj(o.assumptions);
  const prices = obj(o.prices);
  const currency = s(prices.currency);
  const plans: StagePlanRow[] = [];
  const defs = new Map(arr(o.definitions).map((d) => [s(obj(d).id), arr(obj(d).prerequisites)]));
  for (const p of arr(o.plans)) {
    const x = obj(p);
    const id = STAGE_IDS.find((i) => i === x.stage);
    if (!id) continue;
    const est = obj(x.estimate);
    const max = obj(x.max);
    const dur = obj(x.duration);
    plans.push({
      stage: id,
      tasks: n(x.tasks),
      runs: n(x.runs),
      models: n(x.models),
      currency: s(x.currency, currency),
      estimateCostMinor: minorOf(est.costMinor),
      maxCostMinor: minorOf(max.costMinor),
      estimatedMinutes: n(dur.estimatedMinutes),
      maximumMinutes: n(dur.maximumMinutes),
      maxTokens: n(max.tokens),
      prerequisites: (defs.get(id) ?? []).filter((q): q is PrerequisiteId =>
        PREREQUISITE_IDS.some((i) => i === q),
      ),
    });
  }
  const m = obj(o.monthly);
  return {
    rateBasis: {
      status: s(rb.status),
      model: typeof rb.model === 'string' ? rb.model : null,
      source: s(rb.source),
    },
    usagePermille: n(a.usagePermille),
    inputSharePermille: n(a.inputSharePermille),
    plans,
    monthly:
      typeof m.maxCostMinor === 'string'
        ? {
            estimateCostMinor: minorOf(m.estimateCostMinor),
            maxCostMinor: minorOf(m.maxCostMinor),
            currency,
          }
        : null,
  };
}

/** Minor units (cents) as text with two decimals, e.g. `8360` USD -> `83.60 USD`. Integer arithmetic only: no float rounding on money. */
export function money(minor: string, currency: string): string {
  const b = BigInt(/^\d+$/.test(minor) ? minor : '0');
  return `${b / 100n}.${(b % 100n).toString().padStart(2, '0')} ${currency}`;
}
/** thousandths as a percentage text (`600` -> `60%`) */
export const permille = (v: number): string => `${Math.round(v) / 10}%`;

export const SCORECARD_DIMENSIONS = [
  'functional',
  'code-quality',
  'security',
  'arabic-rtl',
  'tool-calling-reliability',
  'cost-token-efficiency',
  'latency',
] as const;
export type ScorecardDimension = (typeof SCORECARD_DIMENSIONS)[number];
export interface ScorecardRow {
  dimension: ScorecardDimension;
  value: number | null;
  unit: 'score' | 'rate' | 'ms' | 'tokens';
  tasks: number;
  thresholds: { id: string; status: 'PASS' | 'FAIL' | 'NOT MEASURED' }[];
}
/** The scorecard of a stored run (`GET .../runs/{id}`); a missing or malformed scorecard is an empty list, never a guess. */
export function parseScorecard(raw: unknown): ScorecardRow[] {
  const rows: ScorecardRow[] = [];
  for (const r of arr(obj(raw).scorecard)) {
    const x = obj(r);
    const dimension = SCORECARD_DIMENSIONS.find((d) => d === x.dimension);
    if (!dimension) continue;
    const unit = (['score', 'rate', 'ms', 'tokens'] as const).find((u) => u === x.unit) ?? 'score';
    rows.push({
      dimension,
      value: nn(x.value),
      unit,
      tasks: n(x.tasks),
      thresholds: arr(x.thresholds).map((t) => {
        const y = obj(t);
        return {
          id: s(y.id),
          status: y.status === 'PASS' ? 'PASS' : y.status === 'FAIL' ? 'FAIL' : 'NOT MEASURED',
        };
      }),
    });
  }
  return rows;
}
/** A scorecard value as text: rates as percentages, latency in seconds, tokens as a count; `null` is the not-measured marker. */
export function scorecardValue(r: Pick<ScorecardRow, 'value' | 'unit'>, na: string): string {
  if (r.value === null) return na;
  if (r.unit === 'rate') return pct(r.value);
  if (r.unit === 'ms') return `${Math.round(r.value / 100) / 10} s`;
  return String(r.value);
}

/** A pass rate as a percentage text (`0.8571` -> `85.7%`). */
export const pct = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;
/** A score 0-100, or the not-applicable marker. */
export const score = (v: number | null, na: string): string => (v === null ? na : String(v));
/** The tone of an evidence label: only a replay of a recorded run is not flagged as "not a model". */
export const evidenceTone = (e: EvidenceLabel): 'warn' | undefined =>
  e === 'OFFLINE_REPLAY_OF_RECORDED_RUN' ? undefined : 'warn';
/** Threshold bar as text (`>= 0.95`). */
export const barText = (t: Pick<ThresholdRow, 'op' | 'value'>): string => `${t.op} ${t.value}`;
export const MOCK_SOURCES = [
  'reference',
  'mock:ideal',
  'mock:sloppy-tools',
  'mock:verbose',
  'mock:slow',
  'mock:half-done',
  'mock:leaky',
  'mock:insecure',
] as const;
/** The body of the only action the dashboard sends: an offline replay. `requestId` makes a double click harmless. */
export const runOfflineBody = (source: string, requestId: string) => ({
  action: 'run_offline',
  source,
  requestId,
});
