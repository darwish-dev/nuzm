import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './verify';

/**
 * P3-S08: the owner's recorded approvals, read from the decision log (section 6) of `docs/parallel/OWNER-APPROVAL-PACK.md`.
 * An approval counts ONLY when its row has a non-empty reference (signed document id, ticket or dated message) in the Reference column. A blank reference,
 * a row that is not in the table, or text elsewhere in the document is NOT an approval (the pack says so itself: "a blank reference means undecided").
 * Nothing here decides anything: it reads what the owner recorded.
 */
export interface RecordedApproval {
  id: string;
  decision: string;
  reference: string;
  date: string;
  by: string;
}
export interface ApprovalRegistry {
  recorded: Map<string, RecordedApproval>;
  has(id: string): boolean;
  missing(ids: readonly string[]): string[];
}

const PLACEHOLDER = /^\s*(\(none recorded\)|none|n\/a|tbd|-|—|\s*)\s*$/i;

export function parseDecisionLog(markdown: string): RecordedApproval[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^##\s+6\.\s+Decision log/i.test(l));
  if (start < 0) return [];
  const out: RecordedApproval[] = [];
  let header: string[] | null = null;
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break; // next section
    if (!l.trim().startsWith('|')) continue;
    const cells = l
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (header === null) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const h = header;
    const col = (n: string) => cells[h.indexOf(n)] ?? '';
    const idCell = col('id');
    const reference = col('reference');
    if (PLACEHOLDER.test(idCell) || PLACEHOLDER.test(reference)) continue;
    for (const id of idCell
      .split(/[,;/]|\band\b/)
      .map((s) => s.replace(/[*`]/g, '').trim())
      .filter(Boolean))
      out.push({ id, decision: col('decision'), reference, date: col('date'), by: col('by') });
  }
  return out;
}

export function loadApprovals(root = repoRoot()): ApprovalRegistry {
  const f = join(root, 'docs/parallel/OWNER-APPROVAL-PACK.md');
  const rows = existsSync(f) ? parseDecisionLog(readFileSync(f, 'utf8')) : [];
  return registryOf(rows);
}
export function registryOf(rows: readonly RecordedApproval[]): ApprovalRegistry {
  const recorded = new Map(rows.map((r) => [r.id.toUpperCase(), r] as const));
  return {
    recorded,
    has: (id) => recorded.has(id.toUpperCase()),
    missing: (ids) => ids.filter((i) => !recorded.has(i.toUpperCase())),
  };
}
