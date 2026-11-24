/**
 * Pure diff of file contents (Myers O(ND) line diff + git-style unified patch). No I/O, no subprocess. Output follows `git diff -U3` headers and hunk arithmetic;
 * where several minimal edit scripts exist the hunks may differ from git's, but applying them always yields the same file (checked by the property tests).
 */
const CONTEXT = 3;
/** Beyond this many edits (or lines) the line diff is not attempted; the patch says so instead of printing a wall of text. */
export const MAX_EDITS = 1_500;
export const MAX_DIFF_LINES = 60_000;
export const MAX_FILE_PATCH = 100_000;

interface Line {
  text: string;
  /** false only for the last line of a file without a trailing newline */
  eol: boolean;
}
export function splitLines(s: string): Line[] {
  if (s === '') return [];
  const parts = s.split('\n');
  const out: Line[] = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    if (last && parts[i] === '') break; // the file ended with "\n"
    out.push({ text: parts[i]!, eol: !last });
  }
  return out;
}
const key = (l: Line) => (l.eol ? `${l.text}\n` : l.text);

export type EditKind = ' ' | '-' | '+';
export interface Edit {
  t: EditKind;
  /** index into the old / new lines (the one that applies) */
  i: number;
}

/** Myers shortest edit script; null when more than `MAX_EDITS` edits are needed. */
export function editScript(a: readonly string[], b: readonly string[]): Edit[] | null {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const A = a.slice(lo, ea);
  const B = b.slice(lo, eb);
  const n = A.length;
  const m = B.length;
  const out: Edit[] = [];
  for (let i = 0; i < lo; i++) out.push({ t: ' ', i });
  if (n === 0 || m === 0) {
    for (let i = 0; i < n; i++) out.push({ t: '-', i: lo + i });
    for (let i = 0; i < m; i++) out.push({ t: '+', i: lo + i });
  } else {
    const maxD = Math.min(n + m, MAX_EDITS);
    const off = maxD + 1;
    const v = new Int32Array(2 * maxD + 3);
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= maxD && found < 0; d++) {
      trace.push(v.slice(off - d, off + d + 1)); // window k in [-d, d]; index k + d
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
        else x = v[off + k - 1]! + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          found = d;
          break;
        }
      }
    }
    if (found < 0) return null;
    const rev: Edit[] = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
      const prev = trace[d]!; // v after step d-1, window [-d, d] holds k in [-(d-1), d-1] at +d
      const get = (k: number) => prev[k + d]!;
      const k = x - y;
      const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
      const prevX = get(prevK);
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        rev.push({ t: ' ', i: lo + x - 1 });
        x--;
        y--;
      }
      if (x === prevX) rev.push({ t: '+', i: lo + prevY });
      else rev.push({ t: '-', i: lo + prevX });
      x = prevX;
      y = prevY;
    }
    while (x > 0 && y > 0) {
      rev.push({ t: ' ', i: lo + x - 1 });
      x--;
      y--;
    }
    rev.reverse();
    out.push(...rev);
  }
  for (let i = ea; i < a.length; i++) out.push({ t: ' ', i });
  return out;
}

const fmtRange = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);

/** Unified hunks (`@@ … @@` blocks) of two texts, or a one-line notice when the diff is too large. */
export function unifiedHunks(oldText: string, newText: string): string {
  const A = splitLines(oldText);
  const B = splitLines(newText);
  if (A.length + B.length > MAX_DIFF_LINES)
    return '@@ diff omitted: file too large to compare @@\n';
  const ops = editScript(A.map(key), B.map(key));
  if (!ops) return '@@ diff omitted: too many differences to display @@\n';
  // position of every op in the old and new files
  const pos: { a: number; b: number }[] = [];
  let pa = 0;
  let pb = 0;
  for (const op of ops) {
    pos.push({ a: pa, b: pb });
    if (op.t !== '+') pa++;
    if (op.t !== '-') pb++;
  }
  const changed: number[] = [];
  ops.forEach((o, idx) => {
    if (o.t !== ' ') changed.push(idx);
  });
  if (changed.length === 0) return '';
  const groups: [number, number][] = [];
  let s = Math.max(0, changed[0]! - CONTEXT);
  let last = changed[0]!;
  for (const c of changed.slice(1)) {
    if (c - last > 2 * CONTEXT + 1) {
      groups.push([s, Math.min(ops.length, last + CONTEXT + 1)]);
      s = Math.max(0, c - CONTEXT);
    }
    last = c;
  }
  groups.push([s, Math.min(ops.length, last + CONTEXT + 1)]);
  let out = '';
  for (const [from, to] of groups) {
    let oldCount = 0;
    let newCount = 0;
    let body = '';
    for (let idx = from; idx < to; idx++) {
      const op = ops[idx]!;
      const line = op.t === '+' ? B[op.i]! : A[op.i]!;
      if (op.t !== '+') oldCount++;
      if (op.t !== '-') newCount++;
      body += `${op.t}${line.text}\n`;
      if (!line.eol) body += '\\ No newline at end of file\n';
    }
    const p = pos[from]!;
    const oldStart = oldCount === 0 ? p.a : p.a + 1;
    const newStart = newCount === 0 ? p.b : p.b + 1;
    out += `@@ -${fmtRange(oldStart, oldCount)} +${fmtRange(newStart, newCount)} @@\n${body}`;
  }
  return out;
}

