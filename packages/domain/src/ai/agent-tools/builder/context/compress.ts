import { sha256Hex } from '../sha256';
import { outlineFile } from './outline';
import { estimateTokens } from './tokens';

/**
 * Context compression (S-05 priority 4): fit a set of context items into a token budget, deterministically and WITHOUT a model call (a summarising model would itself cost tokens and
 * could be steered by the text it summarises). The steps run in order, cheapest loss first, and stop as soon as the budget is met: deduplicate, replace files by outlines, cut long
 * items to head and tail, fold old conversation turns into one line, drop the least important. Pinned items (the system text, the plan, the current task) are never altered or dropped.
 * If the pinned items alone exceed the budget the result says `overBudget`: the caller must shrink the task, the compressor will not silently lose a pinned item.
 */
export type ContextKind =
  'system' | 'plan' | 'memory' | 'file' | 'tool_result' | 'turn' | 'diagnostic' | 'note';
export interface ContextItem {
  id: string;
  kind: ContextKind;
  text: string;
  /** 0 (first to go) to 100 (last to go) */
  priority: number;
  pinned?: boolean;
  /** for `file` items: the path, so the outline step can summarise it */
  path?: string;
  /** for `turn` items: who said it */
  role?: 'user' | 'assistant';
}
export interface CompressedItem extends ContextItem {
  /** how the item was changed, if it was */
  change?: 'outline' | 'truncated' | 'folded';
  tokens: number;
}
export interface CompressionResult {
  kept: CompressedItem[];
  dropped: { id: string; kind: ContextKind; reason: 'duplicate' | 'budget' }[];
  tokens: number;
  budget: number;
  overBudget: boolean;
  steps: string[];
}
export const COMPRESS_LIMITS = {
  maxItems: 500,
  maxItemTokensAfterTruncate: 600,
  keepRecentTurns: 4,
} as const;

const hash = (s: string) => sha256Hex(s).slice(0, 16);

function headTail(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split('\n');
  if (lines.length < 6) {
    const chars = Math.max(40, Math.floor(maxTokens * 3));
    return text.slice(0, chars) + '\n[… cut …]';
  }
  // keep as many lines at each end as the budget allows, shrinking until the result fits
  let keep = Math.max(
    2,
    Math.floor(maxTokens / Math.max(1, estimateTokens(text) / lines.length) / 2),
  );
  for (let k = 0; k < 10; k++) {
    if (keep * 2 >= lines.length) keep = Math.floor(lines.length / 2) - 1;
    const out = `${lines.slice(0, keep).join('\n')}\n[… ${lines.length - keep * 2} lines omitted …]\n${lines.slice(-keep).join('\n')}`;
    if (estimateTokens(out) <= maxTokens || keep <= 2) return out;
    keep = Math.max(2, Math.floor(keep * 0.7));
  }
  return `${lines.slice(0, 2).join('\n')}\n[… ${lines.length - 4} lines omitted …]\n${lines.slice(-2).join('\n')}`;
}

export function compressContext(items: readonly ContextItem[], budget: number): CompressionResult {
  const steps: string[] = [];
  const dropped: CompressionResult['dropped'] = [];
  let cur: CompressedItem[] = items
    .slice(0, COMPRESS_LIMITS.maxItems)
    .map((i) => ({ ...i, tokens: estimateTokens(i.text) }));
  if (items.length > COMPRESS_LIMITS.maxItems)
    steps.push(`only the first ${COMPRESS_LIMITS.maxItems} items were considered`);
  const total = () => cur.reduce((n, i) => n + i.tokens, 0);
  const fits = () => total() <= budget;
  // lowest priority first; among equals, the earliest (oldest) first
  const order = () =>
    cur
      .map((i, idx) => ({ i, idx }))
      .filter((x) => !x.i.pinned)
      .sort((a, b) => a.i.priority - b.i.priority || a.idx - b.idx);

  // 1. duplicates (same kind and text) keep the first
  const seen = new Set<string>();
  cur = cur.filter((i) => {
    const k = `${i.kind}|${hash(i.text)}`;
    if (seen.has(k)) {
      dropped.push({ id: i.id, kind: i.kind, reason: 'duplicate' });
      return false;
    }
    seen.add(k);
    return true;
  });
  if (dropped.length) steps.push(`removed ${dropped.length} duplicate item(s)`);

  // 2. files -> outlines
  if (!fits()) {
    let n = 0;
    for (const { i } of order()) {
      if (fits()) break;
      if (i.kind !== 'file' || !i.path || i.change) continue;
      const o = outlineFile(i.path, i.text);
      const t = estimateTokens(o);
      if (t < i.tokens) {
        i.text = o;
        i.tokens = t;
        i.change = 'outline';
        n++;
      }
    }
    if (n) steps.push(`replaced ${n} file(s) by outlines`);
  }
  // 3. long items -> head and tail
  if (!fits()) {
    let n = 0;
    for (const { i } of order()) {
      if (fits()) break;
      if (i.tokens <= COMPRESS_LIMITS.maxItemTokensAfterTruncate) continue;
      i.text = headTail(i.text, COMPRESS_LIMITS.maxItemTokensAfterTruncate);
      i.tokens = estimateTokens(i.text);
      i.change = i.change ?? 'truncated';
      n++;
    }
    if (n) steps.push(`cut ${n} long item(s) to their head and tail`);
  }
  // 4. fold old conversation turns
  if (!fits()) {
    const turns = cur.filter((i) => i.kind === 'turn' && !i.pinned);
    const old = turns.slice(0, Math.max(0, turns.length - COMPRESS_LIMITS.keepRecentTurns));
    if (old.length >= 2) {
      const u = old.filter((t) => t.role === 'user').length;
      const text = `[${old.length} earlier messages omitted: ${u} from the user, ${old.length - u} from the assistant]`;
      const first = cur.findIndex((i) => i === old[0]);
      const ids = new Set(old.map((t) => t.id));
      const folded: CompressedItem = {
        id: `folded-${old[0]!.id}`,
        kind: 'turn',
        text,
        priority: 50,
        tokens: estimateTokens(text),
        change: 'folded',
      };
      cur = cur.filter((i) => !ids.has(i.id));
      cur.splice(Math.min(first, cur.length), 0, folded);
      steps.push(`folded ${old.length} earlier conversation turn(s)`);
    }
  }
  // 5. drop the least important
  if (!fits()) {
    let n = 0;
    for (const { i } of order()) {
      if (fits()) break;
      cur = cur.filter((x) => x !== i);
      dropped.push({ id: i.id, kind: i.kind, reason: 'budget' });
      n++;
    }
    if (n) steps.push(`dropped ${n} item(s) by priority`);
  }
  const tokens = total();
  return { kept: cur, dropped, tokens, budget, overBudget: tokens > budget, steps };
}
