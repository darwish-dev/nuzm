/**
 * Line diff, unified-diff text and hunk application (S-05, builder tools). Pure: no clock, no filesystem, no network, no process. Everything a model or a customer can hand in
 * here is hostile text, so every loop is bounded (lines, hunks, edit distance) and a limit is a structured refusal or a coarser (still correct) diff, never a hang.
 *
 * A "line" keeps its own terminator ("a\n"), and the last line of a file without a trailing newline is its own distinct value ("b" is not "b\n"), exactly as git sees it.
 */
export const DIFF_LIMITS = {
  /** lines per side; beyond this the diff is one whole-file replacement */
  maxLines: 20_000,
  /** Myers edit-distance cap; beyond this the changed middle is one replaced block (still a correct diff, just not minimal) */
  maxEditDistance: 1_500,
  contextLines: 3,
  /** a unified diff given to `parseUnifiedDiff` */
  maxDiffChars: 2_000_000,
  maxFilesPerDiff: 200,
  maxHunksPerFile: 400,
  /** how far (in lines) a hunk may drift from its stated position and still be applied */
  maxHunkDrift: 400,
} as const;

export type EditKind = 'eq' | 'del' | 'ins';
export interface Edit {
  kind: EditKind;
  line: string;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const i = text.indexOf('\n', start);
    if (i === -1) {
      if (start < text.length) out.push(text.slice(start));
      return out;
    }
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
}

/** The edit script turning `a` into `b` (common prefix and suffix trimmed first, then Myers on the middle). */
export function diffLines(a: readonly string[], b: readonly string[]): Edit[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const mid = am.length + bm.length > 2 * DIFF_LIMITS.maxLines ? coarse(am, bm) : myers(am, bm);
  return [
    ...a.slice(0, pre).map((line): Edit => ({ kind: 'eq', line })),
    ...mid,
    ...a.slice(a.length - suf).map((line): Edit => ({ kind: 'eq', line })),
  ];
}

const coarse = (a: readonly string[], b: readonly string[]): Edit[] => [
  ...a.map((line): Edit => ({ kind: 'del', line })),
  ...b.map((line): Edit => ({ kind: 'ins', line })),
];

function myers(a: readonly string[], b: readonly string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line): Edit => ({ kind: 'ins', line }));
  if (m === 0) return a.map((line): Edit => ({ kind: 'del', line }));
  const max = Math.min(n + m, DIFF_LIMITS.maxEditDistance);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const nv = v; // mutated in place; the snapshot above is the state BEFORE round d
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && nv[off + k - 1]! < nv[off + k + 1]!)) x = nv[off + k + 1]!;
      else x = nv[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      nv[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = nv;
  }
  if (found < 0) return coarse(a, b); // edit distance over the cap: a correct, non-minimal diff
  // backtrack
  const out: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!; // state before round d = result of round d-1
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vv[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ kind: 'eq', line: a[x - 1]! });
      x--;
      y--;
    }
    if (x === prevX) out.push({ kind: 'ins', line: b[y - 1]! });
    else out.push({ kind: 'del', line: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    out.push({ kind: 'eq', line: a[x - 1]! });
    x--;
    y--;
  }
  return out.reverse();
}

