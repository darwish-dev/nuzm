import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { AiJobs, RunService, SessionService } from '../ai';
import { SlidingWindowLimiter } from '../../common/rate-limit';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { CmsService, FormsService, PreviewService, ProjectService } from './index';

let e: AiEnv;
let runs: RunService;
const A = () => e.org.A!;
const B = () => e.org.B!;
const j = (r: { json(): unknown }) => r.json() as Row;
const mkProject = async (name: string, template = 'restaurant', who = 'alice', org = A()) => {
  const r = await e.call(
    who,
    'POST',
    '/v1/builder/projects',
    { type: 'website', name, locale: ['ar', 'en'], templateId: template },
    org,
  );
  if (r.statusCode !== 201) throw new Error(`project: ${r.statusCode} ${r.body}`);
  return j(r);
};
const change = (
  pid: string,
  base: string,
  ops: unknown[],
  who = 'alice',
  org = A(),
  extra: Row = {},
) =>
  e.call(
    who,
    'POST',
    `/v1/builder/projects/${pid}/changes`,
    { baseVersion: base, ops, source: 'user', ...extra },
    org,
  );
const head = async (pid: string, org = A(), who = 'alice') =>
  j(await e.call(who, 'GET', `/v1/builder/projects/${pid}`, undefined, org));
const token = (url: string) => new URL(url).host.split('.')[0]!;
const previewGet = (url: string, path = '', host?: string, extra: Record<string, string> = {}) => {
  const u = new URL(url);
  return e.app.inject({
    method: 'GET',
    url: `/_preview/${token(url)}/${path || u.pathname.replace(/^\//, '')}`,
    headers: { host: host ?? u.host, ...extra },
  });
};

beforeAll(async () => {
  e = await setupAiEnv();
  runs = e.app.get(RunService);
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler: (req) => mockModelHandler(req) }),
  });
  await e.fund(A(), '100000000');
  await e.call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"0"' });
}, 120_000);
afterAll(() => e.h.close());

describe('projects (S39)', () => {
  it('creates a bilingual project from a template: version 1, rendered files, registered form, SEO report', async () => {
    const p = await mkProject('Sample Restaurant');
    expect(p.headSeq).toBe(1);
    expect(p.siteModel.locales).toEqual(['ar', 'en']);
    const files = j(await e.call('carol', 'GET', `/v1/builder/projects/${p.id}/files`))
      .items as Row[];
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(['index.html', 'ar/index.html', 'en/index.html', 'assets/styles.css']),
    );
    const html = j(
      await e.call('carol', 'GET', `/v1/builder/projects/${p.id}/files/content?path=ar/index.html`),
    );
    expect(html.content).toMatch(/<html lang="ar" dir="rtl"/);
    expect(
      j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`)).seo.score,
    ).toBeGreaterThan(0);
    const forms = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}/forms`))
      .items as Row[];
    expect(forms.map((f) => f.formKey)).toContain('contact');
  });
  it('validation, quota, naming, roles and isolation', async () => {
    expect(
      (await e.call('alice', 'POST', '/v1/builder/projects', { type: 'webapp', name: 'x' }))
        .statusCode,
    ).toBe(422);
    expect(
      (await e.call('alice', 'POST', '/v1/builder/projects', { name: 'x', locale: ['fr'] }))
        .statusCode,
    ).toBe(422);
    expect(
      (await e.call('alice', 'POST', '/v1/builder/projects', { name: 'x', templateId: 'nope' }))
        .statusCode,
    ).toBe(422);
    expect(
      (await e.call('carol', 'POST', '/v1/builder/projects', { name: 'viewer project' }))
        .statusCode,
    ).toBe(403);
    const p = await mkProject('Unique Name');
    expect(
      (
        await e.call('alice', 'POST', '/v1/builder/projects', {
          name: 'unique name',
          locale: ['en'],
        })
      ).json().code,
    ).toBe('name_taken');
    expect(
      (await e.call('bob', 'GET', `/v1/builder/projects/${p.id}`, undefined, B())).statusCode,
    ).toBe(404);
    expect(j(await e.call('bob', 'GET', '/v1/builder/projects', undefined, B())).items).toEqual([]);
    const cfg = e.app.get(ProjectService) as unknown as { cfg: { maxProjects: number } };
    const old = cfg.cfg.maxProjects;
    cfg.cfg.maxProjects = 1;
    expect(
      (
        await e.call('alice', 'POST', '/v1/builder/projects', {
          name: 'one too many',
          locale: ['en'],
        })
      ).json().code,
    ).toBe('quota_exceeded');
    cfg.cfg.maxProjects = old;
  });
  it('PATCH needs If-Match; delete needs the confirmed name, is soft, and revokes previews', async () => {
    const p = await mkProject('To Delete');
    expect(
      (await e.call('alice', 'PATCH', `/v1/builder/projects/${p.id}`, { name: 'Renamed' }))
        .statusCode,
    ).toBe(428);
    expect(
      (
        await e.call('alice', 'PATCH', `/v1/builder/projects/${p.id}`, { name: 'Renamed' }, A(), {
          'if-match': '"99"',
        })
      ).statusCode,
    ).toBe(412);
    const ok = await e.call(
      'alice',
      'PATCH',
      `/v1/builder/projects/${p.id}`,
      { name: 'Renamed' },
      A(),
      { 'if-match': `"${p.etag}"` },
    );
    expect(ok.statusCode).toBe(200);
    const pv = j(await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/previews`, {})) as Row;
    expect(
      (await e.call('alice', 'DELETE', `/v1/builder/projects/${p.id}?confirmName=wrong`))
        .statusCode,
    ).toBe(422);
    const del = await e.call('alice', 'DELETE', `/v1/builder/projects/${p.id}?confirmName=Renamed`);
    expect(del.statusCode).toBe(200);
    expect((await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`)).statusCode).toBe(404);
    expect((await previewGet(String(pv.url))).statusCode).toBe(404);
    expect(
      Number(
        (
          await e.sql(
            `SELECT count(*) n FROM builder.projects WHERE id=$1 AND deleted_at IS NOT NULL`,
            [p.id],
          )
        )[0]!.n,
      ),
    ).toBe(1); // soft
    expect(e.sink.events.some((x) => x.action === 'builder.project.deleted')).toBe(true);
  });
});

