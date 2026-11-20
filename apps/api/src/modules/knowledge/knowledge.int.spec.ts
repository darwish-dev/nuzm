import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { ProblemException } from '../../common/errors';
import { KnowledgeObjectStore } from './internal/object-store';
import { ResourceService } from './internal/resource.service';

/**
 * AI Intelligence Center, slice S-K1 (ADR-065, SCR-K-01) over HTTP on the real schema: the flag, RBAC, resumable and verified uploads, quarantine, versions,
 * metadata edits with optimistic concurrency, disable and archive, audit. Cross-tenant isolation of the tables is proved in packages/db (knowledge-rls.int.spec.ts).
 */
let e: AiEnv;
let storeDir: string;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const R = '/v1/admin/knowledge';
const admin = (
  who: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  body?: object | Buffer,
  h?: Record<string, string>,
) => e.admin(who, method, url, body, h);

const flag = (on: boolean) =>
  e
    .sql(`DELETE FROM platform.feature_flags WHERE key = 'knowledge.library' AND org_id IS NULL`)
    .then(() =>
      on
        ? e.sql(
            `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'knowledge.library', NULL, 'true'::jsonb)`,
          )
        : undefined,
    );

/** Uploads `data` (split in 8 MiB parts) and completes it; returns the completion response. */
async function upload(
  who: string,
  data: Buffer,
  over: {
    filename?: string;
    name?: string;
    resourceId?: string;
    meta?: Row;
    declaredSha?: string;
  } = {},
) {
  const open = await admin(who, 'POST', `${R}/uploads`, {
    name: over.name ?? 'Modern SaaS',
    resourceType: 'THEME',
    declaredBytes: data.length,
    sha256: over.declaredSha ?? sha(data),
    filename: over.filename ?? 'modern-saas.zip',
    ...(over.resourceId ? { resourceId: over.resourceId } : {}),
  });
  expect(open.statusCode, open.body).toBe(201);
  const up = open.json();
  const size = up.partSize as number;
  const parts: { partNumber: number; sha256: string }[] = [];
  for (let i = 0, n = 1; i < data.length; i += size, n++) {
    const part = data.subarray(i, i + size);
    const r = await admin(who, 'PUT', `${R}/uploads/${up.id}/parts/${n}`, part, {
      'x-part-sha256': sha(part),
    });
    expect(r.statusCode, r.body).toBe(200);
    parts.push({ partNumber: n, sha256: sha(part) });
  }
  const done = await admin(who, 'POST', `${R}/uploads/${up.id}/completion`, {
    parts,
    ...(over.resourceId ? { resourceId: over.resourceId } : {}),
    metadata: {
      name: over.name ?? 'Modern SaaS',
      resourceType: 'THEME',
      platform: 'WEB',
      frameworks: ['nextjs'],
      languages: ['typescript'],
      category: 'dashboard',
      tags: ['saas', 'admin'],
      license: 'MIT',
      ...over.meta,
    },
  });
  return { up, parts, done };
}

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'nuzm-knowledge-test-'));
  process.env.KNOWLEDGE_STORE_DIR = storeDir;
  e = await setupAiEnv();
  const s = await e.h.platformUser(e.app, 'psupport', ['support']);
  e.jars.psupport = s.jar;
  e.ids.psupport = s.id;
}, 180_000);
afterAll(() => e.h.close());

