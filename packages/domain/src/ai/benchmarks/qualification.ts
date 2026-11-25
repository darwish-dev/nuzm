import { THRESHOLDS_VERSION } from './thresholds';
import type { GateDecision, SecurityReviewRecord } from './gate';
import type { HumanAcceptanceResult } from './review';
import { isBlank } from './budget';
import { DATASET_VERSION } from './registry';

/**
 * Model qualification workflow: the record that says "this adapter + model is qualified for the agent, against dataset D and thresholds T". A pure state machine: every event is
 * validated against the current state and the evidence, an illegal or unsupported event returns an error and changes nothing, and a record is only ever QUALIFIED through an owner
 * approval that follows a passing gate, a measured human acceptance and a passed security review (and by a person other than the proposer).
 *
 *   PROPOSED --attach_evidence--> EVIDENCE_ATTACHED --record_reviews--> UNDER_REVIEW --approve--> QUALIFIED
 *   any non-final --reject--> REJECTED        QUALIFIED --suspend--> SUSPENDED --reinstate(new evidence)--> UNDER_REVIEW
 *   QUALIFIED/SUSPENDED --(dataset or thresholds changed)--> EXPIRED (effective state; a new record is needed)
 */
export type QualificationState =
  'PROPOSED' | 'EVIDENCE_ATTACHED' | 'UNDER_REVIEW' | 'QUALIFIED' | 'SUSPENDED' | 'REJECTED';
export type EffectiveState = QualificationState | 'EXPIRED';

export interface QualificationEvidence {
  reportFingerprint: string;
  evidenceLabel: string;
  datasetVersion: string;
  gate: Pick<GateDecision, 'allowed' | 'status'>;
}
export interface QualificationRecord {
  id: string;
  adapterId: string;
  model: string;
  datasetVersion: string;
  thresholdsVersion: string;
  state: QualificationState;
  proposedBy: string;
  evidence: QualificationEvidence | null;
  humanReview: HumanAcceptanceResult | null;
  securityReview: SecurityReviewRecord | null;
  approvedBy: string | null;
  approvedAt: string | null;
  history: { at: string; event: string; by: string; note?: string }[];
}
export type QualificationEvent =
  | { type: 'attach_evidence'; by: string; at: string; evidence: QualificationEvidence }
  | {
      type: 'record_reviews';
      by: string;
      at: string;
      humanReview: HumanAcceptanceResult;
      securityReview: SecurityReviewRecord;
    }
  | { type: 'approve'; by: string; at: string }
  | { type: 'reject'; by: string; at: string; reason: string }
  | { type: 'suspend'; by: string; at: string; reason: string }
  | { type: 'reinstate'; by: string; at: string; evidence: QualificationEvidence };
export type StepResult = { ok: true; record: QualificationRecord } | { ok: false; error: string };

