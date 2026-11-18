import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader } from '../identity/testing/app-harness';
import { makeSession, type Session } from '../data/testing/data-harness';
import { ModelGatewayPort, ProjectsPort, OrgBudgetPort, RunStorePort } from './index';
import { AppRunService } from './index';
import { CRM_SPEC } from './internal/fixtures/crm-appspec';
import { DeployTargetPort, DevStaticTarget } from './internal/deploy/ports';
import type { ScriptedModelGateway } from './internal/ports/m09-mock';
import { WEBAPP_GRAPH } from './internal/graph/dag';
import { generateProject, packageJson } from './internal/gen/project';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let e: Session & { sink: { events: { action: string }[] } };
let target: DevStaticTarget;
const fakeLock = () =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {},
      ...Object.fromEntries(
        Object.keys({
          ...(packageJson(CRM_SPEC).dependencies as object),
          ...(packageJson(CRM_SPEC).devDependencies as object),
        }).map((n) => [
          `node_modules/${n}`,
          {
            version: '1.0.0',
            resolved: `https://npm-mirror.nuzm.internal/${n}.tgz`,
            integrity: 'sha512-AAAA',
            license: 'MIT',
          },
        ]),
      ),
    },
  });
const call = (
  who: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: object,
  org?: string,
  extra?: Record<string, string>,
) => e.call(who, method, url, body, org, extra);
const A = () => e.org.A!;
const B = () => e.org.B!;

beforeAll(async () => {
  process.env.APPBUILDER_KICK = 'off';
  process.env.NODE_ENV = 'test';
  const h = new Harness();
  await h.init();
  const { app, sink } = await h.buildApp({}, undefined, [], {});
  const s = makeSession(h, app);
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    s.ids[n] = await h.createUser(n);
    s.jars[n] = await h.sessionFor(app, s.ids[n]!);
  }
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) await h.elevate(s.jars[n]!);
  const mk = async (who: string, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(s.jars[who]!), 'x-csrf-token': s.jars[who]!.nuzm_csrf! },
        payload: { name },
      })
    ).json().id as string;
  s.org.A = await mk('alice', 'Builder A');
  s.org.B = await mk('bob', 'Builder B');
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'developer'],
    ['erin', 'admin'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [s.org.A, s.ids[u], role],
    );
  const p1 = await h.platformUser(app, 'padmin', ['platform_admin']);
  s.jars.padmin = p1.jar;
  e = Object.assign(s, { sink: sink as never });
  target = app.get(DeployTargetPort) as DevStaticTarget;
  (e as unknown as { app: typeof app }).app = app;
  (e as unknown as { env: typeof h.env }).env = h.env;
}, 180_000);
afterAll(() => e.h.close());
const app = () => (e as unknown as { app: { get: <T>(t: unknown) => T } }).app;
const sql = (q: string, p: unknown[] = []) =>
  (e as unknown as { env: { sql: (q: string, p?: unknown[]) => Promise<Row[]> } }).env.sql(q, p);

describe('feature flag default OFF', () => {
  it('every endpoint answers 404 until app_builder.enabled is on', async () => {
    for (const [m, u] of [
      ['GET', `/v1/builder/projects/${randomUUID()}/sandboxes`],
      ['GET', '/v1/deployments'],
      ['GET', '/v1/ai/approvals'],
      ['POST', `/v1/builder/projects/${randomUUID()}/changes`],
    ] as const) {
      const r = await call('alice', m, u, m === 'POST' ? {} : undefined, A());
      expect(r.statusCode, `${m} ${u}`).toBe(404);
    }
    for (const org of [A(), B()]) {
      await sql(
        `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'app_builder.enabled', $1, 'true'::jsonb)`,
        [org],
      );
      await sql(
        `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'app_builder.m09_stubs', $1, 'true'::jsonb)`,
        [org],
      );
    }
    expect((await call('alice', 'GET', '/v1/deployments', undefined, A())).statusCode).toBe(200);
  });
});

