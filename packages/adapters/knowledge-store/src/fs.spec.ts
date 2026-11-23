import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FsObjectStore } from './fs';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let root: string;
let s: FsObjectStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nuzm-ks-'));
  s = new FsObjectStore(root);
});
describe('FsObjectStore (development adapter)', () => {
  it('composes, deduplicates, reads ranges and streams', async () => {
    const a = randomBytes(300);
    const b = randomBytes(200);
    await s.putPart('u1', 2, b);
    await s.putPart('u1', 1, a);
    const all = Buffer.concat([a, b]);
    const r = await s.compose('u1', [1, 2], sha(all));
    expect(r).toMatchObject({ key: `archives/${sha(all)}`, bytes: 500, deduplicated: false });
    expect(await s.size(`archives/${sha(all)}`)).toBe(500);
    expect(
      (await s.readRange(`archives/${sha(all)}`, 290, 20)).equals(all.subarray(290, 310)),
    ).toBe(true);
    const chunks: Buffer[] = [];
    for await (const c of await s.open(`archives/${sha(all)}`)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(all)).toBe(true);
    await s.putPart('u2', 1, all);
    expect(await s.compose('u2', [1], sha(all))).toMatchObject({ deduplicated: true });
    expect(await s.compose('u2', [1], 'a'.repeat(64))).toMatchObject({ mismatch: true });
  });
  it('writes objects once (ifAbsent), deletes them and refuses unsafe keys', async () => {
    expect((await s.put('snapshots/x', Buffer.from('1'), { ifAbsent: true })).existed).toBe(false);
    expect((await s.put('snapshots/x', Buffer.from('2'), { ifAbsent: true })).existed).toBe(true);
    expect((await s.read('snapshots/x')).toString()).toBe('1');
    await s.delete('snapshots/x');
    expect(await s.exists('snapshots/x')).toBe(false);
    for (const k of ['../a', '/abs', 'A/B', 'a//b'])
      await expect(s.exists(k)).rejects.toMatchObject({ code: 'invalid_key' });
    await s.putPart('u3', 1, Buffer.from('x'));
    await s.discardUpload('u3');
    expect(existsSync(join(root, 'uploads', 'u3'))).toBe(false);
    expect(readdirSync(root)).not.toContain('..');
  });
  it('refuses to exist in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new FsObjectStore(root)).toThrow(/development only/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