export interface HunkLine {
  kind: EditKind;
  /** the line including its terminator */
  text: string;
}
export interface Hunk {
  /** 1-based start in the old file (0 when the old side is empty) */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Hunks (with context) of an edit script. An identical pair has no hunks. */
export function toHunks(
  edits: readonly Edit[],
  context: number = DIFF_LIMITS.contextLines,
): Hunk[] {
  const hunks: Hunk[] = [];
  const changeIdx: number[] = [];
  edits.forEach((e, i) => {
    if (e.kind !== 'eq') changeIdx.push(i);
  });
  if (changeIdx.length === 0) return hunks;
  // old/new line numbers before each edit
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let nn = 1;
  for (const e of edits) {
    oldNo.push(o);
    newNo.push(nn);
    if (e.kind !== 'ins') o++;
    if (e.kind !== 'del') nn++;
  }
  let i = 0;
  while (i < changeIdx.length) {
    let from = Math.max(0, changeIdx[i]! - context);
    let last = changeIdx[i]!;
    let j = i + 1;
    while (j < changeIdx.length && changeIdx[j]! - last <= 2 * context + 1) {
      last = changeIdx[j]!;
      j++;
    }
    const to = Math.min(edits.length, last + context + 1);
    if (from < 0) from = 0;
    const slice = edits.slice(from, to);
    const oldLines = slice.filter((e) => e.kind !== 'ins').length;
    const newLines = slice.filter((e) => e.kind !== 'del').length;
    hunks.push({
      oldStart: oldLines === 0 ? oldNo[from]! - 1 : oldNo[from]!,
      oldLines,
      newStart: newLines === 0 ? newNo[from]! - 1 : newNo[from]!,
      newLines,
      lines: slice.map((e) => ({ kind: e.kind, text: e.line })),
    });
    i = j;
  }
  return hunks;
}

export function statsOf(edits: readonly Edit[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    if (e.kind === 'ins') added++;
    else if (e.kind === 'del') removed++;
  }
  return { added, removed };
}

const MARK: Record<EditKind, string> = { eq: ' ', del: '-', ins: '+' };
const NO_EOL = '\\ No newline at end of file';

export function renderHunk(h: Hunk): string {
  const range = (s: number, n: number) => (n === 1 ? `${s}` : `${s},${n}`);
  const out = [`@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`];
  for (const l of h.lines) {
    out.push(MARK[l.kind] + l.text.replace(/\n$/, ''));
    if (!l.text.endsWith('\n')) out.push(NO_EOL);
  }
  return out.join('\n');
}

export interface FileDiff {
  stats: DiffStats;
  hunks: Hunk[];
  /** unified text, with `---`/`+++` headers; empty string when the two texts are equal */
  text: string;
  /** true when the lines were too many for a minimal diff */
  coarse: boolean;
}

/** A unified diff of one file. `oldPath`/`newPath` `null` mean "does not exist" (`/dev/null`). */
export function diffFile(
  oldPath: string | null,
  oldText: string | null,
  newPath: string | null,
  newText: string | null,
): FileDiff {
  const a = splitLines(oldText ?? '');
  const b = splitLines(newText ?? '');
  const tooBig = a.length > DIFF_LIMITS.maxLines || b.length > DIFF_LIMITS.maxLines;
  const edits = tooBig ? coarse(a, b) : diffLines(a, b);
  const hunks = toHunks(edits);
  const stats = statsOf(edits);
  const renamed = oldPath !== newPath;
  if (hunks.length === 0 && !renamed) return { stats, hunks, text: '', coarse: tooBig };
  const head = [
    `--- ${oldPath === null ? '/dev/null' : `a/${oldPath}`}`,
    `+++ ${newPath === null ? '/dev/null' : `b/${newPath}`}`,
  ];
  return {
    stats,
    hunks,
    text: [...head, ...hunks.map(renderHunk)].join('\n') + '\n',
    coarse: tooBig,
  };
}

// ───────────────────────── applying hunks ─────────────────────────

export type ApplyError =
  | { code: 'hunk_context_mismatch'; hunk: number }
  | { code: 'hunk_ambiguous'; hunk: number }
  | { code: 'hunk_out_of_range'; hunk: number }
  | { code: 'hunks_overlap'; hunk: number };

export type ApplyResult =
  { ok: true; text: string; drift: number[] } | { ok: false; error: ApplyError };

const matchesAt = (lines: readonly string[], at: number, want: readonly string[]): boolean => {
  if (at < 0 || at + want.length > lines.length) return false;
  for (let i = 0; i < want.length; i++) if (lines[at + i] !== want[i]) return false;
  return true;
};

/**
 * Applies hunks to a text. The context and the removed lines of a hunk must match the file EXACTLY (no whitespace fuzz), at the stated position or, failing that, at the nearest
 * position within `maxHunkDrift` lines (models get line numbers wrong; they rarely get the code wrong). Two equally near matches are refused as ambiguous: a patch must say which.
 * `drift` reports, per hunk, how many lines it moved (0 = exactly where it said).
 */
export function applyHunks(text: string, hunks: readonly Hunk[]): ApplyResult {
  const lines = splitLines(text);
  const out: string[] = [];
  let cursor = 0; // next unconsumed old line index
  const drift: number[] = [];
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi]!;
    const want = h.lines.filter((l) => l.kind !== 'ins').map((l) => l.text);
    const repl = h.lines.filter((l) => l.kind !== 'del').map((l) => l.text);
    const stated = Math.max(0, h.oldLines === 0 ? h.oldStart : h.oldStart - 1);
    if (want.length === 0) {
      // a pure insertion: stated position is the only anchor
      if (stated > lines.length || stated < cursor)
        return {
          ok: false,
          error: { code: stated < cursor ? 'hunks_overlap' : 'hunk_out_of_range', hunk: hi },
        };
      out.push(...lines.slice(cursor, stated), ...repl);
      cursor = stated;
      drift.push(0);
      continue;
    }
    let at: number;
    if (matchesAt(lines, stated, want) && stated >= cursor) at = stated;
    else {
      let best = -1;
      let bestDist = Infinity;
      let tie = false;
      const lo = Math.max(cursor, stated - DIFF_LIMITS.maxHunkDrift);
      const hi2 = Math.min(lines.length - want.length, stated + DIFF_LIMITS.maxHunkDrift);
      for (let p = lo; p <= hi2; p++) {
        if (!matchesAt(lines, p, want)) continue;
        const d = Math.abs(p - stated);
        if (d < bestDist) {
          best = p;
          bestDist = d;
          tie = false;
        } else if (d === bestDist) tie = true;
      }
      if (best < 0) {
        // distinguish "overlaps an earlier hunk" from "context does not match"
        const earlier = matchesAt(lines, stated, want) && stated < cursor;
        return {
          ok: false,
          error: { code: earlier ? 'hunks_overlap' : 'hunk_context_mismatch', hunk: hi },
        };
      }
      if (tie) return { ok: false, error: { code: 'hunk_ambiguous', hunk: hi } };
      at = best;
    }
    out.push(...lines.slice(cursor, at), ...repl);
    cursor = at + want.length;
    drift.push(Math.abs(at - stated));
  }
  out.push(...lines.slice(cursor));
  return { ok: true, text: out.join(''), drift };
}

