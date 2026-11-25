import { describe, expect, it } from 'vitest';
import {
  THRESHOLDS_VERSION as V,
  acceptanceFrom,
  checkThresholdEvent,
  foldThresholdGovernance,
  type ThresholdEvent,
} from './index';

const at = (n: number) => `2026-12-0${n}T00:00:00.000Z`;
const propose = (by = 'dev', n = 1, summary = 'recommended set'): ThresholdEvent => ({
  type: 'propose',
  version: V,
  by,
  at: at(n),
  summary,
});
const review = (
  by: string,
  verdict: 'approve' | 'request_changes' | 'reject' = 'approve',
  n = 2,
): ThresholdEvent => ({ type: 'review', version: V, by, at: at(n), verdict, note: 'looked' });
const accept = (by = 'owner', n = 3): ThresholdEvent => ({
  type: 'accept',
  version: V,
  by,
  at: at(n),
});
const reject = (by = 'owner', n = 3): ThresholdEvent => ({
  type: 'reject',
  version: V,
  by,
  at: at(n),
  reason: 'too strict',
});
/** appends through the rules, like the service does; throws when refused */
const log = (...evs: ThresholdEvent[]): ThresholdEvent[] => {
  const out: ThresholdEvent[] = [];
  for (const e of evs) {
    const c = checkThresholdEvent(out, e);
    if (!c.ok) throw new Error(c.error);
    out.push(e);
  }
  return out;
};
const refused = (l: ThresholdEvent[], e: ThresholdEvent) => {
  const c = checkThresholdEvent(l, e);
  return c.ok ? 'ok' : c.error;
};

describe('threshold governance', () => {
  it('starts with nothing proposed and no acceptance', () => {
    const g = foldThresholdGovernance([]);
    expect(g.state).toBe('NOT_PROPOSED');
    expect(acceptanceFrom([])).toBeNull();
  });
  it('follows proposal, review and the owner decision; the acceptance is the recorded event, nothing else', () => {
    expect(foldThresholdGovernance(log(propose())).state).toBe('PROPOSED');
    expect(foldThresholdGovernance(log(propose(), review('rev1'))).state).toBe('UNDER_REVIEW');
    const l = log(propose(), review('rev1'), accept('owner'));
    expect(foldThresholdGovernance(l)).toMatchObject({ state: 'ACCEPTED', decidedBy: 'owner' });
    expect(acceptanceFrom(l)).toEqual({ version: V, acceptedBy: 'owner', acceptedAt: at(3) });
  });
  it('cannot be accepted without a proposal, without an approving review, or by the proposer', () => {
    expect(refused([], accept())).toMatch(/no proposal/);
    expect(refused(log(propose()), accept())).toMatch(/approving the proposal/);
    expect(refused(log(propose('owner'), review('rev1')), accept('owner'))).toMatch(/proposer/);
    // the only approving review is the accepter's own: not enough
    expect(refused(log(propose(), review('owner')), accept('owner'))).toMatch(
      /approving the proposal/,
    );
  });
  it('a review that asks for changes or rejects blocks acceptance until a new proposal', () => {
    for (const v of ['request_changes', 'reject'] as const) {
      const l = log(propose(), review('a'), review('b', v));
      expect(foldThresholdGovernance(l).state).toBe('CHANGES_REQUESTED');
      expect(refused(l, accept())).toMatch(/proposed again/);
      // a new proposal starts a new round: the old reviews do not carry over
      const l2 = log(...l, propose('dev', 4, 'revised'));
      expect(foldThresholdGovernance(l2)).toMatchObject({ state: 'PROPOSED', reviews: [] });
      expect(refused(l2, accept())).toMatch(/approving the proposal/);
    }
  });
  it('reviews: not the proposer, once per round, a note and a valid verdict are required, only while open', () => {
    const l = log(propose('dev'), review('rev1'));
    expect(refused(l, review('dev'))).toMatch(/proposer/);
    expect(refused(l, review('rev1'))).toMatch(/already reviewed/);
    expect(refused(l, { ...review('rev2'), note: '  ' } as ThresholdEvent)).toMatch(/note/);
    expect(
      refused(l, { ...review('rev2'), verdict: 'maybe' } as unknown as ThresholdEvent),
    ).toMatch(/verdict/);
    expect(refused([], review('rev1'))).toMatch(/no proposal/);
    expect(refused(log(propose(), review('rev1'), accept()), review('rev2'))).toMatch(
      /already ACCEPTED/,
    );
  });
  it('a rejection needs a reason and withdraws an earlier acceptance; the version can then only be re-proposed', () => {
    const accepted = log(propose(), review('rev1'), accept());
    expect(refused(accepted, { ...reject(), reason: '' } as ThresholdEvent)).toMatch(/reason/);
    const l = log(...accepted, reject('owner', 4));
    expect(foldThresholdGovernance(l)).toMatchObject({
      state: 'REJECTED',
      reason: 'too strict',
      acceptance: null,
    });
    expect(acceptanceFrom(l)).toBeNull();
    expect(refused(l, accept())).toMatch(/rejected/);
    expect(refused(l, reject())).toMatch(/already rejected/);
    expect(refused([], reject())).toMatch(/no proposal/);
    expect(foldThresholdGovernance(log(...l, propose('dev', 5))).state).toBe('PROPOSED');
  });
  it('an accepted version cannot be proposed again (a change of the list is a new version)', () => {
    expect(refused(log(propose(), review('rev1'), accept()), propose('dev', 4))).toMatch(
      /new version/,
    );
  });
  it('events for another version are refused and ignored by the fold', () => {
    const other = { ...propose(), version: '1-proposed' } as ThresholdEvent;
    expect(refused([], other)).toMatch(/in force/);
    expect(foldThresholdGovernance([other, accept()]).state).toBe('NOT_PROPOSED');
  });
  it('a hand-edited log cannot manufacture an acceptance: the fold re-applies the rules', () => {
    expect(acceptanceFrom([accept('owner')])).toBeNull();
    expect(acceptanceFrom([propose('owner'), review('rev1'), accept('owner')])).toBeNull(); // proposer accepted
    expect(acceptanceFrom([propose(), accept('owner')])).toBeNull(); // no review
    expect(acceptanceFrom([propose(), review('rev1'), accept('owner')])).not.toBeNull();
  });
  it('blank actor or time is refused; the noBaselineAllowed flag is carried only when explicitly true', () => {
    expect(refused([], { ...propose(), by: ' ' } as ThresholdEvent)).toMatch(/who/);
    expect(refused([], { ...propose(), at: '' } as ThresholdEvent)).toMatch(/time/);
    expect(refused([], { ...propose(), summary: '' } as ThresholdEvent)).toMatch(/summary/);
    const l = log(propose(), review('rev1'), {
      ...accept(),
      noBaselineAllowed: true,
    } as ThresholdEvent);
    expect(acceptanceFrom(l)?.noBaselineAllowed).toBe(true);
  });
  it('folds a long log quickly (no exponential re-checking)', () => {
    const evs: ThresholdEvent[] = [];
    for (let i = 0; i < 200; i++) evs.push(propose('dev', 1), review(`r${i}`, 'approve', 2));
    const t0 = Date.now();
    foldThresholdGovernance(evs);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
