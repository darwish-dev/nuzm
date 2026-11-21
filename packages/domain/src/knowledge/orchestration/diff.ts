/**
 * Workspace diff (S-K6): what the customer's project looks like compared with the template version it was copied from. The BASELINE is what the copy actually wrote
 * (path → sha256, recorded once, append-only), so the comparison needs neither the template nor its files, and keeps working after the template is changed or withdrawn.
 * Pure and deterministic; lists are sorted and bounded.
 */
export interface WorkspaceDiff {
  /** in the project, not in the baseline */
  added: string[];
  /** in both, different content */
  modified: string[];
  /** in the baseline, no longer in the project */
  removed: string[];
  /** in both, identical */
  unchanged: number;
  /** files of the baseline */
  baselineFiles: number;
  /** files now in the project */
  currentFiles: number;
  /** 0..100: the share of baseline files that were modified or removed */
  departure: number;
  /** a list was cut at `DIFF_LIST_LIMIT` (the counts above stay exact) */
  truncated: boolean;
  counts: { added: number; modified: number; removed: number };
}
export const DIFF_LIST_LIMIT = 500;

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function diffWorkspace(
  baseline: Readonly<Record<string, string>>,
  current: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): WorkspaceDiff {
  const cur = current instanceof Map ? current : new Map(Object.entries(current));
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;
  for (const [path, sha] of Object.entries(baseline)) {
    const now = cur.get(path);
    if (now === undefined) removed.push(path);
    else if (now === sha) unchanged++;
    else modified.push(path);
  }
  for (const path of cur.keys()) if (!Object.hasOwn(baseline, path)) added.push(path);
  const baselineFiles = Object.keys(baseline).length;
  const cut = (l: string[]) => l.sort(byPath).slice(0, DIFF_LIST_LIMIT);
  const counts = { added: added.length, modified: modified.length, removed: removed.length };
  return {
    added: cut(added),
    modified: cut(modified),
    removed: cut(removed),
    unchanged,
    baselineFiles,
    currentFiles: cur.size,
    departure:
      baselineFiles === 0
        ? 0
        : Math.round(((modified.length + removed.length) / baselineFiles) * 100),
    truncated: Math.max(counts.added, counts.modified, counts.removed) > DIFF_LIST_LIMIT,
    counts,
  };
}
