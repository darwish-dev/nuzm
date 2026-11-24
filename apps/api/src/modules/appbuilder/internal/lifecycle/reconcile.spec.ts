import { describe, expect, it } from 'vitest';
import { reconcile, type ReservationRows, type RunCounters, type RunUsageRows } from './reconcile';

const usage = (o: Partial<RunUsageRows> = {}): RunUsageRows => ({
  calls: 2,
  okCalls: 2,
  tokensIn: 1400n,
  tokensOut: 600n,
  credits: 18n,
  costMinor: null,
  modelRefs: ['mock-a/m'],
  realProvider: false,
  ...o,
});
const run = (o: Partial<RunCounters> = {}): RunCounters => ({
  tokensIn: 1400n,
  tokensOut: 600n,
  spentCredits: 18n,
  ...o,
});
const res = (o: Partial<ReservationRows> = {}): ReservationRows => ({
  held: 0,
  settledCredits: 18n,
  settled: 2,
  ...o,
});
const state = { tokensIn: 1400, tokensOut: 600, credits: '18' };
const failed = (r: ReturnType<typeof reconcile>) =>
  r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('wallet reconciliation of a lifecycle run', () => {
  it('four records that agree reconcile', () => {
    expect(reconcile(state, usage(), run(), res())).toMatchObject({ ok: true });
  });
  it('a model call the lifecycle never accounted for (crash between settle and checkpoint) is reported, never silently absorbed', () => {
    const r = reconcile({ ...state, tokensIn: 700, credits: '9' }, usage(), run(), res());
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(['state_tokens_in_equals_usage', 'state_credits_equals_usage']);
  });
  it('a held reservation at the end of a run (locked credit with no usage row) and a settled amount that differs from usage are reported', () => {
    expect(failed(reconcile(state, usage(), run(), res({ held: 1 })))).toEqual([
      'no_held_reservation_left',
    ]);
    expect(failed(reconcile(state, usage(), run(), res({ settledCredits: 17n })))).toEqual([
      'settled_reservations_equal_usage_credits',
    ]);
  });
  it('run counters that differ, or a missing run row, are reported', () => {
    expect(failed(reconcile(state, usage(), run({ spentCredits: 20n }), res()))).toEqual([
      'run_credits_equals_usage',
    ]);
    expect(failed(reconcile(state, usage(), null, res()))).toEqual(['run_row_present']);
  });
  it('a run that made no model call reconciles at zero', () => {
    const z = usage({
      calls: 0,
      okCalls: 0,
      tokensIn: 0n,
      tokensOut: 0n,
      credits: 0n,
      modelRefs: [],
    });
    expect(
      reconcile(
        { tokensIn: 0, tokensOut: 0, credits: '0' },
        z,
        run({ tokensIn: 0n, tokensOut: 0n, spentCredits: 0n }),
        res({ settledCredits: 0n, settled: 0 }),
      ).ok,
    ).toBe(true);
  });
});