// ───────────────────────── parsing a unified diff ─────────────────────────

export interface FilePatch {
  /** `null` = /dev/null (the file is created) */
  oldPath: string | null;
  /** `null` = /dev/null (the file is deleted) */
  newPath: string | null;
  hunks: Hunk[];
}
export type ParseResult = { ok: true; files: FilePatch[] } | { ok: false; errors: string[] };

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function cleanHeaderPath(raw: string): string | null | undefined {
  // the header may carry a trailing tab + timestamp; the path itself never has a tab
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p.length ? p : undefined;
}

/**
 * Reads a (multi-file) unified diff as DATA. Counts in each `@@` header are checked against the lines that follow: a diff that lies about its own shape is refused. Never throws.
 * Paths are returned as written (minus `a/`/`b/`); the caller validates them with the same path rules as every other model-supplied path.
 */
export function parseUnifiedDiff(text: string): ParseResult {
  if (typeof text !== 'string' || text.length === 0)
    return { ok: false, errors: ['the diff is empty'] };
  if (text.length > DIFF_LIMITS.maxDiffChars)
    return { ok: false, errors: ['the diff is too large'] };
  const rows = text.replace(/\r\n/g, '\n').split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  const files: FilePatch[] = [];
  const errors: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (!r.startsWith('--- ')) {
      // preamble lines ("diff --git", "index ...") between files are tolerated; anything else before the first header is not
      if (
        /^(diff |index |new file mode|deleted file mode|similarity index|rename (from|to)|old mode|new mode)/.test(
          r,
        )
      ) {
        i++;
        continue;
      }
      if (files.length === 0 && r.trim() === '') {
        i++;
        continue;
      }
      errors.push(`line ${i + 1}: expected a "--- " file header`);
      return { ok: false, errors };
    }
    const plus = rows[i + 1];
    if (plus === undefined || !plus.startsWith('+++ ')) {
      errors.push(`line ${i + 1}: a "--- " header is not followed by "+++ "`);
      return { ok: false, errors };
    }
    const oldPath = cleanHeaderPath(r.slice(4));
    const newPath = cleanHeaderPath(plus.slice(4));
    if (oldPath === undefined || newPath === undefined || (oldPath === null && newPath === null)) {
      errors.push(`line ${i + 1}: unusable file header`);
      return { ok: false, errors };
    }
    if (files.length >= DIFF_LIMITS.maxFilesPerDiff) {
      errors.push(`more than ${DIFF_LIMITS.maxFilesPerDiff} files in one diff`);
      return { ok: false, errors };
    }
    i += 2;
    const hunks: Hunk[] = [];
    while (i < rows.length && rows[i]!.startsWith('@@')) {
      const m = HUNK_HEAD.exec(rows[i]!);
      if (!m) {
        errors.push(`line ${i + 1}: malformed hunk header`);
        return { ok: false, errors };
      }
      if (hunks.length >= DIFF_LIMITS.maxHunksPerFile) {
        errors.push(`more than ${DIFF_LIMITS.maxHunksPerFile} hunks in one file`);
        return { ok: false, errors };
      }
      const h: Hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      const headerAt = i;
      i++;
      let oldSeen = 0;
      let newSeen = 0;
      while (
        i < rows.length &&
        (oldSeen < h.oldLines || newSeen < h.newLines || rows[i]!.startsWith('\\'))
      ) {
        const row = rows[i]!;
        if (row.startsWith('\\')) {
          // "\ No newline at end of file": the previous line has no terminator
          const prev = h.lines[h.lines.length - 1];
          if (!prev) {
            errors.push(`line ${i + 1}: unexpected "\\" marker`);
            return { ok: false, errors };
          }
          prev.text = prev.text.replace(/\n$/, '');
          i++;
          continue;
        }
        const c = row[0];
        const body = row.slice(1) + '\n';
        if (c === ' ' || (row === '' && oldSeen < h.oldLines && newSeen < h.newLines)) {
          h.lines.push({ kind: 'eq', text: c === ' ' ? body : '\n' });
          oldSeen++;
          newSeen++;
        } else if (c === '-') {
          h.lines.push({ kind: 'del', text: body });
          oldSeen++;
        } else if (c === '+') {
          h.lines.push({ kind: 'ins', text: body });
          newSeen++;
        } else break;
        i++;
      }
      // a trailing "\" marker directly after the counted lines
      while (i < rows.length && rows[i]!.startsWith('\\')) {
        const prev = h.lines[h.lines.length - 1];
        if (prev) prev.text = prev.text.replace(/\n$/, '');
        i++;
      }
      if (oldSeen !== h.oldLines || newSeen !== h.newLines) {
        errors.push(`line ${headerAt + 1}: the hunk header counts do not match the hunk`);
        return { ok: false, errors };
      }
      hunks.push(h);
    }
    if (hunks.length === 0 && oldPath === newPath) {
      errors.push(`line ${i}: a file header without hunks`);
      return { ok: false, errors };
    }
    files.push({ oldPath, newPath, hunks });
  }
  if (files.length === 0) return { ok: false, errors: ['the diff has no files'] };
  return { ok: true, files };
}