export function proposeQualification(input: {
  id: string;
  adapterId: string;
  model: string;
  proposedBy: string;
  at: string;
  datasetVersion?: string;
}): QualificationRecord {
  return {
    id: input.id,
    adapterId: input.adapterId,
    model: input.model,
    datasetVersion: input.datasetVersion ?? DATASET_VERSION,
    thresholdsVersion: THRESHOLDS_VERSION,
    state: 'PROPOSED',
    proposedBy: input.proposedBy,
    evidence: null,
    humanReview: null,
    securityReview: null,
    approvedBy: null,
    approvedAt: null,
    history: [{ at: input.at, event: 'propose', by: input.proposedBy }],
  };
}
const evidenceProblem = (r: QualificationRecord, e: QualificationEvidence): string | null => {
  if (e.evidenceLabel !== 'OFFLINE_REPLAY_OF_RECORDED_RUN')
    return `evidence is ${e.evidenceLabel}: only a recorded run of the model can qualify it`;
  if (e.datasetVersion !== r.datasetVersion)
    return `evidence is for dataset ${e.datasetVersion}, the record is for ${r.datasetVersion}`;
  if (!e.gate.allowed) return `the rollout gate did not pass (${e.gate.status})`;
  return null;
};
export function stepQualification(r: QualificationRecord, ev: QualificationEvent): StepResult {
  const fail = (error: string): StepResult => ({ ok: false, error });
  if (isBlank(ev.by)) return fail('an event needs a named actor');
  const next = (patch: Partial<QualificationRecord>, note?: string): StepResult => ({
    ok: true,
    record: {
      ...r,
      ...patch,
      history: [...r.history, { at: ev.at, event: ev.type, by: ev.by, ...(note ? { note } : {}) }],
    },
  });
  switch (ev.type) {
    case 'attach_evidence': {
      if (r.state !== 'PROPOSED') return fail(`cannot attach evidence in state ${r.state}`);
      const p = evidenceProblem(r, ev.evidence);
      return p ? fail(p) : next({ state: 'EVIDENCE_ATTACHED', evidence: ev.evidence });
    }
    case 'record_reviews': {
      if (r.state !== 'EVIDENCE_ATTACHED') return fail(`cannot record reviews in state ${r.state}`);
      if (ev.humanReview.status !== 'MEASURED' || ev.humanReview.meets !== true)
        return fail('human acceptance is not measured or below the bar');
      if (ev.securityReview.passed !== true || isBlank(ev.securityReview.ref))
        return fail('the agent security review did not pass');
      return next({
        state: 'UNDER_REVIEW',
        humanReview: ev.humanReview,
        securityReview: ev.securityReview,
      });
    }
    case 'approve': {
      if (r.state !== 'UNDER_REVIEW') return fail(`cannot approve in state ${r.state}`);
      if (ev.by === r.proposedBy)
        return fail('the approver must be a different person from the proposer');
      if (!r.evidence || !r.humanReview || !r.securityReview)
        return fail('evidence or reviews are missing');
      return next({ state: 'QUALIFIED', approvedBy: ev.by, approvedAt: ev.at });
    }
    case 'reject':
      if (r.state === 'REJECTED') return fail('already rejected');
      return !isBlank(ev.reason)
        ? next({ state: 'REJECTED' }, ev.reason)
        : fail('a rejection needs a reason');
    case 'suspend':
      if (r.state !== 'QUALIFIED') return fail(`cannot suspend in state ${r.state}`);
      return !isBlank(ev.reason)
        ? next({ state: 'SUSPENDED', approvedBy: null, approvedAt: null }, ev.reason)
        : fail('a suspension needs a reason');
    case 'reinstate': {
      if (r.state !== 'SUSPENDED') return fail(`cannot reinstate in state ${r.state}`);
      const p = evidenceProblem(r, ev.evidence);
      return p ? fail(p) : next({ state: 'UNDER_REVIEW', evidence: ev.evidence });
    }
  }
}
/** The state that counts today: a record made for another dataset or thresholds version is EXPIRED however it was approved. */
export function effectiveState(
  r: QualificationRecord,
  current: { datasetVersion: string; thresholdsVersion: string } = {
    datasetVersion: DATASET_VERSION,
    thresholdsVersion: THRESHOLDS_VERSION,
  },
): EffectiveState {
  if (
    (r.state === 'QUALIFIED' || r.state === 'SUSPENDED') &&
    (r.datasetVersion !== current.datasetVersion ||
      r.thresholdsVersion !== current.thresholdsVersion)
  )
    return 'EXPIRED';
  return r.state;
}
/** Whether this adapter + model may be used for the agent: only a QUALIFIED, unexpired record. Nothing else, ever. */
export const isQualified = (
  records: readonly QualificationRecord[],
  adapterId: string,
  model: string,
): boolean =>
  records.some(
    (r) => r.adapterId === adapterId && r.model === model && effectiveState(r) === 'QUALIFIED',
  );