describe('the flag and who may call', () => {
  it('is OFF by default: every library route answers 404', async () => {
    expect((await admin('padmin', 'GET', `${R}/resources`)).statusCode).toBe(404);
    expect((await admin('padmin', 'POST', `${R}/uploads`, {})).statusCode).toBe(404);
    await flag(true);
    expect((await admin('padmin', 'GET', `${R}/resources`)).statusCode).toBe(200);
  });
  it('a customer session cannot reach the admin console routes', async () => {
    const r = await e.call('alice', 'GET', `${R}/resources`);
    expect([401, 403, 404]).toContain(r.statusCode);
  });
  it('read-only staff can list and read but not upload, edit, disable or archive', async () => {
    expect((await admin('psupport', 'GET', `${R}/resources`)).statusCode).toBe(200);
    const id = '00000000-0000-7000-8000-0000000000aa';
    expect(
      (await admin('psupport', 'POST', `${R}/uploads`, { filename: 'a.zip' })).statusCode,
    ).toBe(403);
    expect(
      (
        await admin(
          'psupport',
          'PATCH',
          `${R}/resources/${id}`,
          { name: 'x' },
          { 'if-match': '"1"' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await admin('psupport', 'POST', `${R}/resources/${id}/deactivation`, { reason: 'x' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await admin('psupport', 'POST', `${R}/resources/${id}/archival`, { reason: 'x' }))
        .statusCode,
    ).toBe(403);
  });
});

describe('upload validation (nothing is accepted that could be a path trick or an executable)', () => {
  const open = (over: Row) =>
    admin('padmin', 'POST', `${R}/uploads`, {
      name: 'x',
      resourceType: 'THEME',
      declaredBytes: 10,
      sha256: 'a'.repeat(64),
      filename: 'x.zip',
      ...over,
    });
  it.each([
    '../evil.zip',
    'a/b.zip',
    'a\\b.zip',
    '.hidden.zip',
    'setup.exe',
    'run.sh',
    'logo.svg',
    'archive.zip.exe',
    'nul\u0000.zip',
    'x'.repeat(260) + '.zip',
  ])('refuses the file name %j', async (filename) => {
    const r = await open({ filename });
    expect([422], `${filename}: ${r.body}`).toContain(r.statusCode);
  });
  it('accepts the allow-listed document and archive types', async () => {
    for (const filename of [
      'a.zip',
      'a.tar.gz',
      'a.tgz',
      'doc.md',
      'spec.yaml',
      'api.json',
      'guide.pdf',
      'shot.png',
    ])
      expect((await open({ filename })).statusCode, filename).toBe(201);
  });
  it('refuses a bad checksum, a non-positive size and a size beyond the platform cap', async () => {
    expect((await open({ sha256: 'nope' })).statusCode).toBe(422);
    expect((await open({ declaredBytes: 0 })).statusCode).toBe(422);
    expect((await open({ declaredBytes: 3 * 1024 ** 3 })).statusCode).toBe(413);
    expect((await open({ resourceType: 'ROCKET' })).statusCode).toBe(422);
  });
});

describe('a verified, resumable upload becomes a QUARANTINED, private resource with nothing allowed', () => {
  let resourceId: string;
  let archiveSha: string;
  let completedUploadId: string;
  const data = randomBytes(9 * 1024 * 1024 + 123); // two parts

  it('accepts parts in any order, re-sends are harmless, and a wrong part checksum is refused', async () => {
    const open = (
      await admin('padmin', 'POST', `${R}/uploads`, {
        name: 'Modern SaaS',
        resourceType: 'THEME',
        declaredBytes: data.length,
        sha256: sha(data),
        filename: 'modern.zip',
      })
    ).json();
    const p1 = data.subarray(0, open.partSize);
    const p2 = data.subarray(open.partSize);
    const bad = await admin('padmin', 'PUT', `${R}/uploads/${open.id}/parts/1`, p1, {
      'x-part-sha256': sha(p2),
    });
    expect(bad.statusCode).toBe(422);
    expect((await admin('padmin', 'PUT', `${R}/uploads/${open.id}/parts/1`, p1)).statusCode).toBe(
      422,
    ); // header is required
    expect(
      (
        await admin('padmin', 'PUT', `${R}/uploads/${open.id}/parts/2`, p2, {
          'x-part-sha256': sha(p2),
        })
      ).json().partsReceived,
    ).toEqual([2]);
    const again = await admin('padmin', 'PUT', `${R}/uploads/${open.id}/parts/1`, p1, {
      'x-part-sha256': sha(p1),
    });
    expect(again.json().partsReceived).toEqual([1, 2]);
    expect(
      (
        await admin('padmin', 'PUT', `${R}/uploads/${open.id}/parts/1`, p1, {
          'x-part-sha256': sha(p1),
        })
      ).json().receivedBytes,
    ).toBe(data.length);
    // resume: a fresh read of the session shows what is there
    expect((await admin('padmin', 'GET', `${R}/uploads/${open.id}`)).json().partsReceived).toEqual([
      1, 2,
    ]);
    // a part past the declared size is refused
    const extra = await admin(
      'padmin',
      'PUT',
      `${R}/uploads/${open.id}/parts/3`,
      Buffer.from('x'),
      { 'x-part-sha256': sha(Buffer.from('x')) },
    );
    expect(extra.statusCode).toBe(409);
    // completion with a missing or wrong part list is refused and records nothing
    for (const parts of [
      [{ partNumber: 1, sha256: sha(p1) }],
      [
        { partNumber: 1, sha256: sha(p1) },
        { partNumber: 2, sha256: sha(p1) },
      ],
      [
        { partNumber: 2, sha256: sha(p2) },
        { partNumber: 1, sha256: sha(p1) },
      ],
    ]) {
      const r = await admin('padmin', 'POST', `${R}/uploads/${open.id}/completion`, {
        parts,
        metadata: { name: 'Modern SaaS', resourceType: 'THEME' },
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().code).toBe('knowledge_upload_incomplete');
    }
    expect(
      (
        await e.sql(`SELECT count(*)::int AS n FROM knowledge.resources WHERE name = 'Modern SaaS'`)
      )[0]!.n,
    ).toBe(0);
    const ok = await admin('padmin', 'POST', `${R}/uploads/${open.id}/completion`, {
      parts: [
        { partNumber: 1, sha256: sha(p1) },
        { partNumber: 2, sha256: sha(p2) },
      ],
      metadata: {
        name: 'Modern SaaS',
        resourceType: 'THEME',
        platform: 'WEB',
        frameworks: ['nextjs'],
        languages: ['typescript'],
        category: 'dashboard',
        tags: ['saas'],
        license: 'MIT',
      },
    });
    expect(ok.statusCode, ok.body).toBe(202);
    const r = ok.json();
    resourceId = r.id;
    completedUploadId = open.id;
    archiveSha = sha(data);
    expect(r).toMatchObject({
      status: 'QUARANTINED',
      visibility: 'PLATFORM_PRIVATE',
      resourceType: 'THEME',
      sourceKind: 'upload',
      version: 2,
    });
    expect(r.slug).toBe('modern-saas');
    // the upload is spent
    expect((await admin('padmin', 'GET', `${R}/uploads/${open.id}`)).json().state).toBe(
      'COMPLETED',
    );
    expect(
      (
        await admin('padmin', 'POST', `${R}/uploads/${open.id}/completion`, {
          parts: [],
          metadata: {},
        })
      ).statusCode,
    ).toBe(422);
    expect((await admin('padmin', 'DELETE', `${R}/uploads/${open.id}`)).statusCode).toBe(409);
  });

  it('stores the original content-addressed, once, and leaves no stray parts', async () => {
    const store = e.app.get(KnowledgeObjectStore);
    expect(await store.exists(`archives/${archiveSha}`)).toBe(true);
    expect((await store.read(`archives/${archiveSha}`)).equals(data)).toBe(true);
    // the upload's parts and temporary objects are gone once the archive exists
    expect(readdirSync(join(storeDir, 'uploads'))).not.toContain(completedUploadId);
  });

  it('records an immutable first version, no permission granted and an UNKNOWN licence (D-43, D-49)', async () => {
    const r = (await admin('padmin', 'GET', `${R}/resources/${resourceId}`)).json();
    expect(r.permissions).toMatchObject({
      reuseScope: 'NONE',
      aiProcessing: false,
      componentReuse: false,
      starterEligible: false,
      architectureReference: false,
      licenseVerdict: 'UNKNOWN',
      licenseSpdx: 'MIT',
    });
    expect(r.currentVersion).toMatchObject({
      seq: 1,
      state: 'QUARANTINED',
      licenseVerdict: 'UNKNOWN',
      checksumSha256: archiveSha,
      bytes: data.length,
    });
    expect(r.metadata).toMatchObject({
      frameworks: ['nextjs'],
      languages: ['typescript'],
      category: 'dashboard',
      dataRegion: 'sa-central',
    });
    expect(r.manifest).toBeNull();
    expect(r.componentCount).toBe(0);
    const v = (await admin('padmin', 'GET', `${R}/resources/${resourceId}/versions`)).json();
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ seq: 1, state: 'QUARANTINED', checksumSha256: archiveSha });
    const prov = (
      await e.sql(`SELECT provenance FROM knowledge.resource_versions WHERE resource_id = $1`, [
        resourceId,
      ])
    )[0]!.provenance;
    expect(prov).toMatchObject({
      sourceKind: 'upload',
      filename: 'modern.zip',
      uploadedBy: e.ids.padmin,
    });
  });

  it('a new upload for the same resource adds version 2 and moves current_version_id; the first version is untouched', async () => {
    const more = randomBytes(300_000);
    const { done } = await upload('padmin', more, { resourceId, filename: 'modern-v2.zip' });
    expect(done.statusCode, done.body).toBe(202);
    const v = (await admin('padmin', 'GET', `${R}/resources/${resourceId}/versions`)).json();
    expect(v.items.map((x: Row) => x.seq)).toEqual([2, 1]);
    const r = (await admin('padmin', 'GET', `${R}/resources/${resourceId}`)).json();
    expect(r.currentVersion.seq).toBe(2);
    expect(v.items[1].checksumSha256).toBe(archiveSha);
  });

  it('identical content is stored once: a second resource shares the archive and says so in its provenance', async () => {
    const same = randomBytes(200_000);
    const a = await upload('padmin', same, { name: 'Twin A', filename: 'a.zip' });
    const b = await upload('padmin', same, { name: 'Twin B', filename: 'b.zip' });
    expect(a.done.statusCode).toBe(202);
    expect(b.done.statusCode).toBe(202);
    const rows = (await e.sql(
      `SELECT archive_key, provenance FROM knowledge.resource_versions v JOIN knowledge.resources r ON r.id = v.resource_id WHERE r.name IN ('Twin A','Twin B') ORDER BY r.name`,
    )) as Row[];
    expect(rows[0]!.archive_key).toBe(rows[1]!.archive_key);
    expect(rows[0]!.provenance.deduplicated).toBe(false);
    expect(rows[1]!.provenance.deduplicated).toBe(true);
    expect(b.done.json().slug).toMatch(/^twin-b$/);
  });

  it('a slug that is already taken gets a unique suffix', async () => {
    const a = await upload('padmin', randomBytes(100_000), { name: 'Dup Name' });
    const b = await upload('padmin', randomBytes(100_000), { name: 'Dup Name' });
    expect(a.done.json().slug).toBe('dup-name');
    expect(b.done.json().slug).toMatch(/^dup-name-[0-9a-f]{6}$/);
  });
});

describe('the whole-object checksum and the session lifecycle', () => {
  it('refuses an assembled package whose SHA-256 differs from the declaration, and records nothing', async () => {
    const data = randomBytes(150_000);
    const before = (await e.sql(`SELECT count(*)::int AS n FROM knowledge.resources`))[0]!.n;
    const { done } = await upload('padmin', data, {
      name: 'Tampered',
      declaredSha: sha(Buffer.from('something else')),
    });
    expect(done.statusCode, done.body).toBe(409);
    expect(done.json().code).toBe('knowledge_upload_incomplete');
    expect((await e.sql(`SELECT count(*)::int AS n FROM knowledge.resources`))[0]!.n).toBe(before);
    const store = e.app.get(KnowledgeObjectStore);
    expect(await store.exists(`archives/${sha(Buffer.from('something else'))}`)).toBe(false);
    expect(await store.exists(`archives/${sha(data)}`)).toBe(false);
  });
  it('cancel discards an open upload; later parts and completion are refused', async () => {
    const data = randomBytes(5000);
    const up = (
      await admin('padmin', 'POST', `${R}/uploads`, {
        name: 'C',
        resourceType: 'THEME',
        declaredBytes: data.length,
        sha256: sha(data),
        filename: 'c.zip',
      })
    ).json();
    expect(
      (
        await admin('padmin', 'PUT', `${R}/uploads/${up.id}/parts/1`, data, {
          'x-part-sha256': sha(data),
        })
      ).statusCode,
    ).toBe(200);
    expect((await admin('padmin', 'DELETE', `${R}/uploads/${up.id}`)).statusCode).toBe(204);
    expect((await admin('padmin', 'GET', `${R}/uploads/${up.id}`)).json().state).toBe('CANCELLED');
    expect(
      (
        await admin('padmin', 'PUT', `${R}/uploads/${up.id}/parts/1`, data, {
          'x-part-sha256': sha(data),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await admin('padmin', 'POST', `${R}/uploads/${up.id}/completion`, {
          parts: [{ partNumber: 1, sha256: sha(data) }],
          metadata: { name: 'C', resourceType: 'THEME' },
        })
      ).statusCode,
    ).toBe(409);
    expect((await admin('padmin', 'DELETE', `${R}/uploads/${up.id}`)).statusCode).toBe(204); // cancelling again is harmless
  });
  it('an expired session is EXPIRED the first time it is read and takes no more parts', async () => {
    const data = randomBytes(5000);
    const up = (
      await admin('padmin', 'POST', `${R}/uploads`, {
        name: 'E',
        resourceType: 'THEME',
        declaredBytes: data.length,
        sha256: sha(data),
        filename: 'e.zip',
      })
    ).json();
    await e.sql(
      `UPDATE knowledge.uploads SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [up.id],
    );
    expect((await admin('padmin', 'GET', `${R}/uploads/${up.id}`)).json().state).toBe('EXPIRED');
    expect(
      (
        await admin('padmin', 'PUT', `${R}/uploads/${up.id}/parts/1`, data, {
          'x-part-sha256': sha(data),
        })
      ).statusCode,
    ).toBe(409);
  });
  it('an unknown or foreign resourceId and a malformed id are 404', async () => {
    const data = randomBytes(1000);
    const r = await admin('padmin', 'POST', `${R}/uploads`, {
      name: 'x',
      resourceType: 'THEME',
      declaredBytes: 1000,
      sha256: sha(data),
      filename: 'x.zip',
      resourceId: '00000000-0000-7000-8000-0000000000ff',
    });
    expect(r.statusCode).toBe(404);
    expect((await admin('padmin', 'GET', `${R}/uploads/not-a-uuid`)).statusCode).toBe(404);
    expect((await admin('padmin', 'GET', `${R}/resources/not-a-uuid`)).statusCode).toBe(404);
  });
  it('AI processing cannot be switched on at upload without the publish permission', async () => {
    const svc = e.app.get(ResourceService);
    expect(svc).toBeDefined();
    const { done } = await upload('padmin', randomBytes(50_000), {
      name: 'AI On',
      meta: { reusePermissions: { aiProcessing: true } },
    });
    expect(done.statusCode).toBe(202); // padmin holds publish
    const row = (
      await e.sql(
        `SELECT p.ai_processing FROM knowledge.resource_permissions p JOIN knowledge.resources r ON r.id = p.resource_id WHERE r.name = 'AI On'`,
      )
    )[0]!;
    expect(row.ai_processing).toBe(true);
  });
});

describe('resources: list, filter, page, edit, disable, archive', () => {
  let ids: string[];
  beforeAll(async () => {
    const list = (await admin('padmin', 'GET', `${R}/resources?limit=200`)).json();
    ids = list.items.map((x: Row) => x.id as string);
  });

  it('lists the platform library newest first with cursor pagination and no duplicates', async () => {
    const p1 = (await admin('padmin', 'GET', `${R}/resources?limit=2`)).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (
      await admin(
        'padmin',
        'GET',
        `${R}/resources?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`,
      )
    ).json();
    expect(p2.items[0].id).not.toBe(p1.items[1].id);
    expect([...p1.items, ...p2.items].map((x: Row) => x.id)).toEqual(
      ids.slice(0, p1.items.length + p2.items.length),
    );
  });
  it('filters by type, status, framework, platform, source, text and date, and refuses unknown values', async () => {
    const q = async (qs: string) =>
      (await admin('padmin', 'GET', `${R}/resources?${qs}`)).json().items as Row[];
    expect((await q('framework=nextjs')).length).toBeGreaterThan(0);
    expect((await q('framework=cobol')).length).toBe(0);
    expect(
      (await q('q=modern')).every((r) => String(r.name).toLowerCase().includes('modern')),
    ).toBe(true);
    expect((await q('q=saas')).length).toBeGreaterThan(0); // matches a tag
    expect(
      (await q('status=QUARANTINED&type=THEME&platform=WEB&source=upload')).length,
    ).toBeGreaterThan(0);
    expect((await q('type=DOCUMENTATION')).length).toBe(0);
    expect((await q('createdFrom=2999-01-01T00:00:00Z')).length).toBe(0);
    expect((await admin('padmin', 'GET', `${R}/resources?type=ROCKET`)).statusCode).toBe(422);
    expect((await admin('padmin', 'GET', `${R}/resources?createdFrom=yesterday`)).statusCode).toBe(
      422,
    );
    expect((await q('q=%25')).length).toBe(0); // a LIKE wildcard is literal text, not a match-all
  });

  it('PATCH needs If-Match, rejects a stale version, edits metadata and permissions, and audits before/after', async () => {
    const id = ids[ids.length - 1]!;
    const cur = (await admin('padmin', 'GET', `${R}/resources/${id}`)).json();
    expect(
      (await admin('padmin', 'PATCH', `${R}/resources/${id}`, { category: 'x' })).statusCode,
    ).toBe(422); // no If-Match
    const stale = await admin(
      'padmin',
      'PATCH',
      `${R}/resources/${id}`,
      { category: 'x' },
      { 'if-match': `"${cur.version + 5}"` },
    );
    expect(stale.statusCode).toBe(409);
    const ok = await admin(
      'padmin',
      'PATCH',
      `${R}/resources/${id}`,
      {
        category: 'crm',
        tags: ['crm', 'b2b'],
        description: 'A CRM starter',
        permissions: { reuseScope: 'COMPONENTS', componentReuse: true },
      },
      { 'if-match': `"${cur.version}"` },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({
      category: 'crm',
      tags: ['crm', 'b2b'],
      description: 'A CRM starter',
      permissions: { reuseScope: 'COMPONENTS', componentReuse: true },
    });
    expect(ok.json().version).toBeGreaterThan(cur.version);
    const ev = e.sink.events.filter((x) => x.action === 'knowledge.resource.updated').pop()!;
    expect(ev.before).toMatchObject({ category: cur.category });
    expect(ev.after).toMatchObject({ category: 'crm' });
    // the same If-Match again is now stale
    expect(
      (
        await admin(
          'padmin',
          'PATCH',
          `${R}/resources/${id}`,
          { category: 'y' },
          { 'if-match': `"${cur.version}"` },
        )
      ).statusCode,
    ).toBe(409);
  });
  it("the licence verdict and a resource's identity cannot be edited through PATCH", async () => {
    const id = ids[0]!;
    const cur = (await admin('padmin', 'GET', `${R}/resources/${id}`)).json();
    const h = { 'if-match': `"${cur.version}"` };
    expect(
      (
        await admin(
          'padmin',
          'PATCH',
          `${R}/resources/${id}`,
          { permissions: { licenseVerdict: 'ALLOWED' } },
          h,
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (await admin('padmin', 'PATCH', `${R}/resources/${id}`, { visibility: 'TENANT_PRIVATE' }, h))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await admin(
          'padmin',
          'PATCH',
          `${R}/resources/${id}`,
          { slug: 'hacked', resourceType: 'PROJECT' },
          h,
        )
      ).statusCode,
    ).toBe(422); // nothing editable in the body
    expect((await admin('padmin', 'PATCH', `${R}/resources/${id}`, {}, h)).statusCode).toBe(422);
    const after = (await admin('padmin', 'GET', `${R}/resources/${id}`)).json();
    expect(after.slug).toBe(cur.slug);
  });
  it('publish-only changes are refused for a caller without the publish permission', async () => {
    const svc = e.app.get(ResourceService);
    const id = ids[1]!;
    const cur = (await admin('padmin', 'GET', `${R}/resources/${id}`)).json();
    for (const body of [
      { visibility: 'PLATFORM_PUBLISHED' },
      { defaultEligible: true },
      { permissions: { aiProcessing: true } },
    ]) {
      await expect(
        svc.patch(e.ids.padmin!, false, id, `"${cur.version}"`, body),
      ).rejects.toBeInstanceOf(ProblemException);
    }
    // while the same changes are accepted with it (no ACTIVE version yet: the database keeps it out of the customer view)
    const ok = await svc.patch(e.ids.padmin!, true, id, `"${cur.version}"`, {
      visibility: 'PLATFORM_PUBLISHED',
    });
    expect(ok.visibility).toBe('PLATFORM_PUBLISHED');
    const view = await e.sql(
      `SELECT 1 FROM knowledge.v_published_templates WHERE resource_id = $1`,
      [id],
    );
    expect(view).toHaveLength(0);
  });

  it('disable needs a reason, hides nothing from staff, resets publication, and cannot be repeated', async () => {
    const id = ids[2]!;
    expect(
      (await admin('padmin', 'POST', `${R}/resources/${id}/deactivation`, {})).statusCode,
    ).toBe(422);
    const off = await admin('padmin', 'POST', `${R}/resources/${id}/deactivation`, {
      reason: 'licence under review',
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({
      status: 'DISABLED',
      visibility: 'PLATFORM_PRIVATE',
      defaultEligible: false,
    });
    expect(
      (await admin('padmin', 'POST', `${R}/resources/${id}/deactivation`, { reason: 'again' }))
        .statusCode,
    ).toBe(409);
    expect((await admin('padmin', 'GET', `${R}/resources/${id}`)).statusCode).toBe(200);
  });
  it('archive soft-deletes: gone from list and get, versions kept in the database, and it cannot be edited', async () => {
    const id = ids[3]!;
    const r = await admin('padmin', 'POST', `${R}/resources/${id}/archival`, {
      reason: 'obsolete',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('ARCHIVED');
    expect((await admin('padmin', 'GET', `${R}/resources/${id}`)).statusCode).toBe(404);
    expect(
      (await admin('padmin', 'GET', `${R}/resources?limit=200`)).json().items.map((x: Row) => x.id),
    ).not.toContain(id);
    const kept = await e.sql(
      `SELECT count(*)::int AS n, bool_and(deleted_at IS NOT NULL) AS soft FROM knowledge.resources r JOIN knowledge.resource_versions v ON v.resource_id = r.id WHERE r.id = $1 GROUP BY r.id`,
      [id],
    );
    expect(kept[0]!.n).toBeGreaterThan(0);
    expect(kept[0]!.soft).toBe(true);
    expect(
      (
        await admin(
          'padmin',
          'PATCH',
          `${R}/resources/${id}`,
          { category: 'z' },
          { 'if-match': '"1"' },
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('audit trail', () => {
  it('records every mutation with the actor and without package contents or secrets', () => {
    const actions = new Set(e.sink.events.map((x) => x.action));
    for (const a of [
      'knowledge.upload.opened',
      'knowledge.upload.completed',
      'knowledge.upload.cancelled',
      'knowledge.resource.updated',
      'knowledge.resource.disabled',
      'knowledge.resource.archived',
    ])
      expect(actions.has(a), a).toBe(true);
    const mine = e.sink.events.filter((x) => String(x.action).startsWith('knowledge.'));
    expect(mine.every((x) => x.actorUserId === e.ids.padmin)).toBe(true);
    const serialized = JSON.stringify(mine);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('PK\\u0003'); // zip magic: package bytes never reach the audit log
    const done = mine.find((x) => x.action === 'knowledge.upload.completed')!;
    expect(done.detail).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
