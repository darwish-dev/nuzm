import { sha256Hex } from './canonical';

/**
 * Human reviewer workflow (offline, pure). A plan samples tasks of a benchmark run deterministically (seeded), assigns two NAMED reviewers per task in a balanced rotation and
 * hides the model identity (reviewers see a blind id). Reviews are validated and aggregated into the human acceptance rate the rollout gate needs. Without at least two named
 * reviewers, enough reviewed tasks and enough coverage the result is `NOT MEASURED` or `INCOMPLETE`, never a pass. All numbers are PROPOSED (owner decision REV).
 */
export const REVIEW_PROTOCOL = {
  minReviewers: 2,
  reviewersPerTask: 2,
  minReviewedTasks: 20,
  /** share of planned items that must have a final decision */
  minCoverage: 0.9,
  acceptanceBar: 0.7,
  scale: { min: 1, max: 5 },
  /** accept needs correctness and security of at least this */
  acceptFloor: 3,
  status: 'PROPOSED',
} as const;

export interface Reviewer {
  id: string;
  /** a real person's name: required */
  name: string;
}
export interface ReviewItem {
  taskId: string;
  /** what the reviewer sees instead of the model/adapter name */
  blindId: string;
  reviewerIds: [string, string];
}
export interface ReviewPlan {
  planId: string;
  /** fingerprint of the benchmark report the reviewed recordings belong to */
  runRef: string;
  seed: string;
  reviewers: Reviewer[];
  items: ReviewItem[];
}
export interface Review {
  planId: string;
  taskId: string;
  reviewerId: string;
  scores: { correctness: number; quality: number; ui: number; security: number };
  accept: boolean;
  /** an adjudication by a reviewer who was not assigned to the item (settles a dispute) */
  adjudication?: boolean;
  notes?: string;
}

