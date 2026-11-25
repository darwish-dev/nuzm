import { READ_TOOL_NAMES } from '../agent-tools';
import { isAgentSensitivePath, normalizeToolPath } from '../agent-tools/paths';
import { scanForSecrets } from '../secret-scan';
import {
  CATEGORY_KIND,
  MIN_TASKS_PER_CATEGORY,
  TASK_CATEGORIES,
  type TaskCategory,
} from './categories';
import { fingerprint } from './canonical';
import type { GoldenTask, TaskKind } from './types';

/**
 * Golden-task registry and dataset versioning. A dataset is a set of tasks plus a version; its MANIFEST lists every task with a content hash and its revision. A report and a
 * recording both name the dataset version they belong to, so results of different versions are never mixed. The version is semantic: a task added or a revision bumped is a
 * minor change, a task removed or a check relaxed is major (see `classifyChange`). Changing a task's content without raising its `revision` is refused by `diffManifests`.
 */
export const DATASET_VERSION = '2.1.0';

export interface ManifestEntry {
  id: string;
  category: TaskCategory;
  kind: TaskKind;
  locale: 'ar' | 'en';
  revision: number;
  hash: string;
}
export interface DatasetManifest {
  datasetVersion: string;
  taskCount: number;
  perCategory: Partial<Record<TaskCategory, number>>;
  entries: ManifestEntry[];
  /** fingerprint of the version and the entries: changes whenever any task changes */
  hash: string;
}
export const taskHash = (t: GoldenTask): string => fingerprint(t);

