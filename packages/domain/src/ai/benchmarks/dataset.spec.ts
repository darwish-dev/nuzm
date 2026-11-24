import { describe, expect, it } from 'vitest';
import {
  CATEGORY_KIND,
  GOLDEN_TASKS,
  GoldenTaskRegistry,
  MIN_TASKS_PER_CATEGORY,
  TASK_CATEGORIES,
  buildManifest,
  proveTask,
  referenceRecording,
  replayTask,
  scoreRun,
  validateDataset,
} from './index';

describe('dataset structure', () => {
  it('is well formed: unique ids, valid paths, no secrets, satisfiable check targets, kinds match categories', () => {
    expect(validateDataset(GOLDEN_TASKS)).toEqual([]);
    expect(() => new GoldenTaskRegistry(GOLDEN_TASKS)).not.toThrow();
  });
  it('covers all 23 categories with at least the minimum number of tasks each, in both languages overall', () => {
    expect(TASK_CATEGORIES).toHaveLength(23);
    for (const c of TASK_CATEGORIES) {
      expect(GOLDEN_TASKS.filter((t) => t.category === c).length, c).toBeGreaterThanOrEqual(MIN_TASKS_PER_CATEGORY);
      expect(CATEGORY_KIND[c]).toBeDefined();
    }
    const ar = GOLDEN_TASKS.filter((t) => t.locale === 'ar').length;
    expect(ar / GOLDEN_TASKS.length).toBeGreaterThan(0.2);
  });
  it('the registry refuses an ill-formed dataset (fail closed) and filters', () => {
    const bad = [...GOLDEN_TASKS, { ...GOLDEN_TASKS[0]!, kind: 'tool-calling' as const }];
    expect(() => new GoldenTaskRegistry(bad)).toThrow(/invalid golden dataset/);
    const reg = new GoldenTaskRegistry(GOLDEN_TASKS);
    expect(reg.list({ category: 'flutter-application' })).toHaveLength(3);
    expect(reg.list({ kind: 'tool-calling', locale: 'ar' }).length).toBeGreaterThan(0);
    expect(reg.get('land-01-cta')?.category).toBe('landing-page');
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.manifest.taskCount).toBe(GOLDEN_TASKS.length);
  });
  it('the manifest is deterministic', () => {
    expect(buildManifest(GOLDEN_TASKS).hash).toBe(buildManifest([...GOLDEN_TASKS].reverse()).hash);
  });
});

describe('every task is satisfiable and non-vacuous (mutation proof)', () => {
  for (const t of GOLDEN_TASKS) {
    it(t.id, () => {
      const p = proveTask(t);
      expect(p.satisfiable, 'reference solution passes with quality 100').toBe(true);
      expect(p.survivingMutants, 'no broken answer passes').toEqual([]);
    });
  }
  it('the reference solutions are clean on every applicable dimension (security, code quality, UI quality all 100)', () => {
    for (const t of GOLDEN_TASKS) {
      const s = scoreRun(t, replayTask(t, referenceRecording(t)));
      expect(s.dimensions.functional, t.id).toBe(100);
      for (const d of ['codeQuality', 'security', 'uiQuality'] as const) expect(s.dimensions[d] ?? 100, `${t.id} ${d}`).toBe(100);
    }
  });
});
