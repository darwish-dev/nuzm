import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PART_HINT,
  UploadError,
  cancelUpload,
  checkFile,
  runUpload,
  type KeyValueStore,
  type UploadProgress,
} from './knowledge-upload';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const meta = {
  name: 'Modern SaaS',
  resourceType: 'THEME',
  platform: 'WEB',
  frameworks: ['nextjs'],
  languages: ['typescript'],
  tags: ['saas'],
  license: 'MIT',
};
const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};
const file = (bytes: Uint8Array, name = 'modern.zip') =>
  new File([bytes as BlobPart], name, { type: 'application/zip', lastModified: 1_700_000_000_000 });

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}
/** A fake of the admin upload API: sessions, parts, completion. `fail` injects behaviour per request. */
function fakeApi(
  over: {
    partSize?: number;
    open?: { partsReceived: number[]; state?: string };
    failPart?: (n: number, attempt: number) => Response | 'network' | null;
    completion?: Response;
  } = {},
) {
  const calls: Call[] = [];
  const attempts = new Map<number, number>();
  const partSize = over.partSize ?? PART_HINT;
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const method = init.method ?? 'GET';
    const call: Call = { method, url, headers, body: init.body };
    calls.push(call);
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const json = (s: number, b: unknown) =>
      new Response(JSON.stringify(b), {
        status: s,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'POST' && url.endsWith('/uploads'))
      return json(201, { id: 'up-1', state: 'OPEN', partSize, partsReceived: [] });
    if (method === 'GET' && url.endsWith('/uploads/up-1'))
      return json(200, {
        id: 'up-1',
        state: over.open?.state ?? 'OPEN',
        partSize,
        partsReceived: over.open?.partsReceived ?? [],
      });
    if (method === 'PUT') {
      const n = Number(url.split('/').pop());
      const a = attempts.get(n) ?? 0;
      attempts.set(n, a + 1);
      const injected = over.failPart?.(n, a);
      if (injected === 'network') throw new TypeError('network down');
      if (injected) return injected;
      return json(200, { id: 'up-1', state: 'OPEN', partSize, partsReceived: [] });
    }
    if (method === 'POST' && url.endsWith('/completion'))
      return over.completion ?? json(202, { id: 'res-1' });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return json(404, {});
  }) as typeof fetch;
  return { calls, fetch: fetchFn, puts: () => calls.filter((c) => c.method === 'PUT') };
}
const instant = async () => undefined;

describe('checkFile mirrors the server rules before a single byte is hashed', () => {
  it.each(['a.zip', 'A.TAR.GZ', 'doc.md', 'spec.yaml', 'x.PNG'])('accepts %s', (n) =>
    expect(() => checkFile({ name: n, size: 10 })).not.toThrow(),
  );
  it.each(['a.exe', 'run.sh', 'logo.svg', '../a.zip', 'a/b.zip', '.hidden.zip', 'noext'])(
    'refuses the name %s',
    (n) => expect(() => checkFile({ name: n, size: 10 })).toThrow(UploadError),
  );
  it('refuses an empty file and one beyond 2 GB', () => {
    expect(() => checkFile({ name: 'a.zip', size: 0 })).toThrow(
      expect.objectContaining({ code: 'size' }),
    );
    expect(() => checkFile({ name: 'a.zip', size: 2 * 1024 ** 3 + 1 })).toThrow(
      expect.objectContaining({ code: 'size' }),
    );
  });
});