export function buildManifest(
  tasks: readonly GoldenTask[],
  datasetVersion: string = DATASET_VERSION,
): DatasetManifest {
  const entries = tasks
    .map((t) => ({
      id: t.id,
      category: t.category,
      kind: t.kind,
      locale: t.locale,
      revision: t.revision,
      hash: taskHash(t),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const perCategory: DatasetManifest['perCategory'] = {};
  for (const t of tasks) perCategory[t.category] = (perCategory[t.category] ?? 0) + 1;
  return {
    datasetVersion,
    taskCount: entries.length,
    perCategory,
    entries,
    hash: fingerprint({ datasetVersion, entries }),
  };
}

export interface ManifestDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** changed content with an unchanged or lower revision: refused */
  revisionNotBumped: string[];
}
export function diffManifests(prev: DatasetManifest, next: DatasetManifest): ManifestDiff {
  const p = new Map(prev.entries.map((e) => [e.id, e]));
  const n = new Map(next.entries.map((e) => [e.id, e]));
  const diff: ManifestDiff = { added: [], removed: [], changed: [], revisionNotBumped: [] };
  for (const [id, e] of n) {
    const old = p.get(id);
    if (!old) diff.added.push(id);
    else if (old.hash !== e.hash) {
      diff.changed.push(id);
      if (e.revision <= old.revision) diff.revisionNotBumped.push(id);
    }
  }
  for (const id of p.keys()) if (!n.has(id)) diff.removed.push(id);
  return diff;
}
/** `major` when a task was removed or changed (results are no longer comparable), `minor` when only tasks were added, `none` when identical. */
export function classifyChange(d: ManifestDiff): 'none' | 'minor' | 'major' {
  if (d.removed.length > 0 || d.changed.length > 0) return 'major';
  return d.added.length > 0 ? 'minor' : 'none';
}
/** The suggested next version for a change (`1.2.3` + major -> `2.0.0`). */
export function nextVersion(current: string, change: 'none' | 'minor' | 'major'): string {
  const [maj = 0, min = 0, pat = 0] = current.split('.').map((x) => Number.parseInt(x, 10) || 0);
  if (change === 'major') return `${maj + 1}.0.0`;
  if (change === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat}`;
}

/** Structural problems of a dataset: every item is a reason the dataset must not be used. An empty list means the dataset is well formed (not that its tasks are satisfiable: see the spec's proofs). */
export function validateDataset(tasks: readonly GoldenTask[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const read = new Set<string>(READ_TOOL_NAMES);
  for (const t of tasks) {
    const at = (m: string) => problems.push(`${t.id}: ${m}`);
    if (ids.has(t.id)) at('duplicate id');
    ids.add(t.id);
    if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(t.id)) at('id must be lower-case words joined by hyphens');
    if (!TASK_CATEGORIES.includes(t.category)) at(`unknown category ${t.category}`);
    else if (CATEGORY_KIND[t.category] !== t.kind) at('kind does not match the category');
    if (!Number.isInteger(t.revision) || t.revision < 1) at('revision must be a positive integer');
    if (t.dataClass !== 'public' || t.synthetic !== true) at('must be synthetic and public');
    if (t.prompt.trim().length < 20) at('prompt too short to be a request');
    if (t.title.trim().length === 0) at('empty title');
    if (t.checks.filter((c) => c.type !== 'max_files_changed').length === 0)
      at('no content check (vacuous)');
    if (t.solution.length === 0) at('no reference solution');
    if (t.budget.maxTurns < 1 || t.budget.maxTokens < 1000 || t.tools.maxCalls < 0)
      at('budget out of range');
    for (const name of [...t.tools.mustCall, ...t.tools.mustNotCall])
      if (!read.has(name)) at(`unknown read tool ${name}`);
    const fixture = new Set<string>();
    for (const f of t.fixture) {
      const p = normalizeToolPath(f.path);
      if (!p.ok || isAgentSensitivePath(f.path)) at(`fixture path not allowed: ${f.path}`);
      if (fixture.has(f.path)) at(`fixture path twice: ${f.path}`);
      fixture.add(f.path);
      if (scanForSecrets(f.content).length > 0)
        at(`fixture carries a secret-like string: ${f.path}`);
    }
    const afterPaths = new Set(fixture);
    const seen = new Set<string>();
    for (const op of t.solution) {
      const p = normalizeToolPath(op.path);
      if (!p.ok || isAgentSensitivePath(op.path)) at(`solution path not allowed: ${op.path}`);
      if (seen.has(op.path)) at(`solution path twice: ${op.path}`);
      seen.add(op.path);
      if (op.content === null) afterPaths.delete(op.path);
      else {
        afterPaths.add(op.path);
        if (scanForSecrets(op.content).length > 0)
          at(`solution carries a secret-like string: ${op.path}`);
      }
    }
    for (const c of t.checks) {
      if (c.type === 'max_files_changed') continue;
      if (c.type !== 'file_absent' && !afterPaths.has(c.path))
        at(`check on a path the solution cannot produce: ${c.path}`);
      if ((c.type === 'matches' || c.type === 'not_matches') && !compiles(c.pattern, c.flags))
        at(`pattern does not compile: ${c.pattern}`);
    }
    if (scanForSecrets(t.prompt).length > 0) at('prompt carries a secret-like string');
  }
  for (const c of TASK_CATEGORIES) {
    const n = tasks.filter((t) => t.category === c).length;
    if (n < MIN_TASKS_PER_CATEGORY)
      problems.push(`category ${c}: ${n} task(s), at least ${MIN_TASKS_PER_CATEGORY} needed`);
  }
  return problems;
}
function compiles(pattern: string, flags?: string): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

export interface TaskFilter {
  category?: TaskCategory;
  kind?: TaskKind;
  locale?: 'ar' | 'en';
}
/** An immutable, validated, versioned set of golden tasks. Construction fails closed: an ill-formed dataset throws. */
export class GoldenTaskRegistry {
  readonly manifest: DatasetManifest;
  private readonly byId: Map<string, GoldenTask>;
  constructor(
    readonly tasks: readonly GoldenTask[],
    readonly version: string = DATASET_VERSION,
  ) {
    const problems = validateDataset(tasks);
    if (problems.length > 0)
      throw new Error(`invalid golden dataset: ${problems.slice(0, 5).join('; ')}`);
    this.byId = new Map(tasks.map((t) => [t.id, t]));
    this.manifest = buildManifest(tasks, version);
  }
  get(id: string): GoldenTask | undefined {
    return this.byId.get(id);
  }
  list(filter: TaskFilter = {}): GoldenTask[] {
    return this.tasks.filter(
      (t) =>
        (filter.category === undefined || t.category === filter.category) &&
        (filter.kind === undefined || t.kind === filter.kind) &&
        (filter.locale === undefined || t.locale === filter.locale),
    );
  }
  categories(): TaskCategory[] {
    return TASK_CATEGORIES.filter((c) => this.tasks.some((t) => t.category === c));
  }
}
