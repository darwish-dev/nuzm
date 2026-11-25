import { describe, expect, it } from 'vitest';
import {
  blobOid,
  buildSnapshot,
  commitOid,
  DEFAULT_IDENTITY,
  DIR_MODE,
  EMPTY_TREE_OID,
  encodeCommit,
  FILE_MODE,
  subjectOf,
  treeOid,
} from './git-object';

describe('git object ids (pure TypeScript, checked against git’s well-known values)', () => {
  it('blob ids', () => {
    expect(blobOid(Buffer.from(''))).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(blobOid(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
  it('the empty tree id', () => {
    expect(treeOid([])).toBe(EMPTY_TREE_OID);
  });
  it('tree entries are ordered by name bytes with a directory compared as "name/"', () => {
    const o = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
    const snap = buildSnapshot(
      new Map([
        ['a.b', Buffer.from('')],
        ['a/x', Buffer.from('')],
        ['a-b', Buffer.from('')],
        ['a0', Buffer.from('')],
      ]),
    );
    const root = snap.trees.get(snap.root)!;
    // '-' (0x2d) < '.' (0x2e) < '/' (0x2f, the directory a) < '0' (0x30)
    expect(root.entries.map((e) => e.name)).toEqual(['a-b', 'a.b', 'a', 'a0']);
    expect(root.entries.find((e) => e.name === 'a')!.mode).toBe(DIR_MODE);
    expect(root.entries.find((e) => e.name === 'a0')).toMatchObject({ mode: FILE_MODE, oid: o });
    expect(snap.blobs.size).toBe(1); // identical contents share one blob
  });
  it('a file and a directory with the same name clash', () => {
    expect(
      buildSnapshot(
        new Map([
          ['a', Buffer.from('')],
          ['a/b', Buffer.from('')],
        ]),
      ).clash,
    ).toBe('a/b');
    expect(
      buildSnapshot(
        new Map([
          ['a/b', Buffer.from('')],
          ['a', Buffer.from('')],
        ]),
      ).clash,
    ).toBe('a');
  });
  it('commit encoding follows `git commit-tree -m` (one completed trailing newline)', () => {
    const c = {
      tree: EMPTY_TREE_OID,
      parents: ['a'.repeat(40)],
      author: DEFAULT_IDENTITY,
      when: 1_700_000_000,
      message: 'hello',
    };
    expect(encodeCommit(c).toString('utf8')).toBe(
      `tree ${EMPTY_TREE_OID}\nparent ${'a'.repeat(40)}\nauthor Nuzm App Builder <builder@nuzm.invalid> 1700000000 +0000\ncommitter Nuzm App Builder <builder@nuzm.invalid> 1700000000 +0000\n\nhello\n`,
    );
    expect(commitOid({ ...c, message: 'hello\n' })).toBe(commitOid(c));
    expect(commitOid({ ...c, message: 'hello!' })).not.toBe(commitOid(c));
  });
  it('subject like `git log --format=%s`', () => {
    expect(subjectOf('one')).toBe('one');
    expect(subjectOf('one\ntwo\n\nbody')).toBe('one two');
    expect(subjectOf('\n\nlead')).toBe('lead');
  });
});