describe('runUpload', () => {
  const data = new Uint8Array(randomBytes(2 * PART_HINT + 1234)); // three parts

  it('hashes, opens a session, sends every part with its own checksum, then completes with the part list and metadata', async () => {
    const api = fakeApi();
    const store = memory();
    const seen: UploadProgress[] = [];
    let session = '';
    const r = await runUpload({
      file: file(data),
      metadata: meta,
      deps: { fetch: api.fetch, csrf: () => 'csrf-token', store, sleep: instant },
      onProgress: (p) => seen.push(p),
      onSession: (id) => (session = id),
    });
    expect(r).toEqual({ resourceId: 'res-1' });
    expect(session).toBe('up-1');
    const open = api.calls.find((c) => c.method === 'POST' && c.url.endsWith('/uploads'))!;
    expect(JSON.parse(open.body as string)).toMatchObject({
      name: 'Modern SaaS',
      resourceType: 'THEME',
      declaredBytes: data.length,
      sha256: sha(data),
      filename: 'modern.zip',
    });
    expect(open.headers['x-csrf-token']).toBe('csrf-token');
    expect(open.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const puts = api.puts();
    expect(puts.map((p) => p.url.split('/').pop())).toEqual(['1', '2', '3']);
    for (const [i, p] of puts.entries()) {
      const part = data.subarray(i * PART_HINT, (i + 1) * PART_HINT);
      expect(p.headers['x-part-sha256']).toBe(sha(part));
      expect(p.headers['content-type']).toBe('application/octet-stream');
      expect((p.body as Blob).size).toBe(part.length);
    }
    const done = JSON.parse(api.calls.at(-1)!.body as string);
    expect(done.parts).toEqual(
      puts.map((p, i) => ({ partNumber: i + 1, sha256: p.headers['x-part-sha256'] })),
    );
    expect(done.metadata).toMatchObject({
      name: 'Modern SaaS',
      frameworks: ['nextjs'],
      license: 'MIT',
    });
    expect(store.data.size).toBe(0); // nothing is remembered once the upload is spent
    expect(seen[0]).toEqual({ phase: 'hashing', percent: 0 });
    expect(seen.some((p) => p.phase === 'hashing' && p.percent === 100)).toBe(true);
    expect(seen.at(-1)).toEqual({ phase: 'completing' });
    expect(
      seen.filter((p) => p.phase === 'sending').map((p) => (p as { done: number }).done),
    ).toEqual([0, 1, 2, 3]);
  });

  it('resumes the session remembered for the same file and sends only the missing parts', async () => {
    const api = fakeApi({ open: { partsReceived: [1, 2] } });
    const store = memory();
    store.setItem(
      'nuzm.knowledge.upload',
      JSON.stringify({ fp: `modern.zip:${data.length}:1700000000000:${sha(data)}`, id: 'up-1' }),
    );
    const seen: UploadProgress[] = [];
    await runUpload({
      file: file(data),
      metadata: meta,
      deps: { fetch: api.fetch, csrf: () => 'c', store, sleep: instant },
      onProgress: (p) => seen.push(p),
    });
    expect(api.calls.some((c) => c.method === 'POST' && c.url.endsWith('/uploads'))).toBe(false); // no new session
    expect(api.puts().map((p) => p.url.split('/').pop())).toEqual(['3']);
    expect(seen.find((p) => p.phase === 'sending')).toMatchObject({ resumed: 2, total: 3 });
    const done = JSON.parse(api.calls.at(-1)!.body as string);
    expect(done.parts).toHaveLength(3); // the completion still lists every part, with the checksums of THIS file
    expect(done.parts[0].sha256).toBe(sha(data.subarray(0, PART_HINT)));
  });

  it('does not resume for a different file, and opens a fresh session when the remembered one is no longer open', async () => {
    const store = memory();
    store.setItem('nuzm.knowledge.upload', JSON.stringify({ fp: 'other.zip:1:2:3', id: 'up-1' }));
    const a = fakeApi();
    await runUpload({
      file: file(data),
      metadata: meta,
      deps: { fetch: a.fetch, csrf: () => 'c', store, sleep: instant },
      onProgress: () => undefined,
    });
    expect(a.calls.some((c) => c.method === 'GET')).toBe(false);
    const b = fakeApi({ open: { partsReceived: [1], state: 'EXPIRED' } });
    store.setItem(
      'nuzm.knowledge.upload',
      JSON.stringify({ fp: `modern.zip:${data.length}:1700000000000:${sha(data)}`, id: 'up-1' }),
    );
    await runUpload({
      file: file(data),
      metadata: meta,
      deps: { fetch: b.fetch, csrf: () => 'c', store, sleep: instant },
      onProgress: () => undefined,
    });
    expect(b.calls.some((c) => c.method === 'POST' && c.url.endsWith('/uploads'))).toBe(true);
    expect(b.puts()).toHaveLength(3);
  });

  it('uses the server part size when it differs from the hint, with matching checksums', async () => {
    const small = new Uint8Array(randomBytes(300_000));
    const api = fakeApi({ partSize: 262_144 });
    await runUpload({
      file: file(small),
      metadata: meta,
      deps: { fetch: api.fetch, csrf: () => 'c', sleep: instant },
      onProgress: () => undefined,
    });
    const puts = api.puts();
    expect(puts).toHaveLength(2);
    expect(puts[0]!.headers['x-part-sha256']).toBe(sha(small.subarray(0, 262_144)));
    expect(puts[1]!.headers['x-part-sha256']).toBe(sha(small.subarray(262_144)));
  });

  it('retries a part after a network error or a 5xx, up to three attempts, then gives up with "network"', async () => {
    const ok = fakeApi({
      failPart: (n, a) =>
        n === 1 && a < 2 ? (a === 0 ? 'network' : new Response('', { status: 503 })) : null,
    });
    await runUpload({
      file: file(data),
      metadata: meta,
      deps: { fetch: ok.fetch, csrf: () => 'c', sleep: instant },
      onProgress: () => undefined,
    });
    expect(ok.puts().filter((p) => p.url.endsWith('/parts/1'))).toHaveLength(3);
    const bad = fakeApi({ failPart: () => 'network' });
    await expect(
      runUpload({
        file: file(data),
        metadata: meta,
        deps: { fetch: bad.fetch, csrf: () => 'c', sleep: instant },
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'network' });
    expect(bad.puts()).toHaveLength(3);
  });

  it('does not retry a 4xx: 403 is "forbidden", 422 is "type"', async () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [422, 'type'],
    ] as const) {
      const api = fakeApi({ failPart: () => new Response('', { status }) });
      await expect(
        runUpload({
          file: file(data),
          metadata: meta,
          deps: { fetch: api.fetch, csrf: () => 'c', sleep: instant },
          onProgress: () => undefined,
        }),
      ).rejects.toMatchObject({ code });
      expect(api.puts()).toHaveLength(1);
    }
  });

  it('says "mismatch" when the server refuses the completion as incomplete (409)', async () => {
    const api = fakeApi({ completion: new Response('{}', { status: 409 }) });
    const store = memory();
    await expect(
      runUpload({
        file: file(data),
        metadata: meta,
        deps: { fetch: api.fetch, csrf: () => 'c', store, sleep: instant },
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'mismatch' });
    expect(store.data.size).toBe(1); // the session stays remembered so the same file can be tried again
  });

  it('rejects a bad file before any request', async () => {
    const api = fakeApi();
    await expect(
      runUpload({
        file: file(data, 'evil.exe'),
        metadata: meta,
        deps: { fetch: api.fetch, csrf: () => 'c' },
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'type' });
    expect(api.calls).toHaveLength(0);
  });

  it('stops when aborted (during hashing or sending) and cancelUpload discards the session and the memory of it', async () => {
    const ctl = new AbortController();
    const api = fakeApi();
    const store = memory();
    const p = runUpload({
      file: file(data),
      metadata: meta,
      deps: { fetch: api.fetch, csrf: () => 'c', store, sleep: instant },
      onProgress: (e) => {
        if (e.phase === 'sending' && e.done === 1) ctl.abort();
      },
      signal: ctl.signal,
    });
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(api.puts().length).toBeLessThan(3);
    await cancelUpload('up-1', { fetch: api.fetch, csrf: () => 'csrf', store });
    const del = api.calls.at(-1)!;
    expect(del).toMatchObject({ method: 'DELETE', url: '/v1/admin/knowledge/uploads/up-1' });
    expect(del.headers['x-csrf-token']).toBe('csrf');
    expect(store.data.size).toBe(0);
  });
});