/** Applies the hunks of ONE file's patch to `original` (test helper and a safety net: the result must equal the new content). Throws when a hunk does not match. */
export function applyHunks(original: string, hunks: string): string {
  const src = splitLines(original);
  const out: Line[] = [];
  let at = 0;
  const lines = hunks.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
    if (!h) throw new Error(`unexpected line in patch: ${lines[i]}`);
    const oldStart = Number(h[1]);
    const oldCount = h[2] === undefined ? 1 : Number(h[2]);
    const start = oldCount === 0 ? oldStart : oldStart - 1;
    while (at < start) out.push(src[at++]!);
    i++;
    let lastKind: EditKind | null = null;
    for (; i < lines.length && !lines[i]!.startsWith('@@ '); i++) {
      const l = lines[i]!;
      if (l.startsWith('\\')) {
        // the previous line has no newline at the end of its file
        const prev = out.at(-1);
        if (prev && lastKind !== '-') prev.eol = false;
        continue;
      }
      const kind = l[0] as EditKind;
      const text = l.slice(1);
      if (kind === ' ') {
        const s = src[at++];
        if (!s || s.text !== text) throw new Error('context mismatch');
        out.push({ ...s });
      } else if (kind === '-') {
        const s = src[at++];
        if (!s || s.text !== text) throw new Error('removed line mismatch');
      } else if (kind === '+') out.push({ text, eol: true });
      else throw new Error(`bad patch line: ${l}`);
      lastKind = kind;
    }
    i--;
  }
  while (at < src.length) out.push(src[at++]!);
  return out.map((l) => (l.eol ? `${l.text}\n` : l.text)).join('');
}

const abbrev = (oid: string | null) => (oid ? oid.slice(0, 7) : '0000000');
export interface FileSide {
  oid: string;
  bytes: Buffer;
  binary: boolean;
}

/** A git-style `diff --git` section for one path. */
export function fileDiff(path: string, a: FileSide | null, b: FileSide | null): string {
  const head = `diff --git a/${path} b/${path}\n`;
  const mode = '100644';
  const meta = !a
    ? `new file mode ${mode}\nindex ${abbrev(null)}..${abbrev(b!.oid)}\n`
    : !b
      ? `deleted file mode ${mode}\nindex ${abbrev(a.oid)}..${abbrev(null)}\n`
      : `index ${abbrev(a.oid)}..${abbrev(b.oid)} ${mode}\n`;
  if ((a && a.binary) || (b && b.binary))
    return `${head}${meta}Binary files ${a ? `a/${path}` : '/dev/null'} and ${b ? `b/${path}` : '/dev/null'} differ\n`;
  const aText = a ? a.bytes.toString('utf8') : '';
  const bText = b ? b.bytes.toString('utf8') : '';
  const files = `--- ${a ? `a/${path}` : '/dev/null'}\n+++ ${b ? `b/${path}` : '/dev/null'}\n`;
  if (!aText && !bText) return `${head}${meta}`; // empty file added or removed: no hunks
  const hunks =
    aText.length + bText.length > MAX_FILE_PATCH * 4
      ? '@@ diff omitted: file too large to compare @@\n'
      : unifiedHunks(aText, bText);
  const capped =
    hunks.length > MAX_FILE_PATCH
      ? `${hunks.slice(0, MAX_FILE_PATCH)}\n@@ diff truncated @@\n`
      : hunks;
  return `${head}${meta}${files}${capped}`;
}

export function renameDiff(from: string, to: string): string {
  return `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n`;
}
