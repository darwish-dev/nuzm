import { describe, expect, it } from 'vitest';
import {
  applyFallbackPolicy,
  candidateKey,
  parseFallbackPolicy,
  type FallbackPolicy,
} from './fallback';

const c = (providerCode: string, modelId: string) => ({ providerCode, modelId });
const A = c('alpha', 'm1');
const B = c('beta', 'm2');
const C = c('gamma', 'm3');
const keys = (xs: { providerCode: string; modelId: string }[]) => xs.map(candidateKey);

describe('applyFallbackPolicy', () => {
  it("without a policy, or in any_allowed mode, every allowed candidate stays (today's behaviour)", () => {
    expect(keys(applyFallbackPolicy([A, B, C], null))).toEqual(['alpha/m1', 'beta/m2', 'gamma/m3']);
    expect(keys(applyFallbackPolicy([A, B, C], undefined))).toEqual([
      'alpha/m1',
      'beta/m2',
      'gamma/m3',
    ]);
    expect(keys(applyFallbackPolicy([A, B, C], { mode: 'any_allowed', approved: {} }))).toEqual([
      'alpha/m1',
      'beta/m2',
      'gamma/m3',
    ]);
  });
  it('approved_only with nothing approved leaves only the primary', () => {
    expect(keys(applyFallbackPolicy([A, B, C], { mode: 'approved_only', approved: {} }))).toEqual([
      'alpha/m1',
    ]);
  });
  it('keeps only the candidates approved for an earlier one, in ranked order', () => {
    const p: FallbackPolicy = { mode: 'approved_only', approved: { 'alpha/m1': ['gamma/m3'] } };
    expect(keys(applyFallbackPolicy([A, B, C], p))).toEqual(['alpha/m1', 'gamma/m3']);
  });
  it('approval is directional: B→A does not approve A as a fallback for B', () => {
    const p: FallbackPolicy = { mode: 'approved_only', approved: { 'alpha/m1': ['beta/m2'] } };
    expect(keys(applyFallbackPolicy([B, A], p))).toEqual(['beta/m2']);
    expect(keys(applyFallbackPolicy([A, B], p))).toEqual(['alpha/m1', 'beta/m2']);
  });
  it('chains: A→B and B→C make C eligible after B', () => {
    const p: FallbackPolicy = {
      mode: 'approved_only',
      approved: { 'alpha/m1': ['beta/m2'], 'beta/m2': ['gamma/m3'] },
    };
    expect(keys(applyFallbackPolicy([A, B, C], p))).toEqual(['alpha/m1', 'beta/m2', 'gamma/m3']);
    // but a candidate approved only for one that is not itself eligible stays out
    const q: FallbackPolicy = { mode: 'approved_only', approved: { 'beta/m2': ['gamma/m3'] } };
    expect(keys(applyFallbackPolicy([A, B, C], q))).toEqual(['alpha/m1']);
  });
  it('can only remove, never add: a policy naming a candidate that was not allowed changes nothing', () => {
    const p: FallbackPolicy = {
      mode: 'approved_only',
      approved: { 'alpha/m1': ['evil/x', 'beta/m2'] },
    };
    expect(keys(applyFallbackPolicy([A, B], p))).toEqual(['alpha/m1', 'beta/m2']);
    expect(applyFallbackPolicy([], p)).toEqual([]);
  });
  it('does not mutate its input', () => {
    const ranked = [A, B];
    applyFallbackPolicy(ranked, { mode: 'approved_only', approved: {} });
    expect(ranked).toHaveLength(2);
  });
});

describe('parseFallbackPolicy', () => {
  it('accepts a well-formed policy and de-duplicates', () => {
    expect(
      parseFallbackPolicy({
        mode: 'approved_only',
        approved: { 'claude/claude-opus-5-5': ['openai/m', 'openai/m'] },
      }),
    ).toEqual({
      mode: 'approved_only',
      approved: { 'claude/claude-opus-5-5': ['openai/m'] },
    });
    expect(parseFallbackPolicy({ mode: 'any_allowed' })).toEqual({
      mode: 'any_allowed',
      approved: {},
    });
  });
  it('rejects anything malformed (the caller keeps the safe default)', () => {
    for (const bad of [
      null,
      'x',
      5,
      [],
      {},
      { mode: 'all' },
      { mode: 'approved_only', approved: [] },
      { mode: 'approved_only', approved: { 'no-slash': [] } },
      { mode: 'approved_only', approved: { 'a/b': ['c'] } },
      { mode: 'approved_only', approved: { 'a/b': [1] } },
      { mode: 'approved_only', approved: { 'A/b': [] } },
      {
        mode: 'approved_only',
        approved: { 'a/b': Array.from({ length: 33 }, (_, i) => `p/m${i}`) },
      },
    ])
      expect(parseFallbackPolicy(bad), JSON.stringify(bad)).toBeNull();
  });
});
