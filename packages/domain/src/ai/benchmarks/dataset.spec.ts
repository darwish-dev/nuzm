import { describe, expect, it } from 'vitest';
import { DATASET_LOCK } from './dataset-lock';
import {
  DATASET_VERSION,
  classifyChange,
  diffManifests,
  nextVersion,
  type DatasetManifest,
  type ManifestEntry,
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
      expect(GOLDEN_TASKS.filter((t) => t.category === c).length, c).toBeGreaterThanOrEqual(
        MIN_TASKS_PER_CATEGORY,
      );
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
      for (const d of ['codeQuality', 'security', 'uiQuality'] as const)
        expect(s.dimensions[d] ?? 100, `${t.id} ${d}`).toBe(100);
    }
  });
});

describe('dataset versioning', () => {
  const lockManifest = (): DatasetManifest => {
    const entries: ManifestEntry[] = DATASET_LOCK.entries.map(([id, revision, hash]) => {
      const t = GOLDEN_TASKS.find((x) => x.id === id);
      return {
        id,
        revision,
        hash,
        category: t?.category ?? 'tool-calling',
        kind: t?.kind ?? 'tool-calling',
        locale: t?.locale ?? 'en',
      };
    });
    return {
      datasetVersion: DATASET_LOCK.datasetVersion,
      taskCount: entries.length,
      perCategory: {},
      entries,
      hash: DATASET_LOCK.hash,
    };
  };
  it('the live dataset equals the published lock: any change to a task needs a revision bump and a new dataset version', () => {
    const diff = diffManifests(lockManifest(), buildManifest(GOLDEN_TASKS));
    expect(diff.revisionNotBumped, 'a task changed without a higher revision').toEqual([]);
    expect(
      diff,
      'the dataset differs from dataset-lock.ts: cut a new version (bump DATASET_VERSION, regenerate the lock)',
    ).toEqual({ added: [], removed: [], changed: [], revisionNotBumped: [] });
    expect(DATASET_LOCK.datasetVersion).toBe(DATASET_VERSION);
    expect(buildManifest(GOLDEN_TASKS).hash).toBe(DATASET_LOCK.hash);
  });
  it('detects added, removed and changed tasks and classifies the change', () => {
    const prev = buildManifest(GOLDEN_TASKS);
    const t0 = GOLDEN_TASKS[0]!;
    const edited = { ...t0, prompt: `${t0.prompt} Please.` };
    const added = buildManifest([...GOLDEN_TASKS, { ...t0, id: 'extra-task-one' }]);
    expect(diffManifests(prev, added)).toMatchObject({
      added: ['extra-task-one'],
      removed: [],
      changed: [],
    });
    expect(classifyChange(diffManifests(prev, added))).toBe('minor');
    const changed = buildManifest([edited, ...GOLDEN_TASKS.slice(1)]);
    const d = diffManifests(prev, changed);
    expect(d.changed).toEqual([t0.id]);
    expect(d.revisionNotBumped).toEqual([t0.id]);
    expect(classifyChange(d)).toBe('major');
    expect(
      diffManifests(prev, buildManifest([{ ...edited, revision: 2 }, ...GOLDEN_TASKS.slice(1)]))
        .revisionNotBumped,
    ).toEqual([]);
    expect(classifyChange(diffManifests(prev, buildManifest(GOLDEN_TASKS.slice(1))))).toBe('major');
    expect(classifyChange(diffManifests(prev, prev))).toBe('none');
    expect(nextVersion('2.3.4', 'minor')).toBe('2.4.0');
    expect(nextVersion('2.3.4', 'major')).toBe('3.0.0');
    expect(nextVersion('2.3.4', 'none')).toBe('2.3.4');
  });
});

describe('the 83 golden tasks stay available across the 23 categories (pinned, so a quiet change fails)', () => {
  const PINNED_COUNTS: Record<string, number> = {
    'landing-page': 3,
    'business-website': 6,
    'e-commerce': 3,
    'web-application': 6,
    'mobile-application': 3,
    'flutter-application': 3,
    'full-stack': 3,
    erp: 3,
    crm: 3,
    saas: 3,
    'backend-api': 3,
    'database-architecture': 3,
    authentication: 3,
    'ui-implementation': 3,
    'responsive-design': 3,
    'arabic-rtl': 3,
    accessibility: 3,
    'code-editing': 5,
    'multi-file-refactoring': 3,
    'bug-fixing': 4,
    'security-remediation': 4,
    'tool-calling': 6,
    'build-deployment-planning': 4,
  };
  it('has 83 tasks, exactly the pinned number in each of the 23 categories, each at least the minimum the gate needs', () => {
    expect(GOLDEN_TASKS).toHaveLength(83);
    expect(new Set(GOLDEN_TASKS.map((t) => t.id)).size).toBe(83);
    const counts: Record<string, number> = {};
    for (const t of GOLDEN_TASKS) counts[t.category] = (counts[t.category] ?? 0) + 1;
    expect(counts).toEqual(PINNED_COUNTS);
    expect(Object.keys(counts)).toHaveLength(23);
    expect(new Set(Object.keys(counts))).toEqual(new Set(TASK_CATEGORIES));
    for (const c of TASK_CATEGORIES)
      expect(counts[c], c).toBeGreaterThanOrEqual(MIN_TASKS_PER_CATEGORY);
    expect(Object.values(PINNED_COUNTS).reduce((a, b) => a + b, 0)).toBe(83);
  });
  it('the published lock is the pinned version and hash, and lists exactly the live task ids', () => {
    // a deliberate pin: cutting a new dataset version means updating these two lines on purpose
    expect(DATASET_LOCK.datasetVersion).toBe('2.1.0');
    expect(DATASET_LOCK.hash).toBe(
      'b71c1377278190e2f3e2599790d05635cea1d10fdd0899fd8d1839e337e3bdae',
    );
    expect(DATASET_VERSION).toBe(DATASET_LOCK.datasetVersion);
    expect(buildManifest(GOLDEN_TASKS).hash).toBe(DATASET_LOCK.hash);
    expect(DATASET_LOCK.entries.map((e) => e[0]).sort()).toEqual(
      GOLDEN_TASKS.map((t) => t.id).sort(),
    );
    expect(DATASET_LOCK.entries).toHaveLength(83);
  });
  it('the changed task of 2.1.0 is at revision 2 and no other task moved', () => {
    const rev = (id: string) => DATASET_LOCK.entries.find((e) => e[0] === id)![1];
    expect(rev('sec-03-hardcoded-token-ar')).toBe(2);
    expect(DATASET_LOCK.entries.filter((e) => e[1] !== 1).map((e) => e[0])).toEqual([
      'sec-03-hardcoded-token-ar',
    ]);
  });
});
