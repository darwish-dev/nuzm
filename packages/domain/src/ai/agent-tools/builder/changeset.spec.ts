import { describe, expect, it } from 'vitest';
import {
  applyHunks,
  diffFile,
  diffLines,
  opsFromUnifiedDiff,
  parseUnifiedDiff,
  planRestore,
  planRevert,
  previewChangeSet,
  sha256Hex,
  splitLines,
  toHunks,
  CHANGESET_LIMITS,
} from './index';

const M = (o: Record<string, string>) => new Map(Object.entries(o));
const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

describe('splitLines / diffLines', () => {
  it('keeps terminators and tells "b" from "b\\n"', () => {
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n']);
    expect(splitLines('')).toEqual([]);
    expect(diffLines(['b'], ['b\n']).map((e) => e.kind)).toEqual(['del', 'ins']);
  });
  it('produces a minimal edit script and round-trips', () => {
    const a = splitLines('a\nb\nc\nd\ne\n');
    const b = splitLines('a\nc\nd\nX\ne\nf\n');
    const edits = diffLines(a, b);
    const old = edits.filter((e) => e.kind !== 'ins').map((e) => e.line);
    const neu = edits.filter((e) => e.kind !== 'del').map((e) => e.line);
    expect(old).toEqual(a);
    expect(neu).toEqual(b);
    expect(edits.filter((e) => e.kind !== 'eq').length).toBe(3); // -b +X +f
  });
  it('round-trips random edits (property-style, seeded)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 60; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 40) }, () => `l${Math.floor(rnd() * 6)}\n`);
      const b = Array.from({ length: Math.floor(rnd() * 40) }, () => `l${Math.floor(rnd() * 6)}\n`);
      const edits = diffLines(a, b);
      expect(edits.filter((e) => e.kind !== 'ins').map((e) => e.line)).toEqual(a);
      expect(edits.filter((e) => e.kind !== 'del').map((e) => e.line)).toEqual(b);
      const text = a.join('');
      const hunks = toHunks(edits);
      const r = applyHunks(text, hunks);
      expect(r.ok && r.text).toBe(b.join(''));
    }
  });
  it('falls back to a correct coarse diff over the edit-distance cap', () => {
    const a = Array.from({ length: 1800 }, (_, i) => `a${i}\n`);
    const b = Array.from({ length: 1800 }, (_, i) => `b${i}\n`);
    const edits = diffLines(a, b);
    expect(edits.filter((e) => e.kind !== 'ins').map((e) => e.line)).toEqual(a);
    expect(edits.filter((e) => e.kind !== 'del').map((e) => e.line)).toEqual(b);
  });
});

