import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectStoreError } from './port';
import { S3ObjectStore, type Encryption } from './s3';
import { FakeS3 } from './testing/fake-s3';

// the multipart cases move tens of MiB through a signature-verifying fake: the default 5 s is too tight on a loaded machine
vi.setConfig({ testTimeout: 60_000 });

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const BUCKET = 'knowledge-test';
const creds = { accessKeyId: 'AKIATESTTESTTEST', secretAccessKey: 'test-secret-key-not-real' };
let fake: FakeS3;
const store = (
  over: Partial<{ encryption: Encryption; credentials: typeof creds; retries: number }> = {},
) =>
  new S3ObjectStore({
    endpoint: fake.endpoint,
    region: 'sa-east-1',
    bucket: BUCKET,
    credentials: async () => over.credentials ?? creds,
    encryption: over.encryption ?? { type: 'AES256' },
    retries: over.retries ?? 2,
    timeoutMs: 5000,
  });
beforeEach(async () => {
  fake = new FakeS3({ bucket: BUCKET, region: 'sa-east-1', ...creds });
  await fake.start();
});
afterEach(() => fake.stop());

describe('S3ObjectStore configuration', () => {
  it('requires https except for loopback development endpoints, and a valid bucket', () => {
    const mk =
      (endpoint: string, bucket = BUCKET) =>
      () =>
        new S3ObjectStore({
          endpoint,
          region: 'r',
          bucket,
          credentials: async () => creds,
          encryption: { type: 'AES256' },
        });
    expect(mk('http://storage.example.com')).toThrow(/https/);
    expect(mk('http://127.0.0.1:9000')).not.toThrow();
    expect(mk('http://localhost:9000')).not.toThrow();
    expect(mk('https://s3.example.com')).not.toThrow();
    expect(mk('https://s3.example.com', 'Bad_Bucket')).toThrow(/bucket/);
  });
});

