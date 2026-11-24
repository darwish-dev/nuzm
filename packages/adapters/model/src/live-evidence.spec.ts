import { describe, expect, it } from 'vitest';
import {
  LIVE_REQUIRED_DECISIONS,
  LiveRunRefused,
  assertLiveEvidence,
  assessLiveEvidence,
  type LiveEvidenceRow,
} from './live-evidence';

// SYNTHETIC references: no real decision, ticket or approver is named here.
const NOW = new Date('2026-12-01T00:00:00Z');
const ctx = { provider: 'anthropic', now: NOW, nodeEnv: 'test' };
const row = (decision: string, over: Record<string, unknown> = {}): LiveEvidenceRow =>
  ({
    decision,
    ref: `synthetic-ref-${decision}`,
    recordedBy: 'synthetic-owner',
    recordedAt: '2026-11-30T10:00:00Z',
    provider: 'anthropic',
    environment: 'non-production',
    outcome: 'approved',
    ...over,
  }) as LiveEvidenceRow;
const full = () => LIVE_REQUIRED_DECISIONS.map((d) => row(d));

describe('live-run evidence (D2, D3, D4, D5, D6, D9)', () => {
  it('requires exactly these six decisions', () => {
    expect([...LIVE_REQUIRED_DECISIONS]).toEqual(['D2', 'D3', 'D4', 'D5', 'D6', 'D9']);
  });
  it('accepts a complete, well-formed set', () => {
    const v = assessLiveEvidence(full(), ctx);
    expect(v).toEqual({ ok: true, problems: [], standing: [...LIVE_REQUIRED_DECISIONS] });
    expect(assertLiveEvidence(full(), ctx).ok).toBe(true);
  });
  it.each(LIVE_REQUIRED_DECISIONS)('refuses when %s has no row, and says which', (d) => {
    const v = assessLiveEvidence(
      full().filter((r) => r.decision !== d),
      ctx,
    );
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual([`${d}: no valid evidence row`]);
    expect(() =>
      assertLiveEvidence(
        full().filter((r) => r.decision !== d),
        ctx,
      ),
    ).toThrow(LiveRunRefused);
  });
  it('refuses missing, empty and non-list evidence, listing every missing decision', () => {
    for (const bad of [undefined, null, {}, 'D2', 5])
      expect(assessLiveEvidence(bad, ctx).ok).toBe(false);
    expect(assessLiveEvidence([], ctx).problems).toHaveLength(6);
  });
  it('refuses placeholders, a missing approver, a bad or future date', () => {
    for (const over of [
      { ref: 'TBD' },
      { ref: '??' },
      { ref: 'ab' },
      { recordedBy: 'n/a' },
      { recordedBy: '' },
      { recordedAt: 'yesterday' },
      { recordedAt: '2026-11-30' },
      { recordedAt: '2027-01-01T00:00:00Z' },
    ]) {
      const v = assessLiveEvidence(
        [...full().filter((r) => r.decision !== 'D9'), row('D9', over)],
        ctx,
      );
      expect(v.ok, JSON.stringify(over)).toBe(false);
    }
  });
  it('refuses another provider, a production environment, an unknown decision and an unknown outcome', () => {
    for (const over of [
      { provider: 'openai' },
      { environment: 'production' },
      { outcome: 'maybe' },
      { decision: 'D1' },
    ]) {
      const rows = [...full().filter((r) => r.decision !== 'D4'), row('D4', over)];
      expect(assessLiveEvidence(rows, ctx).ok, JSON.stringify(over)).toBe(false);
    }
  });
  it('a later withdrawal revokes an approval; a later approval restores it; row order does not matter', () => {
    const withdrawn = row('D3', { outcome: 'withdrawn', recordedAt: '2026-11-30T12:00:00Z' });
    expect(assessLiveEvidence([...full(), withdrawn], ctx).problems).toEqual([
      'D3: the latest row withdraws the approval',
    ]);
    expect(assessLiveEvidence([withdrawn, ...full()], ctx).ok).toBe(false);
    const again = row('D3', { recordedAt: '2026-11-30T13:00:00Z' });
    expect(assessLiveEvidence([...full(), withdrawn, again], ctx).ok).toBe(true);
  });
  it('refuses a row that carries something shaped like a credential, without echoing it', () => {
    const secretLike = `sk-ant-${'a1'.repeat(12)}`;
    const v = assessLiveEvidence(
      [...full().filter((r) => r.decision !== 'D4'), row('D4', { ref: secretLike })],
      ctx,
    );
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v)).not.toContain(secretLike);
    expect(v.problems.join(' ')).toContain('credential');
  });
  it('never runs in a production process, whatever the evidence says', () => {
    const v = assessLiveEvidence(full(), { ...ctx, nodeEnv: 'production' });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain('production');
  });
  it('a refusal lists all problems at once (the operator fixes them in one pass)', () => {
    try {
      assertLiveEvidence([row('D2', { ref: 'TBD' })], ctx);
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(LiveRunRefused);
      expect((e as LiveRunRefused).problems.length).toBeGreaterThanOrEqual(6);
    }
  });
});
