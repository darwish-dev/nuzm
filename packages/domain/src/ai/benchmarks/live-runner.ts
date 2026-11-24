import { BudgetLedger, preflightBudget, type BenchmarkBudget, type PriceCard } from './budget';
import type { SecurityReviewRecord, ThresholdAcceptance } from './gate';
import { DATASET_VERSION } from './registry';
import { REVIEW_PROTOCOL, type Reviewer } from './review';
import { THRESHOLDS_VERSION } from './thresholds';
import type { GoldenTask, Recording } from './types';

/**
 * The live benchmark runner: PREPARED, NEVER RUN in this repository. It records what a model does for each golden task through a `CaptureSource` port, inside an approved budget,
 * and it REFUSES to start (without calling the source at all) unless every one of these holds:
 *   - the feature flag `BENCHMARK_LIVE_ENABLED` is on (default off) AND the live-provider gate (D3, `AI_LIVE_PROVIDERS`) is open;
 *   - the environment is named and is not production;
 *   - the provider is verified (evidence reference) and the source is exactly that provider and model;
 *   - the thresholds (this exact version) are accepted by the owner;
 *   - a budget is approved (reference, approver, caps) and the WORST CASE of the whole suite fits it;
 *   - at least two named reviewers exist;
 *   - the agent security review is recorded as passed.
 * No real `CaptureSource` exists here: the real one is an adapter-backed implementation behind S-AG4's verified provider (Session 02 / integration). A source that declares itself
 * `mock` yields MOCK recordings, never RECORDED. After an uncertain outcome (timeout, unknown result) the run STOPS: reconcile before any retry (CLAUDE.md §4).
 */
export interface LivePreconditions {
  flagEnabled: boolean;
  liveProviderGateOpen: boolean;
  environment: { name: string; production: boolean } | null;
  providerVerified: { providerId: string; model: string; evidenceRef: string } | null;
  thresholdsAccepted: ThresholdAcceptance | null;
  budget: BenchmarkBudget | null;
  reviewers: readonly Reviewer[];
  securityReview: SecurityReviewRecord | null;
}
export type RefusalCode =
  | 'FLAG_OFF'
  | 'LIVE_GATE_CLOSED'
  | 'ENVIRONMENT_NOT_ALLOWED'
  | 'PROVIDER_NOT_VERIFIED'
  | 'SOURCE_MISMATCH'
  | 'THRESHOLDS_NOT_ACCEPTED'
  | 'BUDGET_NOT_APPROVED'
  | 'BUDGET_TOO_SMALL'
  | 'REVIEWERS_NOT_NAMED'
  | 'SECURITY_REVIEW_MISSING'
  | 'NO_TASKS';
export interface Refusal {
  code: RefusalCode;
  detail: string;
}

export interface CaptureRequest {
  task: GoldenTask;
  runId: string;
  maxTokens: number;
  maxTurns: number;
}
export interface CaptureResult {
  recording: Pick<Recording, 'turns' | 'patch' | 'finishedWith' | 'contractVersion'>;
  /** what the provider billed for this capture */
  usage: { tokensIn: number; tokensOut: number; requests: number };
}
/** Thrown by a source when the outcome of a call is unknown (timeout, connection lost after sending). */
export class UncertainCaptureError extends Error {}
export interface CaptureSource {
  readonly mode: 'live' | 'mock';
  readonly adapterId: string;
  readonly model: string;
  capture(req: CaptureRequest): Promise<CaptureResult>;
}

export function livePreflight(
  pre: LivePreconditions,
  tasks: readonly GoldenTask[],
  price: PriceCard,
  source?: Pick<CaptureSource, 'adapterId' | 'model'>,
): { allowed: boolean; refusals: Refusal[]; worstCase?: { tokens: number; requests: number; costMinor: string } } {
  const r: Refusal[] = [];
  const add = (code: RefusalCode, detail: string) => r.push({ code, detail });
  if (!pre.flagEnabled) add('FLAG_OFF', 'BENCHMARK_LIVE_ENABLED is off (default)');
  if (!pre.liveProviderGateOpen) add('LIVE_GATE_CLOSED', 'the live-provider gate (D3) is closed');
  if (!pre.environment || !pre.environment.name.trim() || pre.environment.production) add('ENVIRONMENT_NOT_ALLOWED', 'a named non-production environment is required');
  const pv = pre.providerVerified;
  if (!pv || !pv.providerId || !pv.model || !pv.evidenceRef.trim()) add('PROVIDER_NOT_VERIFIED', 'the provider is not verified (no evidence reference)');
  else if (source && (source.adapterId !== pv.providerId || source.model !== pv.model)) add('SOURCE_MISMATCH', 'the capture source is not the verified provider and model');
  const ta = pre.thresholdsAccepted;
  if (!ta || ta.version !== THRESHOLDS_VERSION || !ta.acceptedBy.trim() || !ta.acceptedAt.trim()) add('THRESHOLDS_NOT_ACCEPTED', `the owner has not accepted thresholds ${THRESHOLDS_VERSION}`);
  if (tasks.length === 0) add('NO_TASKS', 'nothing to run');
  const pf = preflightBudget(tasks, pre.budget, price);
  if (!pf.ok) add(pre.budget ? 'BUDGET_TOO_SMALL' : 'BUDGET_NOT_APPROVED', pf.reasons.join('; '));
  const named = pre.reviewers.filter((x) => x.name.trim().length > 1 && x.id.trim() !== '');
  if (named.length < REVIEW_PROTOCOL.minReviewers) add('REVIEWERS_NOT_NAMED', `at least ${REVIEW_PROTOCOL.minReviewers} named reviewers are required`);
  const sr = pre.securityReview;
  if (!sr || !sr.passed || !sr.ref.trim()) add('SECURITY_REVIEW_MISSING', 'the agent security review is not recorded as passed');
  return { allowed: r.length === 0, refusals: r, ...('worstCase' in pf && pf.worstCase ? { worstCase: pf.worstCase } : {}) };
}

