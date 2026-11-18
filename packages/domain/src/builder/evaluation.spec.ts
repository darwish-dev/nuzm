import { describe, expect, it } from 'vitest';
import { EVAL_PROMPTS, EVAL_THRESHOLDS, mockGenerator, runEvaluation } from './evaluation';

describe('evaluation harness', () => {
  it('has 40 prompts: 20 Arabic, 20 English, 5 per category over 8 categories', () => {
    expect(EVAL_PROMPTS.length).toBe(40);
    expect(EVAL_PROMPTS.filter((p) => p.lang === 'ar').length).toBe(20);
    expect(EVAL_PROMPTS.filter((p) => p.lang === 'en').length).toBe(20);
    expect(new Set(EVAL_PROMPTS.map((p) => p.category)).size).toBe(8);
    expect(new Set(EVAL_PROMPTS.map((p) => p.id)).size).toBe(40);
  });
  it('runs end to end on the scripted mock and says plainly that it proves plumbing only', () => {
    const r = runEvaluation(mockGenerator, { model: 'mock-model' });
    expect(r.sites).toBe(40);
    expect(r.modelQuality).toBe('NOT VERIFIED');
    expect(r.rubric.status).toBe('PENDING');
    expect(r.metrics.humanRubricMean).toBeNull();
    expect(r.perSite.every((s) => s.metrics.valid)).toBe(true);
    expect(r.thresholds).toEqual(EVAL_THRESHOLDS);
    expect(r.notes.join(' ')).toMatch(/not evidence of quality/);
  }, 120_000);
});
