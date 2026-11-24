import { costMinor, isBlank, type PriceCard } from './budget';
import { scanForSecrets } from '../secret-scan';
import type { StageId } from './stages';
import { STAGE_IDS } from './stages';
import type { BenchmarkReport, EvidenceLabel } from './report';
import { SCORECARD_DIMENSIONS, type ScorecardRow } from './scorecard';
import type { ThresholdResult } from './thresholds';
import type { GoldenTask, Recording } from './types';

/**
 * The evidence record of one benchmark stage run: the exact, machine-readable statement of WHAT was run, on WHICH model, against WHICH dataset, for HOW MUCH, with WHAT scores, under
 * WHICH approvals. It is what a live stage must leave behind and what a simulated run leaves too, clearly marked: `simulated: true` for anything produced by a mock or the reference
 * oracle, which is never evidence about a model. It holds ids, numbers and references only: never a prompt, a model output, a file content or a credential (`evidenceRecordProblems`
 * refuses a record in which the secret scanner finds anything). A generated record is not committed to the repository.
 */
export const EVIDENCE_SCHEMA = 'nuzm.benchmark-evidence/1';
export type EvidenceStatus =
  'COMPLETED' | 'REFUSED' | 'STOPPED_BUDGET' | 'STOPPED_UNCERTAIN' | 'STOPPED_FAILED';
export interface EvidenceApprovals {
  budgetRef: string;
  budgetApprovedBy: string;
  thresholdsVersion: string;
  thresholdsAcceptedBy: string;
  reviewers: string[];
  securityReviewRef: string;
  /** the reference confirming THIS stage start (printed maximum confirmed) */
  confirmRef: string;
}
export interface EvidenceRecord {
  schema: typeof EVIDENCE_SCHEMA;
  /** true for a mock or reference run: a pipeline exercise, not a measurement of any provider */
  simulated: boolean;
  label: EvidenceLabel;
  stage: StageId;
  runId: string;
  status: EvidenceStatus;
  model: { adapterId: string; model: string };
  /** the provider verification evidence reference (live only) */
  providerEvidenceRef: string | null;
  dataset: { version: string; hash: string };
  thresholdsVersion: string;
  taskIds: string[];
  recorded: number;
  notRecorded: string[];
  usage: { tokensIn: number; tokensOut: number; tokens: number; requests: number };
  cost: {
    currency: string;
    /** what was used, minor units, decimal integer string */
    costMinor: string;
    /** the hard maximum of the stage (what the ledger would never let it exceed) */
    maxCostMinor: string;
    priceSource: string;
  };
  /** per-dimension scores (the seven dimensions) */
  dimensions: { dimension: string; value: number | null; unit: string; tasks: number }[];
  thresholds: { id: string; status: string; actual: number | null }[];
  reportFingerprint: string;
  approvals: EvidenceApprovals | null;
  startedAt: string;
  finishedAt: string;
}

export interface EvidenceInput {
  simulated: boolean;
  stage: StageId;
  runId: string;
  status: EvidenceStatus;
  model: { adapterId: string; model: string };
  providerEvidenceRef: string | null;
  tasks: readonly GoldenTask[];
  recordings: ReadonlyMap<string, Recording>;
  report: BenchmarkReport;
  scorecard: readonly ScorecardRow[];
  thresholdResults: readonly ThresholdResult[];
  reportFingerprint: string;
  price: PriceCard;
  priceSource: string;
  maxCostMinor: string;
  approvals: EvidenceApprovals | null;
  startedAt: string;
  finishedAt: string;
  thresholdsVersion: string;
}

/** Usage and cost are summed per task exactly as the budget ledger commits them (each task's cost rounded up to a minor unit). */
export function buildEvidenceRecord(i: EvidenceInput): EvidenceRecord {
  let tin = 0;
  let tout = 0;
  let requests = 0;
  let cost = 0n;
  const recorded: string[] = [];
  for (const t of i.tasks) {
    const r = i.recordings.get(t.id);
    if (!r) continue;
    recorded.push(t.id);
    const a = r.turns.reduce((s, x) => s + x.tokensIn, 0);
    const b = r.turns.reduce((s, x) => s + x.tokensOut, 0);
    tin += a;
    tout += b;
    requests += r.turns.length;
    cost += costMinor(a, b, i.price);
  }
  return {
    schema: EVIDENCE_SCHEMA,
    simulated: i.simulated,
    label: i.report.evidence.label,
    stage: i.stage,
    runId: i.runId,
    status: i.status,
    model: i.model,
    providerEvidenceRef: i.providerEvidenceRef,
    dataset: { version: i.report.datasetVersion, hash: i.report.datasetHash },
    thresholdsVersion: i.thresholdsVersion,
    taskIds: i.tasks.map((t) => t.id),
    recorded: recorded.length,
    notRecorded: i.tasks.map((t) => t.id).filter((id) => !recorded.includes(id)),
    usage: { tokensIn: tin, tokensOut: tout, tokens: tin + tout, requests },
    cost: {
      currency: i.price.currency,
      costMinor: cost.toString(),
      maxCostMinor: i.maxCostMinor,
      priceSource: i.priceSource,
    },
    dimensions: i.scorecard.map((r) => ({
      dimension: r.dimension,
      value: r.value,
      unit: r.unit,
      tasks: r.tasks,
    })),
    thresholds: i.thresholdResults.map((t) => ({ id: t.id, status: t.status, actual: t.actual })),
    reportFingerprint: i.reportFingerprint,
    approvals: i.approvals,
    startedAt: i.startedAt,
    finishedAt: i.finishedAt,
  };
}

