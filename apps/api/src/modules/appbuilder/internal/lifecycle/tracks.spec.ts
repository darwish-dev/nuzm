import { describe, expect, it } from 'vitest';
import {
  LIVE_REFUSAL,
  REQUIRED_APPROVALS,
  checkApprovalEvidence,
  simulateTrackC,
  simulateTrackE,
} from './tracks';

const ev = (track: string, ids: string[], over: Record<string, unknown> = {}) => ({
  track,
  approvals: ids.map((id) => ({
    id,
    ref: `docs/approvals/${id}.md`,
    recordedAt: '2026-11-24',
    ...over,
  })),
});

describe('live-run approval evidence (a live run REFUSES without it)', () => {
  it('refuses missing, malformed, partial and wrong-track evidence, naming what is missing', () => {
    for (const t of ['C', 'E'] as const) {
      const all = REQUIRED_APPROVALS[t].map((a) => a.id);
      expect(checkApprovalEvidence(t, null)).toMatchObject({ ok: false, missing: all });
      expect(checkApprovalEvidence(t, 'x')).toMatchObject({ ok: false });
      expect(checkApprovalEvidence(t, { track: t })).toMatchObject({ ok: false, missing: all });
      expect(checkApprovalEvidence(t, ev(t === 'C' ? 'E' : 'C', all))).toMatchObject({ ok: false });
      expect(checkApprovalEvidence(t, ev(t, all.slice(1)))).toMatchObject({
        ok: false,
        missing: [all[0]],
      });
      expect(checkApprovalEvidence(t, ev(t, all, { ref: '' }))).toMatchObject({
        ok: false,
        missing: all,
      });
      expect(checkApprovalEvidence(t, ev(t, all, { recordedAt: 'someday' }))).toMatchObject({
        ok: false,
        missing: all,
      });
      expect(checkApprovalEvidence(t, ev(t, all))).toEqual({ ok: true });
    }
  });
  it('even complete evidence calls nothing: the message says so', () => {
    expect(LIVE_REFUSAL('E', { ok: true })).toContain('Nothing was called');
    expect(LIVE_REFUSAL('C', { ok: false, missing: ['D2'] })).toContain('REFUSED');
  });
});

describe('simulated runs leave the full evidence record', () => {
  it('Track C: model-backed generation, tokens and credits accounted, SIMULATED', async () => {
    const r = await simulateTrackC();
    expect(r).toMatchObject({
      track: 'C',
      mode: 'SIMULATED',
      lifecycleStatus: 'waiting_approval',
      repairRounds: 0,
    });
    expect(r.model).toEqual({ id: 'scripted-simulated', provider: 'none' });
    expect(r.tokens.in).toBeGreaterThan(0);
    expect(BigInt(r.credits)).toBeGreaterThan(0n);
    expect(r.costMinor).toBeNull(); // never guessed
    expect(r.filesGenerated).toBeGreaterThan(10);
    expect(
      r.toolInvocations.some((i) => i.tool === 'propose_files' && i.status === 'succeeded'),
    ).toBe(true);
    expect(r.toolInvocations.every((i) => i.caller === 'runner')).toBe(true);
    expect(r.build.map((b) => b.profile)).toEqual(['typecheck', 'build', 'unit-tests']);
    expect(r.build.every((b) => b.origin === 'MOCK')).toBe(true);
    expect(Object.keys(r.durations.byStep).length).toBeGreaterThan(10);
    expect(r.label).toContain('SIMULATED');
  });
  it('Track E: a failing build, an automated repair, a passing rebuild, SIMULATED', async () => {
    const r = await simulateTrackE();
    expect(r).toMatchObject({
      track: 'E',
      mode: 'SIMULATED',
      lifecycleStatus: 'waiting_approval',
      repairRounds: 1,
      model: null,
    });
    expect(r.build.map((b) => `${b.profile}:${b.status}`)).toEqual([
      'typecheck:failed',
      'typecheck:completed',
      'build:completed',
      'unit-tests:completed',
    ]);
    expect(r.tokens).toEqual({ in: 0, out: 0 });
  });
});