export function createReviewPlan(input: {
  runRef: string;
  seed: string;
  reviewers: readonly Reviewer[];
  taskIds: readonly string[];
  sampleSize?: number;
}): { ok: true; plan: ReviewPlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const named = input.reviewers.filter((r) => r.name.trim().length > 1 && r.id.trim().length > 0);
  if (new Set(named.map((r) => r.id)).size !== named.length) errors.push('reviewer ids must be unique');
  if (named.length !== input.reviewers.length) errors.push('every reviewer needs an id and a name');
  if (named.length < REVIEW_PROTOCOL.minReviewers) errors.push(`at least ${REVIEW_PROTOCOL.minReviewers} named reviewers are needed`);
  const size = input.sampleSize ?? Math.min(input.taskIds.length, 40);
  if (size < REVIEW_PROTOCOL.minReviewedTasks) errors.push(`a plan must cover at least ${REVIEW_PROTOCOL.minReviewedTasks} tasks`);
  if (size > input.taskIds.length) errors.push('the sample is larger than the number of tasks');
  if (new Set(input.taskIds).size !== input.taskIds.length) errors.push('task ids must be unique');
  if (errors.length > 0) return { ok: false, errors };
  const picked = [...input.taskIds]
    .map((id) => ({ id, h: sha256Hex(`${input.seed}:${id}`) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
    .slice(0, size);
  const n = named.length;
  const items: ReviewItem[] = picked.map((p, i) => ({
    taskId: p.id,
    blindId: `blind-${sha256Hex(`blind:${input.seed}:${p.id}`).slice(0, 10)}`,
    reviewerIds: [named[i % n]!.id, named[(i + 1) % n]!.id],
  }));
  return { ok: true, plan: { planId: `plan-${sha256Hex(`${input.runRef}:${input.seed}`).slice(0, 12)}`, runRef: input.runRef, seed: input.seed, reviewers: named, items } };
}

/** Validates one review against the plan and the reviews already submitted. Returns the problems (empty = acceptable). */
export function validateReview(plan: ReviewPlan, existing: readonly Review[], r: Review): string[] {
  const errors: string[] = [];
  if (r.planId !== plan.planId) errors.push('review is for another plan');
  const item = plan.items.find((i) => i.taskId === r.taskId);
  if (!item) return [...errors, 'task is not in the plan'];
  if (!plan.reviewers.some((x) => x.id === r.reviewerId)) errors.push('reviewer is not named in the plan');
  const assigned = item.reviewerIds.includes(r.reviewerId);
  if (r.adjudication) {
    if (assigned) errors.push('an adjudicator must not be one of the assigned reviewers');
    if (existing.some((x) => x.taskId === r.taskId && x.adjudication === true)) errors.push('already adjudicated');
  } else if (!assigned) errors.push('reviewer is not assigned to this task');
  if (existing.some((x) => x.taskId === r.taskId && x.reviewerId === r.reviewerId)) errors.push('reviewer already reviewed this task');
  const { min, max } = REVIEW_PROTOCOL.scale;
  for (const [k, v] of Object.entries(r.scores)) if (!Number.isInteger(v) || v < min || v > max) errors.push(`score ${k} must be an integer from ${min} to ${max}`);
  if (r.accept && (r.scores.correctness < REVIEW_PROTOCOL.acceptFloor || r.scores.security < REVIEW_PROTOCOL.acceptFloor)) errors.push('a result with low correctness or security cannot be accepted');
  if ((r.notes?.length ?? 0) > 500) errors.push('notes are limited to 500 characters');
  return errors;
}

export interface HumanAcceptanceResult {
  status: 'MEASURED' | 'INCOMPLETE' | 'NOT MEASURED';
  reason: string | null;
  planned: number;
  decided: number;
  accepted: number;
  disputed: string[];
  coverage: number;
  /** accepted / decided */
  rate: number | null;
  percentAgreement: number | null;
  /** Cohen's kappa over the pairs of assigned reviewers; null when undefined (no variation) */
  kappa: number | null;
  bar: number;
  /** null unless MEASURED */
  meets: boolean | null;
}
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function summarizeReviews(plan: ReviewPlan | null, reviews: readonly Review[]): HumanAcceptanceResult {
  const empty = (status: HumanAcceptanceResult['status'], reason: string, planned = 0): HumanAcceptanceResult => ({
    status, reason, planned, decided: 0, accepted: 0, disputed: [], coverage: 0, rate: null, percentAgreement: null, kappa: null, bar: REVIEW_PROTOCOL.acceptanceBar, meets: null,
  });
  if (!plan || plan.reviewers.length < REVIEW_PROTOCOL.minReviewers) return empty('NOT MEASURED', 'no review plan with at least two named reviewers');
  const valid: Review[] = [];
  for (const r of reviews) if (validateReview(plan, valid, r).length === 0) valid.push(r);
  let decided = 0;
  let accepted = 0;
  const disputed: string[] = [];
  let both = 0;
  let agree = 0;
  let aAcc = 0;
  let bAcc = 0;
  for (const item of plan.items) {
    const [ra, rb] = item.reviewerIds.map((id) => valid.find((v) => v.taskId === item.taskId && v.reviewerId === id && !v.adjudication));
    if (!ra || !rb) continue;
    both += 1;
    if (ra.accept === rb.accept) agree += 1;
    if (ra.accept) aAcc += 1;
    if (rb.accept) bAcc += 1;
    if (ra.accept === rb.accept) {
      decided += 1;
      if (ra.accept) accepted += 1;
    } else {
      const adj = valid.find((v) => v.taskId === item.taskId && v.adjudication === true);
      if (adj) {
        decided += 1;
        if (adj.accept) accepted += 1;
      } else disputed.push(item.taskId);
    }
  }
  const coverage = plan.items.length === 0 ? 0 : r4(decided / plan.items.length);
  let kappa: number | null = null;
  if (both > 0) {
    const po = agree / both;
    const pe = (aAcc / both) * (bAcc / both) + (1 - aAcc / both) * (1 - bAcc / both);
    kappa = pe === 1 ? null : r4((po - pe) / (1 - pe));
  }
  const base = { planned: plan.items.length, decided, accepted, disputed, coverage, percentAgreement: both === 0 ? null : r4(agree / both), kappa, bar: REVIEW_PROTOCOL.acceptanceBar };
  if (decided < REVIEW_PROTOCOL.minReviewedTasks || coverage < REVIEW_PROTOCOL.minCoverage)
    return { ...base, status: 'INCOMPLETE', reason: `need at least ${REVIEW_PROTOCOL.minReviewedTasks} decided tasks and ${REVIEW_PROTOCOL.minCoverage} coverage (disputes need an adjudicator)`, rate: decided === 0 ? null : r4(accepted / decided), meets: null };
  const rate = r4(accepted / decided);
  return { ...base, status: 'MEASURED', reason: null, rate, meets: rate >= REVIEW_PROTOCOL.acceptanceBar };
}
