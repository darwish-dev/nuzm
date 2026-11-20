import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FsObjectStore,
  UnconfiguredObjectStore,
  createKnowledgeObjectStore,
  knowledgeObjectStoreStatus,
} from './object-store';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
let root: string;
let store: FsObjectStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nuzm-store-'));
  store = new FsObjectStore(root);
});

describe('FsObjectStore (development adapter of the knowledge object-store port)', () => {
  it('composes parts in order into a content-addressed archive and removes nothing but its own temp file', async () => {
    const a = Buffer.from('hello ');
    const b = Buffer.from('world');
    await store.putPart('u1', 2, b);
    await store.putPart('u1', 1, a);
    const r = await store.compose('u1', [1, 2], sha(Buffer.concat([a, b])));
    expect('mismatch' in r).toBe(false);
    if ('mismatch' in r) return;
    expect(r).toMatchObject({
      key: `archives/${sha(Buffer.concat([a, b]))}`,
      bytes: 11,
      deduplicated: false,
    });
    expect((await store.read(r.key)).toString()).toBe('hello world');
    expect(readdirSync(join(root, 'uploads', 'u1')).filter((f) => f.endsWith('.tmp'))).toHaveLength(
      0,
    );
  });
  it('reports a checksum mismatch without storing anything under archives/', async () => {
    await store.putPart('u2', 1, Buffer.from('abc'));
    const r = await store.compose('u2', [1], sha(Buffer.from('other')));
    expect(r).toMatchObject({ mismatch: true, sha256: sha(Buffer.from('abc')), bytes: 3 });
    expect(existsSync(join(root, 'archives'))).toBe(false);
  });
  it('shares one immutable object for identical content and never rewrites it', async () => {
    const data = Buffer.from('same bytes');
    await store.putPart('u3', 1, data);
    const first = await store.compose('u3', [1], sha(data));
    await store.putPart('u4', 1, data);
    const second = await store.compose('u4', [1], sha(data));
    expect(first).toMatchObject({ deduplicated: false });
    expect(second).toMatchObject({ deduplicated: true });
    expect(readdirSync(join(root, 'archives'))).toHaveLength(1);
    expect(() => writeFileSync(join(root, 'archives', sha(data)), 'tamper')).toThrow(); // read-only on disk
  });
  it('a missing part fails the composition and leaves no temp file behind', async () => {
    await store.putPart('u5', 1, Buffer.from('x'));
    await expect(store.compose('u5', [1, 2], sha(Buffer.from('x')))).rejects.toThrow();
    expect(readdirSync(join(root, 'uploads', 'u5')).filter((f) => f.endsWith('.tmp'))).toHaveLength(
      0,
    );
  });
  it('discardUpload removes the parts of that upload only', async () => {
    await store.putPart('u6', 1, Buffer.from('a'));
    await store.putPart('u7', 1, Buffer.from('b'));
    await store.discardUpload('u6');
    expect(existsSync(join(root, 'uploads', 'u6'))).toBe(false);
    expect(existsSync(join(root, 'uploads', 'u7'))).toBe(true);
  });
  it.each(['../escape', 'a/../../b', '/abs', 'A/UPPER', 'a//b', 'a b', ''])(
    'refuses the object key %j',
    async (key) => {
      await expect(store.exists(key)).rejects.toThrow('invalid object key');
      await expect(store.read(key)).rejects.toThrow('invalid object key');
    },
  );
  it('an upload id that tries to climb out is refused as well', async () => {
    await expect(store.putPart('../../x', 1, Buffer.from('a'))).rejects.toThrow(
      'invalid object key',
    );
    expect(existsSync(join(root, '..', 'x'))).toBe(false);
  });
  it('the signed URL is a non-fetchable development reference', async () => {
    expect(await store.signedUrl('archives/abc', 60)).toBe('dev-store://archives/abc?ttl=60');
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

describe('UnconfiguredObjectStore (production until D-42)', () => {
  it('answers "not available" to every call', async () => {
    const s = new UnconfiguredObjectStore();
    await expect(s.putPart()).rejects.toThrow();
    await expect(s.exists()).rejects.toThrow();
    await expect(s.read()).rejects.toThrow();
    await expect(s.signedUrl()).rejects.toThrow();
  });
});
void readFileSync;

describe('which object store the platform uses (D-42)', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'nuzm-store-sel-'));
  it('outside production it is the development filesystem adapter', () => {
    const s = createKnowledgeObjectStore({ NODE_ENV: 'development', KNOWLEDGE_STORE_DIR: dir() });
    expect(s).toBeInstanceOf(FsObjectStore);
    expect(knowledgeObjectStoreStatus({ NODE_ENV: 'test' })).toEqual({
      adapter: 'filesystem',
      production: 'none',
      blockedBy: 'D-42',
    });
  });
  it('in production there is NO adapter yet: the unconfigured one answers 404 and nothing can reach local disk, even with a store directory configured', async () => {
    const d = dir();
    const s = createKnowledgeObjectStore({ NODE_ENV: 'production', KNOWLEDGE_STORE_DIR: d });
    expect(s).toBeInstanceOf(UnconfiguredObjectStore);
    await expect(s.putPart('u', 1, Buffer.from('x'))).rejects.toMatchObject({ code: 'not_found' });
    expect(existsSync(join(d, 'uploads'))).toBe(false);
    expect(knowledgeObjectStoreStatus({ NODE_ENV: 'production' })).toEqual({
      adapter: 'unconfigured',
      production: 'none',
      blockedBy: 'D-42',
    });
  });
});