describe('diffFile / parseUnifiedDiff / applyHunks', () => {
  it('renders a unified diff that parses back and applies', () => {
    const old = lines(30);
    const neu = old.replace('line 10\n', 'line ten\n').replace('line 25\n', 'line 25\nextra\n');
    const d = diffFile('src/a.ts', old, 'src/a.ts', neu);
    expect(d.stats).toEqual({ added: 2, removed: 1 });
    expect(d.hunks.length).toBe(2);
    expect(d.text.startsWith('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -7,7 +7,7 @@')).toBe(true);
    const parsed = parseUnifiedDiff(d.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = applyHunks(old, parsed.files[0]!.hunks);
    expect(r.ok && r.text).toBe(neu);
    expect(r.ok && r.drift).toEqual([0, 0]);
  });
  it('equal texts produce no diff; no-newline-at-eof is carried', () => {
    expect(diffFile('a', 'x\n', 'a', 'x\n').text).toBe('');
    const d = diffFile('a', 'x\ny', 'a', 'x\ny\n');
    expect(d.text).toContain('\\ No newline at end of file');
    const p = parseUnifiedDiff(d.text);
    expect(p.ok && applyHunks('x\ny', p.files[0]!.hunks)).toMatchObject({ ok: true, text: 'x\ny\n' });
  });
  it('applies a hunk that moved, refuses a changed context and an ambiguous one', () => {
    const old = lines(20);
    const neu = old.replace('line 12\n', 'CHANGED\n');
    const d = diffFile('f', old, 'f', neu);
    const shifted = 'header\nheader2\n' + old;
    const p = parseUnifiedDiff(d.text);
    if (!p.ok) throw new Error('parse');
    const moved = applyHunks(shifted, p.files[0]!.hunks);
    expect(moved.ok && moved.text).toBe('header\nheader2\n' + neu);
    expect(moved.ok && moved.drift[0]).toBe(2);
    expect(applyHunks(old.replace('line 12', 'line 12 edited'), p.files[0]!.hunks)).toMatchObject({
      ok: false,
      error: { code: 'hunk_context_mismatch' },
    });
    // the same block twice, equally far from the stated line
    const hunk = { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: [{ kind: 'del' as const, text: 'x\n' }, { kind: 'ins' as const, text: 'y\n' }] };
    const twice = 'a\n'.repeat(3) + 'x\n' + 'a\n'.repeat(3) + 'x\n' + 'a\n';
    expect(applyHunks(twice, [{ ...hunk, oldStart: 6 }])).toMatchObject({ ok: false, error: { code: 'hunk_ambiguous' } });
  });
  it('refuses a diff that lies about its counts, and bounds its input', () => {
    expect(parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n').ok).toBe(false);
    expect(parseUnifiedDiff('').ok).toBe(false);
    expect(parseUnifiedDiff('hello world').ok).toBe(false);
    expect(parseUnifiedDiff('x'.repeat(2_100_000)).ok).toBe(false);
    expect(parseUnifiedDiff('--- a/x\n+++ b/x\n').ok).toBe(false);
  });
  it('a removed line that starts with "-- " is not mistaken for a file header', () => {
    const p = parseUnifiedDiff('--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- comment\n x\n');
    expect(p.ok).toBe(true);
    expect(p.ok && p.files[0]!.hunks[0]!.lines[0]).toEqual({ kind: 'del', text: '-- comment\n' });
  });
});

describe('previewChangeSet', () => {
  const base = M({ 'src/a.ts': 'one\ntwo\n', 'src/b.ts': 'b\n', 'package.json': '{"name":"x"}\n', 'tests/a.test.ts': 't\n' });
  it('previews add / modify / delete / rename with diffs, totals and hashes, without touching base', () => {
    const p = previewChangeSet(base, [
      { op: 'modify', path: 'src/a.ts', content: 'one\nTWO\nthree\n' },
      { op: 'add', path: 'src/c.ts', content: 'c\n' },
      { op: 'delete', path: 'src/b.ts', expectedHash: sha256Hex('b\n') },
      { op: 'rename', path: 'src/d.ts', from: 'tests/a.test.ts' },
    ]);
    expect(p.ok).toBe(true);
    expect(p.totals).toEqual({ files: 4, added: 3, removed: 2 });
    expect(p.files[0]).toMatchObject({ op: 'modify', added: 2, removed: 1, hashBefore: sha256Hex('one\ntwo\n') });
    expect(p.files[3]).toMatchObject({ op: 'rename', from: 'tests/a.test.ts', path: 'src/d.ts' });
    expect(p.next?.get('src/a.ts')).toBe('one\nTWO\nthree\n');
    expect(base.get('src/a.ts')).toBe('one\ntwo\n');
    expect(p.risks.map((r) => r.code)).toEqual([]);
  });
  it('refuses, with fixed messages: bad paths, sensitive, secrets, duplicates, missing, base mismatch', () => {
    const secret = 'const k = "' + 'AKIA' + 'ABCDEFGHIJKLMNOP' + '";\n';
    const p = previewChangeSet(base, [
      { op: 'add', path: '../x', content: 'x' },
      { op: 'add', path: '.env', content: 'A=1' },
      { op: 'add', path: 'src/s.ts', content: secret },
      { op: 'modify', path: 'src/a.ts', content: 'x' },
      { op: 'modify', path: 'src/a.ts', content: 'y' },
      { op: 'modify', path: 'src/zzz.ts', content: 'y' },
      { op: 'delete', path: 'src/b.ts', expectedHash: sha256Hex('other') },
      { op: 'chmod', path: 'src/b.ts' },
      'nope',
    ]);
    expect(p.ok).toBe(false);
    expect(p.next).toBeUndefined();
    expect(p.errors.map((e) => e.code)).toEqual([
      'invalid_path',
      'sensitive_path',
      'secret_detected',
      'duplicate_path',
      'not_found',
      'base_mismatch',
      'invalid_op',
      'invalid_op',
    ]);
    expect(JSON.stringify(p.errors)).not.toContain('AKIA');
  });
  it('flags risks and the approval rule', () => {
    const many = new Map<string, string>();
    for (let i = 0; i < 12; i++) many.set(`src/f${i}.ts`, `${i}\n`);
    many.set('db/migrations/0001.sql', 'create table t();\n');
    many.set('package.json', '{}');
    const ops = [
      ...[...many.keys()].filter((k) => k.startsWith('src/')).map((path) => ({ op: 'delete', path })),
      { op: 'modify', path: 'db/migrations/0001.sql', content: 'x;\n' },
      { op: 'modify', path: 'package.json', content: '{"scripts":{"postinstall":"x"}}' },
      { op: 'add', path: '.github/workflows/ci.yml', content: 'on: push\n' },
    ];
    const p = previewChangeSet(many, ops, { hasHead: true });
    expect(p.ok).toBe(true);
    expect(p.risks.map((r) => r.code).sort()).toEqual(
      ['changes_dependencies', 'deletes_many_files', 'edits_applied_migration', 'touches_ci_config'].sort(),
    );
    expect(p.approval.required).toBe(true);
    expect(previewChangeSet(many, [{ op: 'add', path: 'x.ts', content: '1' }]).approval.required).toBe(false);
  });
  it('rejects invalid package.json, oversize files and too many ops', () => {
    expect(previewChangeSet(base, [{ op: 'modify', path: 'package.json', content: '{oops' }]).errors[0]!.code).toBe('invalid_manifest');
    expect(
      previewChangeSet(base, [{ op: 'add', path: 'big.txt', content: 'x'.repeat(CHANGESET_LIMITS.maxFileBytes + 1) }]).errors[0]!.code,
    ).toBe('too_large');
    expect(previewChangeSet(base, Array.from({ length: 201 }, (_, i) => ({ op: 'add', path: `f${i}`, content: 'x' }))).errors[0]!.code).toBe('too_many_ops');
    expect(previewChangeSet(base, []).ok).toBe(false);
  });
  it('cuts oversize per-file diffs and says so', () => {
    const big = lines(5000, (i) => `row ${i} ${'x'.repeat(20)}`);
    const p = previewChangeSet(M({ 'a.txt': 'a\n' }), [{ op: 'modify', path: 'a.txt', content: big }]);
    expect(p.files[0]!.diffTruncated).toBe(true);
    expect(p.files[0]!.diff.length).toBeLessThanOrEqual(CHANGESET_LIMITS.maxDiffCharsPerFile);
    expect(p.files[0]!.added).toBe(5000);
  });
});

describe('opsFromUnifiedDiff', () => {
  const base = M({ 'a.ts': lines(15), 'gone.ts': 'bye\n' });
  it('turns a model diff into hash-guarded whole-file ops that preview cleanly', () => {
    const edited = lines(15).replace('line 8\n', 'EIGHT\n');
    const diff = diffFile('a.ts', base.get('a.ts')!, 'a.ts', edited).text +
      diffFile(null, null, 'n.ts', 'new\n').text +
      diffFile('gone.ts', 'bye\n', null, null).text;
    const r = opsFromUnifiedDiff(base, diff);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops.map((o) => o.op)).toEqual(['modify', 'add', 'delete']);
    expect(r.ops[0]).toMatchObject({ path: 'a.ts', content: edited, expectedHash: sha256Hex(lines(15)) });
    expect(previewChangeSet(base, r.ops).ok).toBe(true);
  });
  it('refuses unknown files, stale hunks, traversal paths, empty and no-op diffs', () => {
    const d = diffFile('a.ts', lines(15), 'a.ts', lines(15).replace('line 3', 'X')).text;
    expect(opsFromUnifiedDiff(M({}), d)).toMatchObject({ ok: false, errors: [{ code: 'not_found' }] });
    expect(opsFromUnifiedDiff(M({ 'a.ts': 'different\n'.repeat(15) }), d)).toMatchObject({ ok: false, errors: [{ code: 'hunk_context_mismatch' }] });
    expect(opsFromUnifiedDiff(base, '--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n')).toMatchObject({ ok: false, errors: [{ code: 'invalid_path' }] });
    expect(opsFromUnifiedDiff(base, 'garbage')).toMatchObject({ ok: false, errors: [{ code: 'invalid_diff' }] });
  });
});

describe('planRestore / planRevert', () => {
  const v1 = M({ 'a.ts': 'a1\n', 'b.ts': 'b1\n', 'c.ts': 'c1\n' });
  const v2 = M({ 'a.ts': 'a2\n', 'c.ts': 'c1\n', 'd.ts': 'd2\n' });
  it('restore turns head into the target exactly, guarded by the head hashes', () => {
    const ops = planRestore(v2, v1);
    expect(ops.map((o) => `${o.op}:${o.path}`)).toEqual(['modify:a.ts', 'delete:d.ts', 'add:b.ts']);
    expect(ops[0]).toMatchObject({ content: 'a1\n', expectedHash: sha256Hex('a2\n') });
    const p = previewChangeSet(v2, ops);
    expect(p.ok).toBe(true);
    expect([...(p.next ?? [])].sort()).toEqual([...v1].sort());
    expect(planRestore(v1, v1)).toEqual([]);
  });
  it('revert undoes one change, keeps later work and reports conflicts', () => {
    const current = M({ 'a.ts': 'a3-later\n', 'c.ts': 'c1\n', 'd.ts': 'd2\n' });
    const plan = planRevert(v1, v2, current);
    expect(plan.conflicts).toEqual(['a.ts']);
    expect(plan.ops.map((o) => `${o.op}:${o.path}`)).toEqual(['add:b.ts', 'delete:d.ts']);
    expect(previewChangeSet(current, plan.ops).ok).toBe(true);
  });
  it('never produces ops for sensitive paths', () => {
    const cur = M({ '.env': 'S=1', 'a.ts': '1' });
    expect(planRestore(cur, M({ 'a.ts': '1' }))).toEqual([]);
  });
});

describe('pipeline path rules are mirrored by the preview', () => {
  it('reserved directories, reserved characters and trailing dots are refused like the pipeline refuses them', () => {
    const base = M({ 'a.ts': '1' });
    for (const path of ['.nuzm/memory.json', '.config/x', 'node_modules/x/index.js', 'src/a:b.ts', 'src/a?.ts', 'src/name.', 'src/name ']) {
      const p = previewChangeSet(base, [{ op: 'add', path, content: 'x' }]);
      expect(p.errors[0]?.code, path).toBe('invalid_path');
    }
    expect(previewChangeSet(base, [{ op: 'add', path: 'nuzm.memory.json', content: '{}' }]).ok).toBe(true);
    expect(previewChangeSet(base, [{ op: 'add', path: 'x'.repeat(241), content: '1' }]).errors[0]?.code).toBe('invalid_path');
  });
});