describe('S3ObjectStore against a signature-verifying S3', () => {
  it('signs requests correctly: a wrong secret is refused by the provider', async () => {
    await store().put('archives/ok', Buffer.from('x'));
    await expect(
      store({ credentials: { ...creds, secretAccessKey: 'wrong' } }).put(
        'archives/bad',
        Buffer.from('x'),
      ),
    ).rejects.toMatchObject({ code: 'rejected', status: 403 });
    expect(fake.objects.has('archives/bad')).toBe(false);
  });
  it('puts, reads, sizes, ranges, lists and deletes objects (keys with unusual characters too)', async () => {
    const s = store();
    const data = randomBytes(5000);
    expect((await s.put('snapshots/a-b_c.d', data, { ifAbsent: true })).existed).toBe(false);
    expect(
      (await s.put('snapshots/a-b_c.d', Buffer.from('other'), { ifAbsent: true })).existed,
    ).toBe(true);
    expect((await s.read('snapshots/a-b_c.d')).equals(data)).toBe(true); // never overwritten
    expect(await s.size('snapshots/a-b_c.d')).toBe(5000);
    expect(await s.size('snapshots/none')).toBeNull();
    expect(await s.exists('snapshots/none')).toBe(false);
    expect((await s.readRange('snapshots/a-b_c.d', 100, 50)).equals(data.subarray(100, 150))).toBe(
      true,
    );
    expect((await s.readRange('snapshots/a-b_c.d', 4990, 100)).equals(data.subarray(4990))).toBe(
      true,
    );
    expect((await s.readRange('snapshots/a-b_c.d', 9999, 10)).length).toBe(0);
    const chunks: Buffer[] = [];
    for await (const c of await s.open('snapshots/a-b_c.d')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
    await s.delete('snapshots/a-b_c.d');
    await s.delete('snapshots/a-b_c.d'); // deleting twice is harmless
    expect(await s.exists('snapshots/a-b_c.d')).toBe(false);
    await expect(s.read('snapshots/a-b_c.d')).rejects.toMatchObject({ code: 'not_found' });
    await expect(s.put('../escape', Buffer.from('x'))).rejects.toMatchObject({
      code: 'invalid_key',
    });
  });
  it('requires encryption and verifies it: every write carries the header, a provider that ignores it is refused and the object is removed', async () => {
    await store().put('snapshots/enc', Buffer.from('x'));
    expect(fake.objects.get('snapshots/enc')!.sse).toBe('AES256');
    await store({ encryption: { type: 'aws:kms', keyId: 'alias/nuzm-knowledge' } }).put(
      'snapshots/kms',
      Buffer.from('x'),
    );
    expect(fake.objects.get('snapshots/kms')!.sse).toBe('aws:kms');
    const bare = new FakeS3({
      bucket: BUCKET,
      region: 'sa-east-1',
      ...creds,
      echoEncryption: false,
    });
    await bare.start();
    try {
      const s = new S3ObjectStore({
        endpoint: bare.endpoint,
        region: 'sa-east-1',
        bucket: BUCKET,
        credentials: async () => creds,
        encryption: { type: 'AES256' },
      });
      await expect(s.put('snapshots/plain', Buffer.from('x'))).rejects.toMatchObject({
        code: 'encryption_not_applied',
      });
      expect(bare.objects.has('snapshots/plain')).toBe(false);
      await expect(s.putPart('u1', 1, Buffer.from('x'))).rejects.toMatchObject({
        code: 'encryption_not_applied',
      });
    } finally {
      await bare.stop();
    }
  });
  it('retries network-level and 5xx failures of idempotent requests and gives up with "unavailable"', async () => {
    fake.failNext(503, 2, 'PUT');
    await store({ retries: 3 }).put('snapshots/retry', Buffer.from('x'));
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(3);
    fake.failNext(500, 10, 'GET');
    await expect(store({ retries: 1 }).read('snapshots/retry')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
  it('composes parts into a content-addressed archive (small), verifying the checksum first', async () => {
    const s = store();
    const parts = [randomBytes(1000), randomBytes(2000)];
    for (const [i, p] of parts.entries()) await s.putPart('up1', i + 1, p);
    const all = Buffer.concat(parts);
    const r = await s.compose('up1', [1, 2], sha(all));
    expect(r).toMatchObject({ key: `archives/${sha(all)}`, bytes: 3000, deduplicated: false });
    expect(fake.objects.get(`archives/${sha(all)}`)!.sse).toBe('AES256');
    expect((await s.read(`archives/${sha(all)}`)).equals(all)).toBe(true);
    expect([...fake.objects.keys()].some((k) => k.endsWith('/composed'))).toBe(false); // the temporary object is gone
    // identical content again: deduplicated, nothing rewritten
    for (const [i, p] of parts.entries()) await s.putPart('up2', i + 1, p);
    expect(await s.compose('up2', [1, 2], sha(all))).toMatchObject({ deduplicated: true });
    // a checksum that does not match leaves nothing under archives/
    expect(await s.compose('up2', [1, 2], 'f'.repeat(64))).toMatchObject({
      mismatch: true,
      sha256: sha(all),
      bytes: 3000,
    });
    expect([...fake.objects.keys()].filter((k) => k.startsWith('archives/'))).toEqual([
      `archives/${sha(all)}`,
    ]);
  });
  it('composes a large archive through a multipart upload (parts of at least 5 MiB)', async () => {
    const s = store();
    const parts = [randomBytes(6 * 1024 * 1024), randomBytes(6 * 1024 * 1024), randomBytes(1234)];
    for (const [i, p] of parts.entries()) await s.putPart('big', i + 1, p);
    const all = Buffer.concat(parts);
    const r = await s.compose('big', [1, 2, 3], sha(all));
    expect(r).toMatchObject({
      key: `archives/${sha(all)}`,
      bytes: all.length,
      deduplicated: false,
    });
    expect(fake.objects.get(`archives/${sha(all)}`)!.data.equals(all)).toBe(true);
    expect(fake.requests.some((q) => q.method === 'POST' && 'uploads' in q.query)).toBe(true);
    await s.discardUpload('big');
    expect([...fake.objects.keys()].filter((k) => k.startsWith('uploads/'))).toEqual([]);
  });
  it('a wrong checksum on a large archive aborts the multipart upload and stores nothing', async () => {
    const s = store();
    const parts = [randomBytes(6 * 1024 * 1024), randomBytes(6 * 1024 * 1024)];
    for (const [i, p] of parts.entries()) await s.putPart('bigbad', i + 1, p);
    expect(await s.compose('bigbad', [1, 2], '0'.repeat(64))).toMatchObject({ mismatch: true });
    expect([...fake.objects.keys()].filter((k) => k.startsWith('archives/'))).toEqual([]);
  });
  it('hands out short-lived signed URLs that work, while the object itself stays private', async () => {
    const s = store();
    await s.put('archives/private', Buffer.from('secret package'));
    const url = await s.signedUrl('archives/private', 60, { filename: 'package.zip' });
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('response-content-disposition=attachment');
    const ok = await fetch(url);
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe('secret package');
    const anon = await fetch(`${fake.endpoint}/${BUCKET}/archives/private`);
    expect(anon.status).toBe(403);
    const tampered = await fetch(url.replace('archives/private', 'archives/other'));
    expect(tampered.status).toBe(403);
    await expect(s.signedUrl('archives/private', 0)).rejects.toMatchObject({ code: 'config' });
    await expect(s.signedUrl('archives/private', 99999)).rejects.toMatchObject({ code: 'config' });
  });
  it('an expired signed URL is refused', async () => {
    const s = store();
    await s.put('archives/p', Buffer.from('x'));
    const url = new URL(await s.signedUrl('archives/p', 1));
    await new Promise((r) => setTimeout(r, 2200));
    expect((await fetch(url)).status).toBe(403);
  });
  it('the self test passes on a private encrypted bucket and FAILS on a public one or one that ignores encryption', async () => {
    const good = await store().selfTest();
    expect(good).toEqual({
      ok: true,
      checks: {
        encryptionApplied: true,
        roundTrip: true,
        signedReadWorks: true,
        anonymousReadDenied: true,
        rangeRead: true,
        cleanup: true,
      },
    });
    const pub = new FakeS3({ bucket: BUCKET, region: 'sa-east-1', ...creds, publicRead: true });
    await pub.start();
    const bare = new FakeS3({
      bucket: BUCKET,
      region: 'sa-east-1',
      ...creds,
      echoEncryption: false,
    });
    await bare.start();
    try {
      const mk = (f: FakeS3) =>
        new S3ObjectStore({
          endpoint: f.endpoint,
          region: 'sa-east-1',
          bucket: BUCKET,
          credentials: async () => creds,
          encryption: { type: 'AES256' },
          retries: 0,
        });
      const p = await mk(pub).selfTest();
      expect(p.ok).toBe(false);
      expect(p.checks.anonymousReadDenied).toBe(false);
      const b = await mk(bare).selfTest();
      expect(b.ok).toBe(false);
      expect(b.checks.encryptionApplied).toBe(false);
      expect(bare.objects.size).toBe(0); // the test object was cleaned up
    } finally {
      await pub.stop();
      await bare.stop();
    }
  });
  it('maps provider failures to typed errors', async () => {
    const s = store({ retries: 0 });
    await expect(s.read('snapshots/missing')).rejects.toBeInstanceOf(ObjectStoreError);
    fake.failNext(403, 1);
    await expect(s.put('snapshots/x', Buffer.from('x'))).rejects.toMatchObject({
      code: 'rejected',
    });
  });
});