export type LiveRunStatus = 'REFUSED' | 'COMPLETED' | 'STOPPED_BUDGET' | 'STOPPED_UNCERTAIN' | 'STOPPED_FAILED';
export interface LiveRunResult {
  status: LiveRunStatus;
  refusals: Refusal[];
  recordings: Map<string, Recording>;
  /** tasks that were not recorded (all of them when refused) */
  notRecorded: string[];
  /** set after an uncertain outcome: reconcile this task before any retry */
  uncertainTaskId: string | null;
  detail: string | null;
  usage: ReturnType<BudgetLedger['usage']> | null;
}

export async function runLiveBenchmark(input: {
  tasks: readonly GoldenTask[];
  pre: LivePreconditions;
  source: CaptureSource;
  price: PriceCard;
  runId: string;
  /** injected: the domain never reads a clock */
  now: () => string;
}): Promise<LiveRunResult> {
  const { tasks, pre, source, price, runId } = input;
  const refused = (refusals: Refusal[]): LiveRunResult => ({ status: 'REFUSED', refusals, recordings: new Map(), notRecorded: tasks.map((t) => t.id), uncertainTaskId: null, detail: 'preconditions not met; the source was not called', usage: null });
  const pf = livePreflight(pre, tasks, price, source);
  if (!pf.allowed) return refused(pf.refusals);
  const ledger = new BudgetLedger(pre.budget!, price);
  const recordings = new Map<string, Recording>();
  const done = (status: LiveRunStatus, detail: string | null, uncertainTaskId: string | null = null): LiveRunResult => ({
    status,
    refusals: [],
    recordings,
    notRecorded: tasks.filter((t) => !recordings.has(t.id)).map((t) => t.id),
    uncertainTaskId,
    detail,
    usage: ledger.usage(),
  });
  for (const task of tasks) {
    if (!ledger.reserve(task)) return done('STOPPED_BUDGET', ledger.stopReason);
    let res: CaptureResult;
    try {
      res = await source.capture({ task, runId, maxTokens: task.budget.maxTokens, maxTurns: task.budget.maxTurns });
    } catch (e) {
      if (e instanceof UncertainCaptureError) {
        // the call may have been billed: keep the reservation as spent at its ceiling, and stop until a person reconciles
        ledger.commit(task.budget.maxTokens, 0, task.budget.maxTurns);
        return done('STOPPED_UNCERTAIN', 'outcome unknown: reconcile before any retry', task.id);
      }
      ledger.release();
      return done('STOPPED_FAILED', `capture failed for ${task.id}`);
    }
    const turnTokens = res.recording.turns.reduce((a, t) => a + t.tokensIn + t.tokensOut, 0);
    ledger.commit(res.usage.tokensIn, res.usage.tokensOut, res.usage.requests);
    if (turnTokens > res.usage.tokensIn + res.usage.tokensOut) return done('STOPPED_FAILED', `the recording of ${task.id} reports more tokens than the billed usage`);
    if (ledger.stopReason) {
      // the task was recorded and paid for, but the budget is now gone: keep it, then stop
      recordings.set(task.id, toRecording(task, res, source, runId, pre, input.now()));
      return done('STOPPED_BUDGET', ledger.stopReason);
    }
    recordings.set(task.id, toRecording(task, res, source, runId, pre, input.now()));
  }
  return done('COMPLETED', null);
}

function toRecording(task: GoldenTask, res: CaptureResult, source: CaptureSource, runId: string, pre: LivePreconditions, at: string): Recording {
  const base = { taskId: task.id, adapterId: source.adapterId, model: source.model, contractVersion: res.recording.contractVersion, turns: res.recording.turns, patch: res.recording.patch, finishedWith: res.recording.finishedWith, datasetVersion: DATASET_VERSION };
  if (source.mode === 'mock') return { ...base, origin: 'MOCK' };
  return { ...base, origin: 'RECORDED', capture: { runId, approvalRef: pre.budget!.ref, providerEvidenceRef: pre.providerVerified!.evidenceRef, capturedAt: at } };
}
