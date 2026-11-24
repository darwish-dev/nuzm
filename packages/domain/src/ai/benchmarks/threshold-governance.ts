import { isBlank } from './budget';
import type { ThresholdAcceptance } from './gate';
import { THRESHOLDS_VERSION } from './thresholds';

/**
 * Threshold governance (AC-AG-10): a proposal, reviews, and the owner's decision, as an append-only event log folded into one state. The owner's acceptance is RECORDED by a
 * person: no code path sets it. The rules, enforced by `checkThresholdEvent` before anything is recorded:
 *   - a proposal names exactly the thresholds version in force; a new proposal starts a new round (earlier reviews do not carry over); an ACCEPTED version cannot be re-proposed
 *     (a change of the list is a new version);
 *   - a reviewer is not the proposer, reviews once per round, and must leave a note;
 *   - an acceptance needs a proposal in the current round, at least one `approve` by someone other than the accepter, no `reject` or `request_changes` standing, and an accepter who
 *     is not the proposer (four eyes);
 *   - a rejection needs a reason, and also withdraws an earlier acceptance of that version.
 * Pure: no clock, no I/O; events carry their time.
 */
export type ReviewVerdict = 'approve' | 'request_changes' | 'reject';
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['approve', 'request_changes', 'reject'];
export type ThresholdEvent =
  | { type: 'propose'; version: string; by: string; at: string; summary: string }
  | {
      type: 'review';
      version: string;
      by: string;
      at: string;
      verdict: ReviewVerdict;
      note: string;
    }
  | { type: 'accept'; version: string; by: string; at: string; noBaselineAllowed?: boolean }
  | { type: 'reject'; version: string; by: string; at: string; reason: string };
export type ThresholdGovernanceState =
  'NOT_PROPOSED' | 'PROPOSED' | 'UNDER_REVIEW' | 'CHANGES_REQUESTED' | 'ACCEPTED' | 'REJECTED';
export interface ThresholdGovernance {
  version: string;
  state: ThresholdGovernanceState;
  proposedBy: string | null;
  proposedAt: string | null;
  summary: string | null;
  /** the standing verdict of each reviewer in the current round (a reviewer reviews once per round) */
  reviews: { by: string; at: string; verdict: ReviewVerdict; note: string }[];
  decidedBy: string | null;
  decidedAt: string | null;
  /** for REJECTED */
  reason: string | null;
  acceptance: ThresholdAcceptance | null;
}

const empty = (version: string): ThresholdGovernance => ({
  version,
  state: 'NOT_PROPOSED',
  proposedBy: null,
  proposedAt: null,
  summary: null,
  reviews: [],
  decidedBy: null,
  decidedAt: null,
  reason: null,
  acceptance: null,
});

/**
 * Folds the events of ONE version, oldest first, into the current state. An event that the rules would have refused is ignored (the log is written through `checkThresholdEvent`,
 * so this only matters for a hand-edited log: such an event never produces an ACCEPTED state).
 */
export function foldThresholdGovernance(
  events: readonly ThresholdEvent[],
  version: string = THRESHOLDS_VERSION,
): ThresholdGovernance {
  let g = empty(version);
  for (const e of events) {
    if (e.version !== version) continue;
    if (validate(g, e).ok) g = apply(g, e);
  }
  return g;
}

function apply(g: ThresholdGovernance, e: ThresholdEvent): ThresholdGovernance {
  const version = e.version;
  switch (e.type) {
    case 'propose':
      return {
        ...empty(version),
        state: 'PROPOSED',
        proposedBy: e.by,
        proposedAt: e.at,
        summary: e.summary,
      };
    case 'review': {
      const reviews = [...g.reviews, { by: e.by, at: e.at, verdict: e.verdict, note: e.note }];
      const blocked = reviews.some((r) => r.verdict !== 'approve');
      return { ...g, reviews, state: blocked ? 'CHANGES_REQUESTED' : 'UNDER_REVIEW' };
    }
    case 'accept':
      return {
        ...g,
        state: 'ACCEPTED',
        decidedBy: e.by,
        decidedAt: e.at,
        reason: null,
        acceptance: {
          version,
          acceptedBy: e.by,
          acceptedAt: e.at,
          ...(e.noBaselineAllowed === true ? { noBaselineAllowed: true } : {}),
        },
      };
    case 'reject':
      return {
        ...g,
        state: 'REJECTED',
        decidedBy: e.by,
        decidedAt: e.at,
        reason: e.reason,
        acceptance: null,
      };
  }
}

export type EventCheck = { ok: true } | { ok: false; error: string };
/** Whether `event` may be appended after `log` (the events recorded so far). */
export function checkThresholdEvent(log: readonly ThresholdEvent[], e: ThresholdEvent): EventCheck {
  return validate(foldThresholdGovernance(log, THRESHOLDS_VERSION), e);
}
function validate(g: ThresholdGovernance, e: ThresholdEvent): EventCheck {
  const no = (error: string): EventCheck => ({ ok: false, error });
  if (e.version !== THRESHOLDS_VERSION)
    return no(
      `the thresholds in force are version ${THRESHOLDS_VERSION}; an event must name exactly that version`,
    );
  if (isBlank(e.by)) return no('who is acting is required');
  if (isBlank(e.at)) return no('the time is required');
  switch (e.type) {
    case 'propose':
      if (isBlank(e.summary)) return no('a proposal needs a summary of what is proposed and why');
      if (g.state === 'ACCEPTED')
        return no('this version is already accepted; a change of the list is a new version');
      return { ok: true };
    case 'review': {
      if (!REVIEW_VERDICTS.includes(e.verdict))
        return no('verdict must be approve, request_changes or reject');
      if (isBlank(e.note)) return no('a review needs a note');
      if (g.state === 'NOT_PROPOSED') return no('there is no proposal to review');
      if (g.state === 'ACCEPTED' || g.state === 'REJECTED')
        return no(`the proposal is already ${g.state}; propose again to start a new round`);
      if (e.by === g.proposedBy) return no('the proposer cannot review their own proposal');
      if (g.reviews.some((r) => r.by === e.by))
        return no('this reviewer has already reviewed this round');
      return { ok: true };
    }
    case 'accept': {
      if (g.state === 'NOT_PROPOSED') return no('there is no proposal to accept');
      if (g.state === 'ACCEPTED') return no('already accepted');
      if (g.state === 'REJECTED') return no('the proposal was rejected; propose again');
      if (e.by === g.proposedBy) return no('the accepter cannot be the proposer (four eyes)');
      if (g.state === 'CHANGES_REQUESTED')
        return no('a review requested changes or rejected the proposal; it must be proposed again');
      if (!g.reviews.some((r) => r.verdict === 'approve' && r.by !== e.by))
        return no(
          'at least one review approving the proposal, by someone other than the accepter, is required',
        );
      return { ok: true };
    }
    case 'reject':
      if (isBlank(e.reason)) return no('a rejection needs a reason');
      if (g.state === 'NOT_PROPOSED') return no('there is no proposal to reject');
      if (g.state === 'REJECTED') return no('already rejected');
      return { ok: true };
  }
}

/** The acceptance in force for `version`, or `null`. The ONLY way a threshold acceptance exists is an `accept` event that passed `checkThresholdEvent`. */
export const acceptanceFrom = (
  events: readonly ThresholdEvent[],
  version: string = THRESHOLDS_VERSION,
): ThresholdAcceptance | null => foldThresholdGovernance(events, version).acceptance;
