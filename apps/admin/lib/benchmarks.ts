/** Pure helpers of the admin benchmark dashboard (S-AG5). No I/O: unit-tested in `benchmarks.spec.ts`. The shapes mirror `GET /v1/admin/ai/benchmarks` (CONTRACT-S03-1). */

export type EvidenceLabel =
  | 'NONE'
  | 'OFFLINE_REFERENCE_ORACLE'
  | 'OFFLINE_MOCK_REPLAY'
  | 'OFFLINE_REPLAY_OF_RECORDED_RUN'
  | 'MIXED_ORIGINS_NOT_COMPARABLE';
const EVIDENCE: readonly EvidenceLabel[] = ['NONE', 'OFFLINE_REFERENCE_ORACLE', 'OFFLINE_MOCK_REPLAY', 'OFFLINE_REPLAY_OF_RECORDED_RUN', 'MIXED_ORIGINS_NOT_COMPARABLE'];

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
export interface Overview {
  enabled: boolean;
  dataset: { version: string; hash: string; tasks: number; perCategory: Record<string, number>; categories: string[] } | null;
  thresholds: { version: string; status: 'PROPOSED' | 'ACCEPTED'; acceptedBy: string | null; acceptedAt: string | null; items: ThresholdRow[] } | null;
  budget: { ref: string; currency: string; maxCostMinor: string; maxTokens: number; maxRequests: number } | null;
  securityReview: { ref: string; passed: boolean } | null;
  reviewers: { id: string; name: string }[];
  runs: RunSummary[];
  qualifications: QualificationRow[];
  liveAvailable: boolean;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const nn = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reads whatever the API sent without trusting it: a malformed or missing part becomes empty, never an exception and never a guessed value. */
export function parseOverview(raw: unknown): Overview {
  const o = obj(raw);
  const empty: Overview = { enabled: false, dataset: null, thresholds: null, budget: null, securityReview: null, reviewers: [], runs: [], qualifications: [], liveAvailable: false };
  if (o.enabled !== true) return empty;
  const d = obj(o.dataset);
  const th = obj(o.thresholds);
  const acc = obj(th.acceptance);
  const b = obj(o.budget);
  const sec = obj(o.securityReview);
  const live = obj(o.live);
  return {
    enabled: true,
    dataset: typeof d.version === 'string'
      ? {
          version: d.version,
          hash: s(d.hash),
          tasks: n(d.tasks),
          perCategory: Object.fromEntries(Object.entries(obj(d.perCategory)).map(([k, v]) => [k, n(v)])),
          categories: arr(d.categories).filter((x): x is string => typeof x === 'string'),
        }
      : null,
    thresholds: typeof th.version === 'string'
      ? {
          version: th.version,
          status: th.status === 'ACCEPTED' ? 'ACCEPTED' : 'PROPOSED',
          acceptedBy: typeof acc.acceptedBy === 'string' ? acc.acceptedBy : null,
          acceptedAt: typeof acc.acceptedAt === 'string' ? acc.acceptedAt : null,
          items: arr(th.items).map((i) => {
            const x = obj(i);
            return { id: s(x.id), scope: s(x.scope), metric: s(x.metric), op: s(x.op), value: n(x.value), why: s(x.why) };
          }),
        }
      : null,
    budget: typeof b.ref === 'string' ? { ref: b.ref, currency: s(b.currency), maxCostMinor: s(b.maxCostMinor), maxTokens: n(b.maxTokens), maxRequests: n(b.maxRequests) } : null,
    securityReview: typeof sec.ref === 'string' ? { ref: sec.ref, passed: sec.passed === true } : null,
    reviewers: arr(o.reviewers).map((r) => ({ id: s(obj(r).id), name: s(obj(r).name) })).filter((r) => r.id && r.name),
    runs: arr(o.runs).map((r) => {
      const x = obj(r);
      const ev = EVIDENCE.find((e) => e === x.evidence) ?? 'NONE';
      return {
        id: s(x.id), label: s(x.label), createdAt: s(x.createdAt), datasetVersion: s(x.datasetVersion), evidence: ev,
        adapters: arr(x.adapters).filter((a): a is string => typeof a === 'string'), tasks: n(x.tasks), passRate: n(x.passRate),
        meanQuality: n(x.meanQuality), meanSecurity: nn(x.meanSecurity), modeViolations: n(x.modeViolations),
      };
    }).filter((r) => r.id),
    qualifications: arr(o.qualifications).map((q) => {
      const x = obj(q);
      return { id: s(x.id), adapterId: s(x.adapterId), model: s(x.model), effectiveState: s(x.effectiveState, 'PROPOSED'), datasetVersion: s(x.datasetVersion) };
    }).filter((q) => q.id),
    liveAvailable: live.available === true,
  };
}

/** A pass rate as a percentage text (`0.8571` -> `85.7%`). */
export const pct = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;
/** A score 0-100, or the not-applicable marker. */
export const score = (v: number | null, na: string): string => (v === null ? na : String(v));
/** The tone of an evidence label: only a replay of a recorded run is not flagged as "not a model". */
export const evidenceTone = (e: EvidenceLabel): 'warn' | undefined => (e === 'OFFLINE_REPLAY_OF_RECORDED_RUN' ? undefined : 'warn');
/** Threshold bar as text (`>= 0.95`). */
export const barText = (t: Pick<ThresholdRow, 'op' | 'value'>): string => `${t.op} ${t.value}`;
export const MOCK_SOURCES = ['reference', 'mock:ideal', 'mock:sloppy-tools', 'mock:verbose', 'mock:slow', 'mock:half-done', 'mock:leaky', 'mock:insecure'] as const;
/** The body of the only action the dashboard sends: an offline replay. `requestId` makes a double click harmless. */
export const runOfflineBody = (source: string, requestId: string) => ({ action: 'run_offline', source, requestId });