describe('editor changes and versions (S40)', () => {
  it('applies ops atomically, returns the safe diff and inverse, and undo restores the model', async () => {
    const p = await mkProject('Editor One');
    const before = (await head(p.id)).siteModel;
    const r = await change(p.id, p.headVersionId as string, [
      { op: 'setText', target: 'brandName', locale: 'en', value: 'New Name' },
      { op: 'setTokens', tokens: { radius: 'lg' } },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    const res = j(r);
    expect(res.diff.text).toEqual([
      { path: 'brand.name', locale: 'en', before: 'Editor One', after: 'New Name' },
    ]);
    expect(res.risks).toEqual([]);
    expect(res.newVersion.seq).toBe(2);
    const undo = await change(p.id, res.newVersion.id, j(r).inverseOps as unknown[]);
    expect(undo.statusCode).toBe(200);
    expect((await head(p.id)).siteModel).toEqual(before);
    expect((await head(p.id)).headSeq).toBe(3);
  });
  it('409 base_outdated carries rebase info; 422 op_invalid lists issues; an invalid op set creates no version', async () => {
    const p = await mkProject('Editor Two');
    const first = await change(p.id, p.headVersionId as string, [
      { op: 'setText', target: 'siteTitle', locale: 'en', value: 'T2' },
    ]);
    expect(first.statusCode).toBe(200);
    const stale = await change(p.id, p.headVersionId as string, [
      { op: 'setText', target: 'siteTitle', locale: 'en', value: 'T3' },
    ]);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('base_outdated');
    expect(stale.json().headVersionId).toBe(j(first).newVersion.id);
    const bad = await change(p.id, j(first).newVersion.id, [
      { op: 'setText', target: 'siteTitle', locale: 'en', value: 'ok' },
      { op: 'deleteComponent', pageId: 'home', sectionId: 'missing' },
    ]);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('op_invalid');
    const half = await change(p.id, j(first).newVersion.id, [
      { op: 'setText', target: 'brandName', locale: 'ar', value: null },
    ]);
    expect(half.statusCode).toBe(422);
    expect((half.json().errors as unknown[]).length).toBeGreaterThan(0);
    expect((await head(p.id)).headSeq).toBe(2);
    expect((await change(p.id, 'x', [])).statusCode).toBe(422);
  });
  it('risk flags for destructive ops; source=ai is refused here; a viewer cannot change', async () => {
    const p = await mkProject('Editor Three');
    const m = (await head(p.id)).siteModel;
    const page = m.pages.find(
      (x: Row) => x.slug !== 'home' && (m.nav.items as Row[]).some((n) => n.pageId === x.id),
    );
    const r = await change(p.id, p.headVersionId as string, [
      { op: 'deletePage', pageId: page.id },
    ]);
    expect(r.statusCode).toBe(200);
    expect((j(r).risks as Row[]).map((x) => x.code)).toContain('deletes_page');
    expect(
      (
        await change(
          p.id,
          j(r).newVersion.id,
          [{ op: 'setTokens', tokens: { radius: 'sm' } }],
          'alice',
          A(),
          { source: 'ai' },
        )
      ).json().code,
    ).toBe('approval_required');
    expect(
      (
        await change(
          p.id,
          j(r).newVersion.id,
          [{ op: 'setTokens', tokens: { radius: 'sm' } }],
          'carol',
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await change(
          p.id,
          p.headVersionId as string,
          [{ op: 'setTokens', tokens: { radius: 'sm' } }],
          'bob',
          B(),
        )
      ).statusCode,
    ).toBe(404);
  });
  it('concurrent writers: of two parallel changes on the same base exactly one wins (single-writer lock)', async () => {
    const p = await mkProject('Editor Race');
    const rs = await Promise.all(
      [1, 2, 3].map((i) =>
        change(p.id, p.headVersionId as string, [
          { op: 'setText', target: 'siteTitle', locale: 'en', value: `race ${i}` },
        ]),
      ),
    );
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect((await head(p.id)).headSeq).toBe(2);
  });
  it('a named snapshot, history listing, and restoration that creates a NEW head without rewriting history', async () => {
    const p = await mkProject('Editor History');
    const v1 = p.headVersionId as string;
    expect(
      (await change(p.id, v1, [], 'alice', A(), { label: 'Launch candidate' })).statusCode,
    ).toBe(200);
    const c = await change(p.id, v1, [
      { op: 'setText', target: 'brandName', locale: 'en', value: 'Changed' },
    ]);
    const list = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}/versions`))
      .items as Row[];
    expect(list.map((x) => x.seq)).toEqual([2, 1]);
    expect(list[1]!.label).toBe('Launch candidate');
    expect(list[0]!.isHead).toBe(true);
    const r = await e.call(
      'alice',
      'POST',
      `/v1/builder/projects/${p.id}/versions/${v1}/restoration`,
    );
    expect(r.statusCode, r.body).toBe(201);
    expect(j(r).seq).toBe(3);
    const after = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}/versions`))
      .items as Row[];
    expect(after.length).toBe(3);
    expect(after[0]!.source).toBe('restore');
    expect(after[0]!.restoredFrom).toBe(v1);
    expect((await head(p.id)).siteModel.brand.name.en).toBe('Editor History');
    expect(
      (
        await e.call(
          'alice',
          'POST',
          `/v1/builder/projects/${p.id}/versions/${j(r).versionId}/restoration`,
        )
      ).statusCode,
    ).toBe(409);
    expect(j(c).newVersion.seq).toBe(2);
    // history is immutable in the database
    await expect(
      e.sql(`UPDATE builder.project_versions SET site_model='{}' WHERE project_id=$1`, [p.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      e.sql(`DELETE FROM builder.project_files WHERE project_id=$1`, [p.id]),
    ).rejects.toThrow(/immutable/);
  });
  it('uploaded images: only PNG/JPEG/WebP by content, size-capped, content-addressed; SVG is refused', async () => {
    const p = await mkProject('Editor Images');
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1),
    ]);
    const hash = createHash('sha256').update(png).digest('hex');
    const asset = {
      id: 'logo-up',
      kind: 'image',
      source: 'upload',
      alt: { ar: 'شعار', en: 'Logo' },
      contentHash: hash,
      mime: 'image/png',
    };
    const ok = await change(
      p.id,
      p.headVersionId as string,
      [{ op: 'addAsset', asset }],
      'alice',
      A(),
      { assetData: { [hash]: png.toString('base64') } },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    const files = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}/files`))
      .items as Row[];
    expect(files.some((f) => f.path === `assets/${hash}.png`)).toBe(true);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const sh = createHash('sha256').update(svg).digest('hex');
    const bad = await change(
      p.id,
      j(ok).newVersion.id,
      [{ op: 'addAsset', asset: { ...asset, id: 'bad-svg', contentHash: sh, mime: 'image/png' } }],
      'alice',
      A(),
      { assetData: { [sh]: svg.toString('base64') } },
    );
    expect(bad.json().code).toBe('op_invalid');
    const wrong = await change(
      p.id,
      j(ok).newVersion.id,
      [{ op: 'addAsset', asset: { ...asset, id: 'bad-hash' } }],
      'alice',
      A(),
      { assetData: { [sh]: png.toString('base64') } },
    );
    expect(wrong.json().code).toBe('op_invalid');
  });
  it('every committed version emits builder.build_minutes through the outbox', async () => {
    const n = Number(
      (
        await e.sql(
          `SELECT count(*) n FROM platform.outbox WHERE topic='usage.recorded' AND payload->>'meterId'='builder.build_minutes' AND org_id=$1`,
          [A()],
        )
      )[0]!.n,
    );
    expect(n).toBeGreaterThan(5);
  });
});

describe('previews on the isolated origin (S39.4, AC-M09-04)', () => {
  let p: Row;
  let url: string;
  beforeAll(async () => {
    p = await mkProject('Preview Site');
    const r = await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/previews`, {
      viewport: 'mobile',
    });
    expect(r.statusCode, r.body).toBe(201);
    url = j(r).url as string;
  });
  it('the URL is on a separate registrable domain with a 160-bit token; only its hash is stored', async () => {
    const u = new URL(url);
    expect(u.host).toMatch(/^[a-z2-7]{32}\.preview\.nuzm-preview\.test$/);
    expect(u.host).not.toContain('nuzm.test'.replace('nuzm.test', 'console.nuzm.test'));
    const rows = await e.sql(`SELECT token_hash FROM builder.previews WHERE project_id=$1`, [p.id]);
    expect(JSON.stringify(rows)).not.toContain(token(url));
    const list = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}/previews`));
    expect(JSON.stringify(list)).not.toContain(token(url));
  });
  it('serves the static site with a strict CSP, no cookies, nosniff, framing limited to the console', async () => {
    const r = await previewGet(url);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('frame-ancestors https://console.nuzm.test');
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(r.body).not.toMatch(/<script(?![^>]*(ld\+json|src=))/);
    expect((await previewGet(url, 'assets/styles.css')).statusCode).toBe(200);
  });
  it('cannot be reached through another host, with a wrong or tampered token, or with traversal; cookies from the console are ignored', async () => {
    const t = token(url);
    expect((await previewGet(url, '', 'console.nuzm.test')).statusCode).toBe(404);
    expect((await previewGet(url, '', 'api.nuzm.test')).statusCode).toBe(404);
    expect(
      (await previewGet(url, '', `${t.slice(0, -1)}a.preview.nuzm-preview.test`)).statusCode,
    ).toBe(404);
    expect(
      (
        await e.app.inject({
          method: 'GET',
          url: `/_preview/${'a'.repeat(32)}/ar/`,
          headers: { host: `${'a'.repeat(32)}.preview.nuzm-preview.test` },
        })
      ).statusCode,
    ).toBe(404);
    expect((await previewGet(url, '../../etc/passwd')).statusCode).toBe(404);
    expect((await previewGet(url, 'ar/%2e%2e/%2e%2e/x')).statusCode).toBe(404);
    const withCookie = await previewGet(url, '', undefined, {
      cookie: `nuzm_session=${e.jars.alice!.nuzm_session ?? 'x'}`,
      authorization: 'Bearer nzk_x',
    });
    expect(withCookie.statusCode).toBe(200);
    expect(withCookie.headers['set-cookie']).toBeUndefined();
  });
  it('the preview host reaches nothing of the API, and the API host never serves previews', async () => {
    const host = new URL(url).host;
    for (const path of [
      '/v1/ai/models',
      '/v1/builder/projects',
      '/healthz',
      '/v1/me',
      '/v1/admin/ai/runs',
    ]) {
      const r = await e.app.inject({
        method: 'GET',
        url: path,
        headers: { host, cookie: `nuzm_session=${e.jars.alice!.nuzm_session ?? 'x'}` },
      });
      expect(r.statusCode, path).toBe(404);
    }
    expect(
      (
        await e.app.inject({
          method: 'POST',
          url: '/v1/builder/projects',
          headers: { host },
          payload: { name: 'x' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await e.app.inject({
          method: 'GET',
          url: `/_preview/${token(url)}/ar/`,
          headers: { host: 'api.nuzm.test' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('expires, and the active-preview limit answers 429; a viewer cannot create one; another org cannot use the project', async () => {
    await e.sql(
      `UPDATE builder.previews SET expires_at = now() - interval '1 minute' WHERE project_id=$1`,
      [p.id],
    );
    expect((await previewGet(url)).statusCode).toBe(404);
    const cfg = e.app.get(PreviewService) as unknown as { cfg: { maxActivePreviews: number } };
    cfg.cfg.maxActivePreviews = 2;
    expect(
      (await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/previews`, {})).statusCode,
    ).toBe(201);
    expect(
      (await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/previews`, {})).statusCode,
    ).toBe(201);
    expect(
      (await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/previews`, {})).statusCode,
    ).toBe(429);
    cfg.cfg.maxActivePreviews = 10;
    expect(
      (await e.call('carol', 'POST', `/v1/builder/projects/${p.id}/previews`, {})).statusCode,
    ).toBe(403);
    expect(
      (await e.call('bob', 'POST', `/v1/builder/projects/${p.id}/previews`, {}, B())).statusCode,
    ).toBe(404);
    expect(
      (
        await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/previews`, {
          viewport: 'watch',
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe('forms (S41.2)', () => {
  let p: Row;
  let endpoint: string;
  const post = (body: unknown, ip = '10.0.0.1', headers: Record<string, string> = {}) =>
    e.app.inject({
      method: 'POST',
      url: new URL(endpoint).pathname,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
      payload: typeof body === 'string' ? body : JSON.stringify(body),
    });
  beforeAll(async () => {
    p = await mkProject('Forms Site');
    endpoint = (
      j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}/forms`)).items as Row[]
    )[0]!.endpoint as string;
    (
      e.app.get(FormsService) as unknown as { cfg: { formRatePerMinute: number } }
    ).cfg.formRatePerMinute = 5;
    (e.app.get(FormsService) as unknown as { limiter: SlidingWindowLimiter }).limiter =
      new SlidingWindowLimiter();
  });
  const good = {
    name: 'Sara',
    email: 'sara@example.com',
    phone: '+966501234567',
    message: 'Hello there',
  };
  it('stores a sealed personal submission with a hashed IP, answers 202, allows the site to post cross-origin', async () => {
    const fields = (
      (j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}/forms`)).items as Row[])[0]!
        .fields as Row[]
    ).map((f) => f.name as string);
    const body = Object.fromEntries(
      fields.map((f) => [
        f,
        f === 'email' ? 'sara@example.com' : f === 'phone' ? '+966501234567' : 'Sara',
      ]),
    ) as Row;
    const r = await post(body, '10.0.0.2');
    expect(r.statusCode, r.body).toBe(202);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const row = (
      await e.sql(
        `SELECT payload_enc, ip_hash, classification FROM builder.form_submissions WHERE project_id=$1`,
        [p.id],
      )
    )[0]!;
    expect(String(row.payload_enc)).toMatch(/^enc:v1:/);
    expect(String(row.payload_enc)).not.toContain('sara@example.com');
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('10.0.0.2');
    expect(row.classification).toBe('personal');
    expect(
      (await e.app.inject({ method: 'OPTIONS', url: new URL(endpoint).pathname })).statusCode,
    ).toBe(204);
    void good;
  });
  it('honeypot: accepted silently, counted as spam, nothing stored', async () => {
    const before = Number(
      (
        await e.sql(`SELECT count(*) n FROM builder.form_submissions WHERE project_id=$1`, [p.id])
      )[0]!.n,
    );
    const r = await post({ name: 'bot', website_url: 'http://spam.example' }, '10.0.0.3');
    expect(r.statusCode).toBe(202);
    expect(
      Number(
        (
          await e.sql(`SELECT count(*) n FROM builder.form_submissions WHERE project_id=$1`, [p.id])
        )[0]!.n,
      ),
    ).toBe(before);
    expect(
      Number(
        (await e.sql(`SELECT spam_count FROM builder.forms WHERE project_id=$1`, [p.id]))[0]!
          .spam_count,
      ),
    ).toBe(1);
  });
  it('size limit 413, unknown field and bad email 422, malformed body 422, unknown project/form 404, deleted project 404', async () => {
    expect((await post({ message: 'x'.repeat(40_000) }, '10.0.0.4')).statusCode).toBe(413);
    expect(
      (await post({ name: 'a', email: 'not-an-email', message: 'm' }, '10.0.0.5')).statusCode,
    ).toBe(422);
    expect(
      (await post({ name: 'a', email: 'a@b.co', message: 'm', evil: 'x' }, '10.0.0.6')).statusCode,
    ).toBe(422);
    expect((await post('[1,2]', '10.0.0.7')).statusCode).toBe(422);
    expect(
      (await e.app.inject({ method: 'POST', url: `/p/${p.id}/v1/public/forms/nope`, payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await e.app.inject({
          method: 'POST',
          url: `/p/00000000-0000-7000-8000-000000000001/v1/public/forms/contact`,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
  it('per-IP rate limit: the 6th post inside a minute is 429, another IP is unaffected; the native urlencoded fallback works', async () => {
    const body = { name: 'Sara', email: 'sara@example.com', phone: '+966501234567', message: 'Hi' };
    const fields = (
      (j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}/forms`)).items as Row[])[0]!
        .fields as Row[]
    ).map((f) => f.name as string);
    const ok = Object.fromEntries(fields.map((f) => [f, (body as Row)[f] ?? 'x']));
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post(ok, '10.9.9.9')).statusCode);
    expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
    expect((await post(ok, '10.9.9.8')).statusCode).toBe(202);
    const enc = new URLSearchParams(ok as Record<string, string>).toString();
    const r = await e.app.inject({
      method: 'POST',
      url: new URL(endpoint).pathname,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '10.8.8.8',
      },
      payload: enc,
    });
    expect(r.statusCode).toBe(202);
  });
  it('submissions are masked for a viewer, readable for a developer (audited), and scoped to the organization', async () => {
    const v = j(await e.call('carol', 'GET', `/v1/builder/projects/${p.id}/form-submissions`));
    expect((v.items as Row[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(v)).not.toContain('sara@example.com');
    expect((v.items as Row[])[0]!.masked).toBe(true);
    const d = j(await e.call('dave', 'GET', `/v1/builder/projects/${p.id}/form-submissions`));
    expect(JSON.stringify(d)).toContain('sara@example.com');
    expect(e.sink.events.some((x) => x.action === 'builder.submission.read')).toBe(true);
    expect(
      (await e.call('bob', 'GET', `/v1/builder/projects/${p.id}/form-submissions`, undefined, B()))
        .statusCode,
    ).toBe(404);
  });
  it('retention: expired submissions are purged', async () => {
    await e.sql(
      `UPDATE builder.form_submissions SET expires_at = now() - interval '1 day' WHERE project_id=$1`,
      [p.id],
    );
    expect(await e.app.get(FormsService).purgeExpired()).toBeGreaterThan(0);
    expect(
      Number(
        (
          await e.sql(`SELECT count(*) n FROM builder.form_submissions WHERE project_id=$1`, [p.id])
        )[0]!.n,
      ),
    ).toBe(0);
  });
  it('registering a form stores the notification address sealed', async () => {
    const r = await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/forms`, {
      formKey: 'quote',
      name: 'Quote',
      fields: [{ name: 'email', type: 'email', required: true }],
      notifyEmail: 'owner@example.com',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(j(r).notifyEmailSet).toBe(true);
    const row = (
      await e.sql(
        `SELECT notify_email_enc FROM builder.forms WHERE form_key='quote' AND project_id=$1`,
        [p.id],
      )
    )[0]!;
    expect(String(row.notify_email_enc)).toMatch(/^enc:v1:/);
    expect(
      (
        await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/forms`, {
          formKey: 'quote',
          name: 'Q',
          fields: [{ name: 'email', type: 'email' }],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/forms`, {
          formKey: 'q2',
          name: 'Q',
          fields: [{ name: 'website_url', type: 'text' }],
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe('CMS (S41.3)', () => {
  it('creates typed collections, validates items, keeps drafts out of the published set', async () => {
    const p = await mkProject('Cms Site');
    const r = await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/cms-collections`, {
      collectionKey: 'faqs',
      name: 'FAQs',
      fields: [
        { name: 'question', type: 'localized_text', required: true },
        { name: 'answer', type: 'localized_text' },
      ],
      items: [
        { data: { question: { ar: 'س', en: 'Q1' }, answer: { en: 'A1' } }, state: 'published' },
        { data: { question: { en: 'Q2' } } },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(((j(r).items as Row[])[0]!.items as Row[]).length).toBe(2);
    const pub = await e.app.get(CmsService).published(A(), p.id as string);
    expect(pub[0]!.items.length).toBe(1);
    expect(
      (
        await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/cms-collections`, {
          collectionKey: 'faqs',
          items: [{ data: { nope: 1 } }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/cms-collections`, {
          collectionKey: 'bad',
          name: 'x',
          fields: [{ name: 'a', type: 'html' }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('carol', 'POST', `/v1/builder/projects/${p.id}/cms-collections`, {
          collectionKey: 'faqs',
          items: [],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await e.call('bob', 'GET', `/v1/builder/projects/${p.id}/cms-collections`, undefined, B()))
        .statusCode,
    ).toBe(404);
  });
});

describe('AI website and edit runs (mock model: plumbing only)', () => {
  const session = async (title: string) =>
    (await e.call('alice', 'POST', '/v1/ai/sessions', { title })).json().id as string;
  const drive = async (runId: string) => {
    const r = (await e.sql(`SELECT operation_id FROM ai.runs WHERE id=$1`, [runId]))[0]!;
    await runs.runOne(A(), r.operation_id as string);
    return j(await e.call('alice', 'GET', `/v1/ai/runs/${runId}`));
  };
  it('website: architecture → plan approval → pages → a valid bilingual model as a NEW version (source ai)', async () => {
    const p = await mkProject('Generated Bakery', 'landing');
    const sid = await session('gen');
    const run = j(
      await e.call('alice', 'POST', '/v1/ai/runs', {
        sessionId: sid,
        kind: 'website',
        projectId: p.id,
        input: { description: 'مخبز في الرياض يقدم خبز طازج وحلويات' },
      }),
    );
    const w = await drive(run.id as string);
    expect(w.state).toBe('waiting_approval');
    expect(w.pendingApproval.kind).toBe('plan');
    expect(
      (
        await e.call('carol', 'POST', `/v1/ai/runs/${run.id}/approvals`, {
          approvalId: w.pendingApproval.id,
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await e.call('dave', 'POST', `/v1/ai/runs/${run.id}/approvals`, {
          approvalId: w.pendingApproval.id,
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(200);
    const done = await drive(run.id as string);
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    const h = await head(p.id as string);
    expect(h.headSeq).toBe(2);
    expect(
      (
        await e.sql(`SELECT source, run_id FROM builder.project_versions WHERE id=$1`, [
          h.headVersionId,
        ])
      )[0],
    ).toMatchObject({ source: 'ai', run_id: run.id });
    expect((h.siteModel.pages as Row[]).length).toBeGreaterThanOrEqual(2);
    const art = (done.artifacts as Row[]).map((a) => a.type);
    expect(art).toEqual(expect.arrayContaining(['architecture', 'site_model']));
  });
  it('website run on a denied plan is cancelled and leaves the project untouched', async () => {
    const p = await mkProject('Denied Plan', 'landing');
    const run = j(
      await e.call('alice', 'POST', '/v1/ai/runs', {
        sessionId: await session('d'),
        kind: 'website',
        projectId: p.id,
        input: { description: 'a shop' },
      }),
    );
    const w = await drive(run.id as string);
    const r = await e.call('alice', 'POST', `/v1/ai/runs/${run.id}/approvals`, {
      approvalId: w.pendingApproval.id,
      decision: 'deny',
    });
    expect(r.json().state).toBe('cancelled');
    expect((await head(p.id as string)).headSeq).toBe(1);
  });
  it('website needs a project; edit needs an instruction', async () => {
    const sid = await session('v');
    expect(
      (
        await e.call('alice', 'POST', '/v1/ai/runs', {
          sessionId: sid,
          kind: 'website',
          input: { description: 'x' },
        })
      ).statusCode,
    ).toBe(422);
    const p = await mkProject('Edit Validation', 'landing');
    expect(
      (
        await e.call('alice', 'POST', '/v1/ai/runs', {
          sessionId: sid,
          kind: 'edit',
          projectId: p.id,
          input: {},
        })
      ).statusCode,
    ).toBe(422);
  });
  it('edit: a chat instruction becomes a PROPOSED change set, applied only after a human accepts; a stale base is reported as a conflict', async () => {
    const p = await mkProject('Edit Me', 'landing');
    const sid = await session('edit');
    const run = j(
      await e.call('alice', 'POST', '/v1/ai/runs', {
        sessionId: sid,
        kind: 'edit',
        projectId: p.id,
        input: { instruction: 'Change the hero heading to "Fresh Dates Daily"' },
      }),
    );
    const w = await drive(run.id as string);
    expect(w.state).toBe('waiting_approval');
    expect(w.pendingApproval.kind).toBe('apply_changes');
    expect((await head(p.id as string)).headSeq).toBe(1); // nothing applied yet
    expect(
      Number(
        (
          await e.sql(
            `SELECT count(*) n FROM builder.changes WHERE project_id=$1 AND status='proposed'`,
            [p.id],
          )
        )[0]!.n,
      ),
    ).toBe(1);
    // a user edit lands between the proposal and the decision
    await change(p.id as string, p.headVersionId as string, [
      { op: 'setText', target: 'footerText', locale: 'en', value: 'Footer edited' },
    ]);
    await e.call('alice', 'POST', `/v1/ai/runs/${run.id}/approvals`, {
      approvalId: w.pendingApproval.id,
      decision: 'approve',
    });
    const done = await drive(run.id as string);
    expect(done.state).toBe('succeeded');
    expect(done.result.conflict).toBe(true);
    expect(done.result.applied).toBe(false);
    expect((await head(p.id as string)).headSeq).toBe(2);
  });
  it('edit: accepted → applied as an ai version; denied → rejected; low-risk auto-apply only when enabled and never for deletes', async () => {
    const p = await mkProject('Edit Two', 'landing');
    const instr = 'Change the hero heading to "Brand New Heading"';
    const mk = async () =>
      j(
        await e.call('alice', 'POST', '/v1/ai/runs', {
          sessionId: await session(`e${Math.random()}`),
          kind: 'edit',
          projectId: p.id,
          input: { instruction: instr },
        }),
      );
    let run = await mk();
    let w = await drive(run.id as string);
    await e.call('alice', 'POST', `/v1/ai/runs/${run.id}/approvals`, {
      approvalId: w.pendingApproval.id,
      decision: 'approve',
    });
    expect((await drive(run.id as string)).result.applied).toBe(true);
    expect((await head(p.id as string)).headSeq).toBe(2);
    run = await mk();
    w = await drive(run.id as string);
    await e.call('alice', 'POST', `/v1/ai/runs/${run.id}/approvals`, {
      approvalId: w.pendingApproval.id,
      decision: 'deny',
    });
    expect((await drive(run.id as string)).result.rejected).toBe(true);
    expect(
      Number(
        (
          await e.sql(
            `SELECT count(*) n FROM builder.changes WHERE project_id=$1 AND status='rejected'`,
            [p.id],
          )
        )[0]!.n,
      ),
    ).toBe(1);
    // enable auto-apply (a human decision in the budgets): a low-risk change now applies without an approval
    const etag = (await e.call('alice', 'GET', '/v1/ai/budgets')).headers.etag as string;
    expect(
      (
        await e.call('alice', 'PUT', '/v1/ai/budgets', { org: { autoApplyLowRisk: true } }, A(), {
          'if-match': etag,
        })
      ).statusCode,
    ).toBe(200);
    run = j(
      await e.call('alice', 'POST', '/v1/ai/runs', {
        sessionId: await session('auto'),
        kind: 'edit',
        projectId: p.id,
        input: { instruction: 'Change the hero heading to "Auto Applied"' },
      }),
    );
    const auto = await drive(run.id as string);
    expect(auto.result.autoApplied).toBe(true);
    expect((await head(p.id as string)).headSeq).toBe(3);
    // an AI proposal that deletes a component is NEVER auto-applied
    const m = (await head(p.id as string)).siteModel;
    const target = m.pages[0].sections[m.pages[0].sections.length - 1];
    const adapter = e.registry.get('mock-model') as MockModelAdapter;
    const prev = adapter.handler;
    adapter.handler = (req, ctx) =>
      req.task === 'edit'
        ? JSON.stringify({
            result: {
              summary: { ar: 'حذف', en: 'delete' },
              ops: [{ op: 'deleteComponent', pageId: m.pages[0].id, sectionId: target.id }],
            },
          })
        : prev(req, ctx);
    run = j(
      await e.call('alice', 'POST', '/v1/ai/runs', {
        sessionId: await session('del'),
        kind: 'edit',
        projectId: p.id,
        input: { instruction: 'Remove the last section' },
      }),
    );
    const del = await drive(run.id as string);
    adapter.handler = prev;
    expect(del.state).toBe('waiting_approval');
    expect((del.pendingApproval.summary as Row).risks).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'deletes_component' })]),
    );
    expect((await head(p.id as string)).headSeq).toBe(3);
    void AiJobs;
    void SessionService;
  });
});
