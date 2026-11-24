import { CATEGORY_KIND, type TaskCategory } from './categories';
import type { Check, FixtureFile, GoldenTask, PatchOp, TaskKind } from './types';

/** Authoring helpers shared by the dataset files: a `Spec` is what a person writes; `task()` turns it into a `GoldenTask` with its budget and the file-count check. */
export interface Spec {
  id: string;
  kind?: TaskKind;
  category?: TaskCategory;
  locale: 'ar' | 'en';
  title: string;
  prompt: string;
  fixture: FixtureFile[];
  checks: Check[];
  solution: PatchOp[];
  mustCall?: string[];
  maxCalls?: number;
}
const DEFAULT_CATEGORY: Record<TaskKind, TaskCategory> = {
  website: 'business-website',
  webapp: 'web-application',
  'code-edit': 'code-editing',
  'tool-calling': 'tool-calling',
};
export const task = (s: Spec): GoldenTask => {
  const category = s.category ?? DEFAULT_CATEGORY[s.kind as TaskKind];
  const kind = CATEGORY_KIND[category];
  return {
    id: s.id,
    kind,
    category,
    revision: 1,
    locale: s.locale,
    title: s.title,
    prompt: s.prompt,
    fixture: s.fixture,
    checks: [...s.checks, { type: 'max_files_changed', n: Math.max(2, s.solution.length + 1) }],
    tools: { mustCall: s.mustCall ?? [], mustNotCall: [], maxCalls: s.maxCalls ?? 6 },
    budget: { maxTurns: 6, maxTokens: kind === 'webapp' ? 60_000 : 40_000 },
    solution: s.solution,
    dataClass: 'public',
    synthetic: true,
  };
};
export const json = (o: unknown) => `${JSON.stringify(o)}\n`;
