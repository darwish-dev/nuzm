import { extractSymbols, isCodePath, parseImports, resolveImport } from '../code-intel';
import type { PlanTask } from '../planning/types';
import { compressContext, type ContextItem } from './compress';
import { outlineFile } from './outline';
import { estimateTokens } from './tokens';

/**
 * Context management for one generation turn (P3-S03). What a model sees when it writes the files of a task decides whether the files fit together: it must see the files it
 * edits, the contract (exports) of the files earlier tasks of THIS run already produced, the project's memory and the paths that exist, all inside a token budget and all as
 * untrusted data. Selection is deterministic (no model summarises anything), ranks by relevance to the task, and compresses cheapest-loss-first through `compressContext`.
 *
 * Relevance, highest first: the files the task modifies (shown whole while they fit) > the contract of files produced earlier in the run in the same directories or with
 * overlapping names > files imported by the files being edited > the project memory > the other files of the same directories (outlines).
 */
export interface GenerationContextInput {
  task: Pick<PlanTask, 'id' | 'files' | 'dependsOn'>;
  /** the project as it is at the head (before this run's change) */
  existing: ReadonlyMap<string, string>;
  /** files earlier tasks of this run have produced (path -> content), not yet applied */
  produced: ReadonlyMap<string, string>;
  /** rendered project memory (data) */
  memory: string;
  /** budget of the DATA part of the message, in estimated tokens */
  budgetTokens: number;
}
export interface GenerationContext {
  excerpts: { path: string; text: string }[];
  /** the contract (imports, exported symbols) of files produced earlier in this run */
  producedOutlines: { path: string; outline: string }[];
  memory: string;
  report: { tokens: number; budget: number; overBudget: boolean; dropped: number; steps: string[] };
}

/** What another file may rely on: the EXPORTED symbols of a file with their declaration line (a signature), nothing private. Non-code files get the usual outline. */
export function contractOutline(path: string, text: string, maxChars = 900): string {
  if (!isCodePath(path)) return outlineFile(path, text, maxChars);
  const lines = text.split('\n');
  const out = [`contract of ${path}`];
  for (const s of extractSymbols(path, text)) {
    if (!s.exported) continue;
    const decl = (lines[s.line - 1] ?? '')
      .trim()
      .replace(/\s*\{\s*$/, '')
      .slice(0, 160);
    out.push(`${decl || `export ${s.kind} ${s.name}`}`);
    if (out.join('\n').length > maxChars) break;
  }
  if (/^\s*export\s+default\b/m.test(text) && !out.some((l) => /export\s+default/.test(l)))
    out.push('export default (see the file)');
  if (out.length === 1) out.push('(exports nothing)');
  const r = out.join('\n');
  return r.length > maxChars ? `${r.slice(0, maxChars)}\n[contract cut]` : r;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const stem = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]*$/, '').toLowerCase();
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );

export function buildGenerationContext(i: GenerationContextInput): GenerationContext {
  const items: ContextItem[] = [];
  const taskDirs = new Set(i.task.files.map(dirOf));
  const taskWords = new Set(i.task.files.flatMap((f) => [...words(stem(f))]));
  const merged = new Map([...i.existing, ...i.produced]);
  // 1. the files the task edits
  const editing = i.task.files.filter((p) => i.existing.has(p));
  for (const p of editing)
    items.push({ id: `edit:${p}`, kind: 'file', path: p, text: i.existing.get(p)!, priority: 95 });
  // 2. what they import
  const seen = new Set(editing);
  for (const p of editing) {
    if (!isCodePath(p)) continue;
    for (const imp of parseImports(i.existing.get(p)!)) {
      const r = resolveImport(p, imp.spec, merged);
      if (r.ok && !seen.has(r.path) && !i.produced.has(r.path)) {
        seen.add(r.path);
        items.push({
          id: `dep:${r.path}`,
          kind: 'file',
          path: r.path,
          text: merged.get(r.path)!,
          priority: 60,
        });
      }
    }
  }
  // 3. the contract of what this run already produced
  const producedOutlines: GenerationContext['producedOutlines'] = [];
  for (const [p, text] of i.produced) {
    if (!isCodePath(p) && !p.endsWith('.json') && !p.endsWith('.sql')) continue;
    const sameDir = taskDirs.has(dirOf(p));
    const overlap = [...words(stem(p))].some((w) => taskWords.has(w));
    const priority = 55 + (sameDir ? 20 : 0) + (overlap ? 10 : 0);
    const outline = contractOutline(p, text, 900);
    items.push({ id: `produced:${p}`, kind: 'note', path: p, text: outline, priority });
  }
  // 4. memory
  if (i.memory.trim()) items.push({ id: 'memory', kind: 'memory', text: i.memory, priority: 70 });
  // 5. neighbours in the same directories (outlines only)
  for (const [p, text] of i.existing) {
    if (seen.has(p) || !taskDirs.has(dirOf(p)) || i.task.files.includes(p)) continue;
    items.push({ id: `near:${p}`, kind: 'file', path: p, text, priority: 40 });
  }
  const r = compressContext(items, Math.max(200, i.budgetTokens));
  const excerpts: GenerationContext['excerpts'] = [];
  let memory = '';
  for (const k of r.kept) {
    if (k.id === 'memory') memory = k.text;
    else if (k.id.startsWith('produced:'))
      producedOutlines.push({ path: k.path!, outline: k.text });
    else if (k.kind === 'file' && k.path) excerpts.push({ path: k.path, text: k.text });
  }
  return {
    excerpts: excerpts.slice(0, 6),
    producedOutlines: producedOutlines.slice(0, 30),
    memory,
    report: {
      tokens: r.tokens,
      budget: r.budget,
      overBudget: r.overBudget,
      dropped: r.dropped.length,
      steps: r.steps,
    },
  };
}

/** estimated tokens of a whole generation message, so a caller can check it against the model's context before asking */
export const estimateMessageTokens = (message: string): number => estimateTokens(message);