describe('web-app project -> changes -> sandbox -> tests -> export -> run -> approvals -> deployments over HTTP (AR/EN independent)', () => {
  let projectId = '';
  let versionId = '';
  it('creates a project (builder:write; a viewer is 403) and applies the generated scaffold through the checked changes endpoint', async () => {
    expect(
      (await call('carol', 'POST', '/v1/builder/projects', { type: 'webapp', name: 'CRM' }, A()))
        .statusCode,
    ).toBe(403);
    const r = await call(
      'alice',
      'POST',
      '/v1/builder/projects',
      { type: 'webapp', name: 'CRM' },
      A(),
    );
    expect(r.statusCode).toBe(201);
    projectId = r.json().id;
    const files = generateProject(CRM_SPEC).files;
    const patches = [...files]
      .map(([path, content]) => ({ op: 'add', path, content }))
      .concat([{ op: 'add', path: 'package-lock.json', content: fakeLock() }]);
    const c = await call(
      'alice',
      'POST',
      `/v1/builder/projects/${projectId}/changes`,
      { baseVersion: null, patches, source: 'user', message: 'initial scaffold' },
      A(),
    );
    expect(c.statusCode, c.body.slice(0, 300)).toBe(201);
    versionId = c.json().versionId;
    expect(c.json()).toMatchObject({ branch: 'main', diff: { added: expect.any(Array) } });
    expect(
      (
        await call(
          'alice',
          'POST',
          `/v1/builder/projects/${projectId}/changes`,
          { baseVersion: null, patches: [{ op: 'add', path: 'x.txt', content: '1' }] },
          A(),
        )
      ).json().code,
    ).toBe('base_mismatch');
    const bad = await call(
      'alice',
      'POST',
      `/v1/builder/projects/${projectId}/changes`,
      { baseVersion: versionId, patches: [{ op: 'add', path: '../../etc/passwd', content: 'x' }] },
      A(),
    );
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('change_rejected');
    const files2 = await call(
      'alice',
      'GET',
      `/v1/builder/projects/${projectId}/files`,
      undefined,
      A(),
    );
    expect(files2.json().items.length).toBeGreaterThan(30);
    const content = await call(
      'alice',
      'GET',
      `/v1/builder/projects/${projectId}/files/content?path=src/engine.ts`,
      undefined,
      A(),
    );
    expect(content.json().content).toContain('buildRouter');
    expect(
      (
        await call(
          'alice',
          'GET',
          `/v1/builder/projects/${projectId}/files/content?path=../x`,
          undefined,
          A(),
        )
      ).statusCode,
    ).toBe(404);
  });

  it('sandboxes: create / get / list / delete, quota and roles, runtime labelled simulated', async () => {
    expect(
      (await call('carol', 'POST', `/v1/builder/projects/${projectId}/sandboxes`, {}, A()))
        .statusCode,
    ).toBe(403);
    const r = await call(
      'dave',
      'POST',
      `/v1/builder/projects/${projectId}/sandboxes`,
      { ttlMinutes: 30 },
      A(),
    );
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({
      state: 'ready',
      runtime: { kind: 'mock', isolation: 'simulated' },
    });
    const id = r.json().id;
    expect(
      (
        await call(
          'dave',
          'GET',
          `/v1/builder/projects/${projectId}/sandboxes/${id}`,
          undefined,
          A(),
        )
      ).json().id,
    ).toBe(id);
    expect(
      (
        await call('dave', 'GET', `/v1/builder/projects/${projectId}/sandboxes`, undefined, A())
      ).json().items.length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (
        await call(
          'dave',
          'DELETE',
          `/v1/builder/projects/${projectId}/sandboxes/${id}`,
          undefined,
          A(),
        )
      ).json().state,
    ).toBe('terminated');
    expect(
      (
        await call(
          'dave',
          'POST',
          `/v1/builder/projects/${projectId}/sandboxes`,
          { profile: 'huge' },
          A(),
        )
      ).statusCode,
    ).toBe(422);
    expect(e.sink.events.some((x) => x.action === 'sandbox.sandbox.created')).toBe(true);
  });

  it('test-runs: 202 queued; a suite the project does not declare is 422; exports: ready with a signed URL; blocked ones are 422', async () => {
    expect(
      (
        await call(
          'carol',
          'POST',
          `/v1/builder/projects/${projectId}/test-runs`,
          { suite: 'unit' },
          A(),
        )
      ).statusCode,
    ).toBe(403);
    const t = await call(
      'dave',
      'POST',
      `/v1/builder/projects/${projectId}/test-runs`,
      { suite: 'unit' },
      A(),
    );
    expect(t.statusCode).toBe(202);
    expect(t.json().status).toBe('queued');
    expect(
      (
        await call(
          'dave',
          'POST',
          `/v1/builder/projects/${projectId}/test-runs`,
          { suite: 'e2e' },
          A(),
        )
      ).json().code,
    ).toBe('test_suite_unavailable');
    expect(
      (
        await call(
          'carol',
          'GET',
          `/v1/builder/projects/${projectId}/test-runs/${t.json().id}`,
          undefined,
          A(),
        )
      ).statusCode,
    ).toBe(200);
    const ex = await call('alice', 'POST', `/v1/builder/projects/${projectId}/exports`, {}, A());
    expect(ex.statusCode, ex.body.slice(0, 300)).toBe(202);
    expect(ex.json()).toMatchObject({
      status: 'ready',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const got = await call(
      'alice',
      'GET',
      `/v1/builder/projects/${projectId}/exports/${ex.json().id}`,
      undefined,
      A(),
    );
    expect(got.json().downloadUrl).toMatch(/^https:\/\//);
    expect(
      (await call('carol', 'POST', `/v1/builder/projects/${projectId}/exports`, {}, A()))
        .statusCode,
    ).toBe(403);
    const leak = await call(
      'alice',
      'POST',
      `/v1/builder/projects/${projectId}/changes`,
      {
        baseVersion: versionId,
        patches: [{ op: 'add', path: 'src/k.ts', content: 'const k = "AKIAABCDEFGHIJKLMNOP";' }],
      },
      A(),
    );
    expect(leak.statusCode).toBe(422);
    expect(JSON.stringify(leak.json())).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('runs: webapp run over the scripted model, redacted tool calls, live budget meter; cancellation and 422 for mobile / unknown kinds', async () => {
    const model = app().get<ScriptedModelGateway>(ModelGatewayPort);
    model.register('requirements', () => ({
      summary: 'CRM',
      entities: CRM_SPEC.entities.map((x) => ({ name: x.name })),
      roles: CRM_SPEC.roles.map((r) => r.name),
      locales: ['ar', 'en'],
    }));
    model.register('app_spec', () => CRM_SPEC);
    const p2 = await call(
      'alice',
      'POST',
      '/v1/builder/projects',
      { type: 'webapp', name: 'Gen' },
      A(),
    );
    const r = await call(
      'alice',
      'POST',
      '/v1/ai/runs',
      {
        kind: 'webapp',
        projectId: p2.json().id,
        budget: { maxTokens: 900_000, maxCostMinor: 1_000_000, maxMinutes: 30 },
      },
      A(),
    );
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ state: 'queued', budgetRemaining: { tokens: 900_000 } });
    const run = (await app().get<RunStorePort>(RunStorePort).get(A(), r.json().id))!;
    await app()
      .get<AppRunService>(AppRunService)
      .execute(A(), e.ids.alice!, run, { prompt: 'a CRM' });
    const v = (await call('carol', 'GET', `/v1/ai/runs/${r.json().id}`, undefined, A())).json();
    expect(v.state).toBe('succeeded');
    expect(v.steps.map((s: Row) => s.node)).toEqual([
      'requirements',
      'architecture',
      'database',
      'backend',
      'frontend',
      'qa',
      'devops',
    ]);
    expect(v.budgetRemaining.tokens).toBeLessThan(900_000);
    expect(JSON.stringify(v)).not.toMatch(/"content"|prompt/i);
    expect(
      (await call('alice', 'GET', `/v1/ai/runs/${r.json().id}/events`, undefined, A())).json()
        .events.length,
    ).toBe(7);
    const mob = await call(
      'alice',
      'POST',
      '/v1/ai/runs',
      { kind: 'mobile', projectId: p2.json().id },
      A(),
    );
    expect(mob.statusCode).toBe(422);
    expect(
      (
        await call(
          'alice',
          'POST',
          '/v1/ai/runs',
          { kind: 'website', projectId: p2.json().id },
          A(),
        )
      ).json().code,
    ).toBe('unsupported_capability');
    const r2 = await call(
      'alice',
      'POST',
      '/v1/ai/runs',
      { kind: 'webapp', projectId: p2.json().id },
      A(),
    );
    expect(
      (await call('alice', 'POST', `/v1/ai/runs/${r2.json().id}/cancellation`, {}, A())).json()
        .state,
    ).toBe('cancelled');
    expect(
      (await call('alice', 'POST', `/v1/ai/runs/${r2.json().id}/cancellation`, {}, A())).statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          'alice',
          'POST',
          '/v1/ai/runs',
          {
            kind: 'webapp',
            projectId: p2.json().id,
            budget: { maxTokens: 99_999_999, maxCostMinor: 1, maxMinutes: 5 },
          },
          A(),
        )
      ).statusCode,
    ).toBe(422);
  });

  it('deployments: production needs an approval (403 lists it); only the roles of the type may decide; stale hash 409; then it deploys; duplicate POST with one key is one deployment; rollback is idempotent', async () => {
    const t = target.register({
      id: randomUUID(),
      orgId: A(),
      type: 'site',
      region: 'sa-central',
      status: 'active',
      newPaidResource: false,
    });
    const body = { projectId, versionId, target: { type: 'site', id: t.id }, env: 'production' };
    expect((await call('carol', 'POST', '/v1/deployments', body, A())).statusCode).toBe(403); // viewer: deploy:create missing
    const need = await call('dave', 'POST', '/v1/deployments', body, A());
    expect(need.statusCode).toBe(403);
    expect(need.json().code).toBe('approval_required');
    const ap = need.json().approvals[0];
    expect(ap.type).toBe('production_deploy');
    const inbox = (
      await call('carol', 'GET', '/v1/ai/approvals?status=pending', undefined, A())
    ).json().items;
    expect(inbox.some((x: Row) => x.id === ap.id)).toBe(true);
    expect(
      (
        await call(
          'dave',
          'POST',
          `/v1/ai/approvals/${ap.id}/decisions`,
          { decision: 'approve', scopeHash: ap.scopeHash },
          A(),
        )
      ).statusCode,
    ).toBe(403); // developer may not approve a production deploy
    expect(
      (
        await call(
          'erin',
          'POST',
          `/v1/ai/approvals/${ap.id}/decisions`,
          { decision: 'approve', scopeHash: 'e'.repeat(64) },
          A(),
        )
      ).json().code,
    ).toBe('stale_approval_hash');
    const ok = await call(
      'erin',
      'POST',
      `/v1/ai/approvals/${ap.id}/decisions`,
      { decision: 'approve', scopeHash: ap.scopeHash },
      A(),
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('approved');
    expect(
      (
        await call(
          'erin',
          'POST',
          `/v1/ai/approvals/${ap.id}/decisions`,
          { decision: 'approve', scopeHash: ap.scopeHash },
          A(),
        )
      ).statusCode,
    ).toBe(200); // identical repeat
    expect(
      (
        await call(
          'alice',
          'POST',
          `/v1/ai/approvals/${ap.id}/decisions`,
          { decision: 'reject', scopeHash: ap.scopeHash },
          A(),
        )
      ).statusCode,
    ).toBe(409);
    const key = { 'idempotency-key': 'deploy-1' };
    const d1 = await call('dave', 'POST', '/v1/deployments', body, A(), key);
    const d2 = await call('dave', 'POST', '/v1/deployments', body, A(), key);
    expect(d1.statusCode).toBe(202);
    expect(d2.json().id).toBe(d1.json().id);
    expect(d2.headers['idempotent-replayed']).toBe('true');
    expect(
      (
        await sql(
          `SELECT count(*)::int n FROM deploy.app_deployments WHERE org_id = $1 AND target_id = $2`,
          [A(), t.id],
        )
      )[0]!.n,
    ).toBe(1);
    expect(
      (await call('carol', 'GET', `/v1/deployments/${d1.json().id}/logs`, undefined, A()))
        .statusCode,
    ).toBe(200);
    expect(
      (await call('carol', 'POST', `/v1/deployments/${d1.json().id}/rollback`, {}, A())).statusCode,
    ).toBe(403);
    expect(
      (await call('dave', 'POST', `/v1/deployments/${d1.json().id}/rollback`, {}, A())).json().code,
    ).toBe('invalid_state'); // not live yet / no earlier release
  });

  it('CROSS-TENANT MATRIX: org B gets 404 for every org A resource on every §6 endpoint (AC-M10-08)', async () => {
    const sb = await call('dave', 'POST', `/v1/builder/projects/${projectId}/sandboxes`, {}, A());
    const sid = sb.json().id;
    const tr = (
      await call('dave', 'GET', `/v1/builder/projects/${projectId}/test-runs`, undefined, A())
    ).json().items[0].id;
    const ex = (
      await call('alice', 'GET', `/v1/builder/projects/${projectId}/exports`, undefined, A())
    ).json().items[0].id;
    const dep = (
      await call('alice', 'GET', `/v1/deployments?projectId=${projectId}`, undefined, A())
    ).json().items[0].id;
    const ap = (await call('alice', 'GET', '/v1/ai/approvals', undefined, A())).json().items[0].id;
    const run = (
      await call('alice', 'GET', `/v1/ai/runs?projectId=${projectId}`, undefined, A())
    ).json();
    const rid = run.items[0]?.id ?? (await app().get<RunStorePort>(RunStorePort).list(A()))[0]!.id;
    const matrix: [string, string, object?][] = [
      ['GET', `/v1/builder/projects/${projectId}`],
      ['GET', `/v1/builder/projects/${projectId}/files`],
      ['GET', `/v1/builder/projects/${projectId}/files/content?path=README.md`],
      [
        'POST',
        `/v1/builder/projects/${projectId}/changes`,
        { baseVersion: versionId, patches: [{ op: 'add', path: 'z.txt', content: '1' }] },
      ],
      ['POST', `/v1/builder/projects/${projectId}/sandboxes`, {}],
      ['GET', `/v1/builder/projects/${projectId}/sandboxes`],
      ['GET', `/v1/builder/projects/${projectId}/sandboxes/${sid}`],
      ['DELETE', `/v1/builder/projects/${projectId}/sandboxes/${sid}`],
      ['POST', `/v1/builder/projects/${projectId}/test-runs`, { suite: 'unit' }],
      ['GET', `/v1/builder/projects/${projectId}/test-runs`],
      ['GET', `/v1/builder/projects/${projectId}/test-runs/${tr}`],
      ['POST', `/v1/builder/projects/${projectId}/exports`, {}],
      ['GET', `/v1/builder/projects/${projectId}/exports`],
      ['GET', `/v1/builder/projects/${projectId}/exports/${ex}`],
      [
        'POST',
        '/v1/deployments',
        { projectId, versionId, target: { type: 'site', id: randomUUID() }, env: 'staging' },
      ],
      ['GET', `/v1/deployments/${dep}`],
      ['GET', `/v1/deployments/${dep}/logs`],
      ['POST', `/v1/deployments/${dep}/rollback`, {}],
      ['GET', `/v1/ai/approvals/${ap}`],
      [
        'POST',
        `/v1/ai/approvals/${ap}/decisions`,
        { decision: 'approve', scopeHash: 'a'.repeat(64) },
      ],
      ['GET', `/v1/ai/runs/${rid}`],
      ['GET', `/v1/ai/runs/${rid}/events`],
      ['POST', `/v1/ai/runs/${rid}/cancellation`, {}],
      ['POST', '/v1/ai/runs', { kind: 'webapp', projectId }],
    ];
    for (const [m, u, b] of matrix) {
      const r = await call('bob', m as never, u, b, B());
      expect(r.statusCode, `${m} ${u} -> ${r.statusCode} ${r.body.slice(0, 120)}`).toBe(404);
    }
    // lists of org B never contain org A rows
    expect((await call('bob', 'GET', '/v1/deployments', undefined, B())).json().items).toEqual([]);
    expect((await call('bob', 'GET', '/v1/ai/approvals', undefined, B())).json().items).toEqual([]);
    expect((await call('bob', 'GET', '/v1/builder/projects', undefined, B())).json().items).toEqual(
      [],
    );
  });
});

describe('admin run oversight (UI-M10-18): metadata only, admin realm only', () => {
  it('a platform admin reads run metadata; a customer session is refused', async () => {
    const r = await e.admin('padmin', 'GET', '/v1/admin/ai/runs');
    expect(r.statusCode).toBe(200);
    expect(r.json().items.length).toBeGreaterThan(0);
    for (const it of r.json().items) expect(Object.keys(it)).not.toContain('steps');
    expect(
      (await call('alice', 'GET', '/v1/admin/ai/runs', undefined, A())).statusCode,
    ).toBeGreaterThanOrEqual(401);
  });
});
void ProjectsPort;
void OrgBudgetPort;
