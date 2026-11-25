import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalService } from './internal/approvals/approval.service';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';

/**
 * O-9 route `GET|PUT /v1/builder/policies/content-access` (CONTRACT-S05-P2-2, revised by the Master: the PUT is SESSION-ONLY, an API key is refused 403). Covers: GET for every role,
 * PUT by owner (session) and by an admin-less role (403), PUT with an API key (403, even an owner's key with every scope; nothing changes, nothing is audited as changed), validation
 * (422), and that the setting really drives the five content reads.
 */
let e: AiEnv;
const A = () => e.org.A!;
const URL = '/v1/builder/policies/content-access';
const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await e.sql(sql, p)) as Row[];

beforeAll(async () => {
  e = await setupAiEnv();
  for (const k of [
    'builder_tools.enabled',
    'app_builder.enabled',
    'ai_studio.enabled',
    'knowledge.generation',
    'knowledge.customer_templates',
  ])
    await q(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, 'true'::jsonb)`,
      [k, A()],
    );
}, 300_000);
afterAll(() => e.h.close());

describe('content-access policy route', () => {
  it('reads: every member sees the setting, default allow', async () => {
    for (const who of ['alice', 'dave', 'carol', 'frank']) {
      const r = await e.call(who, 'GET', URL, undefined, A());
      expect(r.statusCode, who).toBe(200);
      expect(r.json()).toEqual({ mode: 'allow', default: 'allow' });
    }
  });
  it('writes: a session owner can; a developer, viewer and billing admin cannot (403)', async () => {
    for (const who of ['dave', 'carol', 'frank'])
      expect((await e.call(who, 'PUT', URL, { mode: 'deny' }, A())).statusCode, who).toBe(403);
    expect((await e.call('alice', 'PUT', URL, { mode: 'deny' }, A())).json()).toEqual({
      mode: 'deny',
      default: 'allow',
    });
    expect((await e.call('alice', 'PUT', URL, { mode: 'allow' }, A())).statusCode).toBe(200);
  });
  it('an API key can NEVER change it, whatever its scopes or its owner: 403, nothing changes, nothing is audited as changed', async () => {
    const k = await e.call(
      'alice',
      'POST',
      '/v1/api-keys',
      { name: 'o9', scopes: ['org:update', 'org:read', 'builder:read', 'builder:write'] },
      A(),
    );
    expect(k.statusCode, k.body).toBe(201);
    const bearer = k.json().key as string;
    const before = e.sink.events.filter(
      (x) => x.action === 'builder.policy.content_access_changed',
    ).length;
    const put = await e.app.inject({
      method: 'PUT',
      url: URL,
      headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': 'o9-key' },
      payload: { mode: 'deny' },
    });
    expect(put.statusCode, put.body).toBe(403);
    expect((await e.call('alice', 'GET', URL, undefined, A())).json().mode).toBe('allow');
    expect(
      e.sink.events.filter((x) => x.action === 'builder.policy.content_access_changed').length,
    ).toBe(before);
    // a key may still READ the setting
    const get = await e.app.inject({
      method: 'GET',
      url: URL,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(get.statusCode).toBe(200);
  });
  it('malformed bodies are 422, and the setting drives the content reads', async () => {
    for (const body of [{}, { mode: 'maybe' }, { mode: 'deny', extra: 1 }])
      expect((await e.call('alice', 'PUT', URL, body, A())).statusCode, JSON.stringify(body)).toBe(
        422,
      );
    const p = (
      await e.call(
        'alice',
        'POST',
        '/v1/builder/projects',
        { name: 'O9 route', type: 'webapp' },
        A(),
      )
    ).json().id as string;
    await e.call(
      'alice',
      'POST',
      `/v1/builder/projects/${p}/changes`,
      {
        baseVersion: null,
        source: 'user',
        patches: [{ op: 'add', path: 'a.ts', content: 'export {};\n' }],
      },
      A(),
    );
    expect(
      (await e.call('frank', 'GET', `/v1/builder/projects/${p}/review`, undefined, A())).statusCode,
    ).toBe(200);
    await e.call('alice', 'PUT', URL, { mode: 'deny' }, A());
    expect(
      (await e.call('frank', 'GET', `/v1/builder/projects/${p}/review`, undefined, A())).statusCode,
    ).toBe(403);
    await e.call('alice', 'PUT', URL, { mode: 'allow' }, A());
  });
});

describe('O-9 covers every content-returning read of the builder (S07 audit, DEFECT-16)', () => {
  const MARK = 'O9-PLANTED-MARKER-9f2c';
  let webapp = '';
  let website = '';
  let v1 = '';
  let v2 = '';
  const U = '0198a3c0-aaaa-7000-8000-00000000abcd';

  async function setup() {
    for (const [type, name] of [
      ['webapp', 'O9 families app'],
      ['website', 'O9 families site'],
    ] as const) {
      const id = (await e.call('alice', 'POST', '/v1/builder/projects', { name, type }, A())).json()
        .id as string;
      if (type === 'webapp') webapp = id;
      else website = id;
    }
    const put = (path: string, content: string, base: string | null) =>
      e.call(
        'alice',
        'POST',
        `/v1/builder/projects/${webapp}/changes`,
        { baseVersion: base, source: 'user', patches: [{ op: 'add', path, content }] },
        A(),
      );
    expect((await put('README.md', `# ${MARK}\n`, null)).statusCode).toBe(200);
    const head = (
      await q(`SELECT head_version_id h FROM builder.projects WHERE id = $1`, [webapp])
    )[0]!.h as string;
    expect((await put('src/more.ts', `export const x = '${MARK}';\n`, head)).statusCode).toBe(200);
    const vs = await q(
      `SELECT id FROM builder.project_versions WHERE project_id = $1 ORDER BY seq`,
      [webapp],
    );
    v1 = vs[0]!.id as string;
    v2 = vs[1]!.id as string;
  }
  /** [url, unused flag marker kept for readability] */
  const routes = (): [string, boolean][] => [
    [`/v1/builder/projects/${webapp}/version-diff?from=${v1}&to=${v2}`, false],
    [`/v1/builder/projects/${webapp}/files/content?path=README.md`, false],
    [`/v1/builder/projects/${webapp}/files/search?q=planted`, true],
    [`/v1/builder/projects/${webapp}/template-workspace`, true],
    [`/v1/builder/projects/${webapp}/claude-code`, true],
    [`/v1/builder/projects/${webapp}/instructions`, true],
    [`/v1/builder/projects/${webapp}/instructions/versions`, true],
    [`/v1/builder/projects/${webapp}/test-runs`, true],
    [`/v1/builder/projects/${webapp}/test-runs/${U}`, true],
    [`/v1/builder/projects/${website}/previews`, false],
    [`/v1/builder/projects/${website}/forms`, false],
    [`/v1/builder/projects/${website}/form-submissions`, false],
    [`/v1/builder/projects/${website}/cms-collections`, false],
    [`/v1/builder/generation-plans/${U}`, true],
    [`/v1/builder/generation-plans/${U}/context`, true],
    [`/v1/builder/generation-plans/${U}/timeline`, true],
  ];
  const metadata = () => [
    '/v1/builder/projects',
    `/v1/builder/projects/${webapp}`,
    `/v1/builder/projects/${webapp}/files`,
    `/v1/builder/projects/${webapp}/versions`,
    '/v1/ai/credits',
  ];
  const get = (who: string, url: string) => e.call(who, 'GET', url, undefined, A());

  it('default allow: nobody is blocked by the policy (a billing admin reads the planted file text, as today)', async () => {
    await setup();
    await e.call('alice', 'PUT', URL, { mode: 'allow' }, A());
    const r = await get('frank', `/v1/builder/projects/${webapp}/files/content?path=README.md`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain(MARK);
    const diff = await get(
      'frank',
      `/v1/builder/projects/${webapp}/version-diff?from=${v1}&to=${v2}`,
    );
    expect(diff.statusCode).toBe(200);
    expect(diff.body).toContain(MARK);
    for (const [url] of routes()) expect((await get('frank', url)).statusCode, url).not.toBe(403);
  });

  it('deny: every content route refuses the billing admin with 403 (flags of the studio and generation features are on), nothing planted leaks, and metadata stays readable', async () => {
    expect((await e.call('alice', 'PUT', URL, { mode: 'deny' }, A())).statusCode).toBe(200);
    const before = e.sink.events.filter((x) => x.action === 'builder.content.access_denied').length;
    for (const [url] of routes()) {
      const r = await get('frank', url);
      expect(r.statusCode, url).toBe(403);
      expect(r.body, url).not.toContain(MARK);
    }
    // the unflagged routes were refused BY THE POLICY and audited with their operation
    const denied = e.sink.events
      .filter((x) => x.action === 'builder.content.access_denied')
      .slice(before);
    expect(denied.length).toBeGreaterThanOrEqual(routes().length);
    expect(new Set(denied.map((d) => d.detail.operation))).toEqual(
      expect.objectContaining(
        new Set(['version_diff', 'file_content', 'previews', 'forms', 'form_submissions', 'cms']),
      ),
    );
    for (const url of metadata()) expect((await get('frank', url)).statusCode, url).toBe(200);
  });

  it('deny affects billing_admin ONLY: owner, developer and viewer still read the same routes', async () => {
    for (const who of ['alice', 'dave', 'carol'])
      for (const [url] of routes())
        expect((await get(who, url)).statusCode, `${who} ${url}`).not.toBe(403);
    const r = await get('alice', `/v1/builder/projects/${webapp}/files/content?path=README.md`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(MARK);
    // allow restores the billing admin
    await e.call('alice', 'PUT', URL, { mode: 'allow' }, A());
    expect(
      (await get('frank', `/v1/builder/projects/${webapp}/files/content?path=README.md`))
        .statusCode,
    ).toBe(200);
  });
});

describe('O-9: approvals carry free text that can quote customer data', () => {
  const NOTE = 'O9-APPROVAL-FREE-TEXT-77b1';
  let ids: { deploy: string; paid: string } = { deploy: '', paid: '' };
  const get = (who: string, url: string) => e.call(who, 'GET', url, undefined, A());

  it('setup: one deployment approval and one paid-resource approval, both with free text', async () => {
    const approvals = e.app.get(ApprovalService);
    const project = (await q(`SELECT id FROM builder.projects WHERE org_id = $1 LIMIT 1`, [A()]))[0]
      ?.id as string;
    const mk = async (type: 'production_deploy' | 'paid_resource', n: number) =>
      (
        await approvals.request(A(), {
          subject: { type: 'project', id: project },
          type,
          action: { summary: `${NOTE} ${type} ${n}`, amountMinor: 1000 },
          requestedBy: { kind: 'user', userId: e.ids.alice! },
          dataRegion: 'sa-central',
        })
      ).id;
    ids = { deploy: await mk('production_deploy', 1), paid: await mk('paid_resource', 2) };
    await e.call('alice', 'PUT', URL, { mode: 'allow' }, A());
  });

  it('default allow: a billing admin reads the free text, as today', async () => {
    const list = await get('frank', '/v1/ai/approvals?status=pending');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(NOTE);
    expect((await get('frank', `/v1/ai/approvals/${ids.deploy}`)).body).toContain(NOTE);
  });

  it('deny: the billing admin gets ids, type, state and timestamps but NO free text of a non-financial approval; financial approvals stay whole; audited', async () => {
    await e.call('alice', 'PUT', URL, { mode: 'deny' }, A());
    const before = e.sink.events.filter((x) => x.action === 'builder.content.redacted').length;
    const list = await get('frank', '/v1/ai/approvals?status=pending');
    expect(list.statusCode).toBe(200);
    const byId = new Map((list.json().items as Row[]).map((r) => [r.id as string, r]));
    const d = byId.get(ids.deploy)!;
    expect(d).toMatchObject({
      id: ids.deploy,
      type: 'production_deploy',
      status: 'pending',
      action: { redacted: true },
      decisionNote: null,
    });
    expect(d.createdAt).toBeTruthy();
    expect(JSON.stringify(d)).not.toContain(NOTE);
    const paid = byId.get(ids.paid)!;
    expect(paid.action.summary).toContain(NOTE); // the billing role decides these: the action is financial
    const one = await get('frank', `/v1/ai/approvals/${ids.deploy}`);
    expect(one.statusCode).toBe(200);
    expect(one.body).not.toContain(NOTE);
    expect((await get('frank', `/v1/ai/approvals/${ids.paid}`)).body).toContain(NOTE);
    expect(
      e.sink.events.filter((x) => x.action === 'builder.content.redacted').length,
    ).toBeGreaterThan(before);
  });

  it('deny leaves every other role unredacted, and allow restores the billing admin', async () => {
    for (const who of ['alice', 'dave', 'carol'])
      expect((await get(who, `/v1/ai/approvals/${ids.deploy}`)).body, who).toContain(NOTE);
    await e.call('alice', 'PUT', URL, { mode: 'allow' }, A());
    expect((await get('frank', `/v1/ai/approvals/${ids.deploy}`)).body).toContain(NOTE);
  });
});
