import { describe, expect, it } from 'vitest';
import { adminRunOf, anyFlag, isSandboxKind, runStateOf, stateTone } from './builder-admin';

describe('admin run oversight (UI-M10-18)', () => {
  const item = {
    id: '0194a1b2-1111-7222-8333-444455556666',
    orgId: '0194a1b2-2222-7222-8333-444455556666',
    kind: 'webapp',
    state: 'budget_exceeded',
    reason: null,
    budget: { maxTokens: 1000, maxCostMinor: 5000, maxMinutes: 30 },
    usage: { tokensIn: 700, tokensOut: 300, costMinor: 5000, steps: 4 },
    dataRegion: 'sa-central',
    createdAt: '2026-11-18T10:00:00Z',
    finishedAt: null,
    flags: { budgetBreach: true, deniedApproval: false, escalated: false },
    prompt: 'must never be read',
  };
  it('reads metadata only and carries the flags', () => {
    const r = adminRunOf(item)!;
    expect(r.usage).toEqual({ tokens: 1000, costMinor: 5000, steps: 4 });
    expect(r.flags.budgetBreach).toBe(true);
    expect(anyFlag(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain('must never be read');
  });
  it('drops items without an id and survives odd shapes', () => {
    expect(adminRunOf(null)).toBeNull();
    expect(adminRunOf({ kind: 'x' })).toBeNull();
    const r = adminRunOf({ id: 'a', budget: 'x', usage: null, flags: 3 })!;
    expect(r.budget).toBeNull();
    expect(r.usage).toBeNull();
    expect(anyFlag(r)).toBe(false);
  });
  it('filters and tones', () => {
    expect(runStateOf('failed')).toBe('failed');
    expect(runStateOf('nope')).toBeUndefined();
    expect(stateTone('budget_exceeded')).toBe('danger');
  });
});

describe('sandbox fleet (UI-M10-19)', () => {
  it('picks sandbox kinds out of the resource inventory', () => {
    expect(isSandboxKind('sandbox_node')).toBe(true);
    expect(isSandboxKind('Sandbox')).toBe(true);
    expect(isSandboxKind('compute_instance')).toBe(false);
  });
});