const INT = /^\d+$/;
const stringLeaves = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringLeaves(x, out);
  return out;
};
/** Why a value is not an acceptable evidence record (empty = acceptable). A live record without its provenance is refused, so it can never be mistaken for a measurement. */
export function evidenceRecordProblems(raw: unknown): string[] {
  const p: string[] = [];
  const r = raw as Partial<EvidenceRecord> | null;
  if (!r || typeof r !== 'object') return ['not an object'];
  if (r.schema !== EVIDENCE_SCHEMA) p.push(`schema must be ${EVIDENCE_SCHEMA}`);
  if (typeof r.simulated !== 'boolean') p.push('simulated must be a boolean');
  if (!STAGE_IDS.includes(r.stage as StageId)) p.push('stage must be A-E');
  if (isBlank(r.runId)) p.push('runId missing');
  if (isBlank(r.model?.adapterId) || isBlank(r.model?.model)) p.push('model id missing');
  if (isBlank(r.dataset?.version) || isBlank(r.dataset?.hash))
    p.push('dataset version or hash missing');
  if (isBlank(r.thresholdsVersion)) p.push('thresholds version missing');
  if (!Array.isArray(r.taskIds) || r.taskIds.length === 0) p.push('task ids missing');
  else if (new Set(r.taskIds).size !== r.taskIds.length) p.push('duplicate task ids');
  const u = r.usage;
  if (
    !u ||
    ![u.tokensIn, u.tokensOut, u.tokens, u.requests].every((x) => Number.isInteger(x) && x >= 0) ||
    u.tokens !== u.tokensIn + u.tokensOut
  )
    p.push('usage must be non-negative integers with tokens = in + out');
  const c = r.cost;
  if (!c || isBlank(c.currency) || !INT.test(c.costMinor ?? '') || !INT.test(c.maxCostMinor ?? ''))
    p.push('cost must be integer minor-unit strings with a currency');
  else if (BigInt(c.costMinor) > BigInt(c.maxCostMinor)) p.push('cost exceeds the stage maximum');
  if (isBlank(c?.priceSource)) p.push('price source missing');
  const dims = (r.dimensions ?? []).map((d) => d.dimension);
  if (SCORECARD_DIMENSIONS.some((d) => !dims.includes(d)))
    p.push('all seven dimensions are required');
  if (isBlank(r.reportFingerprint)) p.push('report fingerprint missing');
  if (isBlank(r.startedAt) || isBlank(r.finishedAt)) p.push('start and finish times missing');
  if (r.simulated === true) {
    if (r.label === 'OFFLINE_REPLAY_OF_RECORDED_RUN')
      p.push('a simulated record cannot carry the recorded-run label');
    if (r.providerEvidenceRef) p.push('a simulated record has no provider evidence');
  } else if (r.simulated === false) {
    if (r.label !== 'OFFLINE_REPLAY_OF_RECORDED_RUN')
      p.push('a live record must be labelled OFFLINE_REPLAY_OF_RECORDED_RUN');
    if (isBlank(r.providerEvidenceRef))
      p.push('a live record needs the provider evidence reference');
    const a = r.approvals;
    if (
      !a ||
      [
        a.budgetRef,
        a.budgetApprovedBy,
        a.thresholdsVersion,
        a.thresholdsAcceptedBy,
        a.securityReviewRef,
        a.confirmRef,
      ].some(isBlank) ||
      !Array.isArray(a.reviewers) ||
      a.reviewers.length < 2
    )
      p.push('a live record needs every approval reference and at least two reviewers');
  }
  // scan the string VALUES, not the JSON text: JSON escapes quotes, which a scanner written for source text does not see through
  if (scanForSecrets(stringLeaves(r).join('\n')).length > 0)
    p.push('the record carries a secret-like string');
  return p;
}
