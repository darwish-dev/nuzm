import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader } from '../identity/testing/app-harness';
import { makeSession, type Session } from '../data/testing/data-harness';
import { ApprovalService, ProjectsPort } from './index';
import { CRM_SPEC } from './internal/fixtures/crm-appspec';
import { generateProject, packageJson } from './internal/gen/project';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let e: Session & { sink: { events: { action: string }[] } };
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
      ['GET', '/v1/ai/approvals'],
      ['GET', `/v1/builder/projects/${randomUUID()}/exports`],
    ] as const) {
      const r = await call('alice', m, u, undefined, A());
      expect(r.statusCode, `${m} ${u}`).toBe(404);
    }
    for (const org of [A(), B()])
      await sql(
        `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'app_builder.enabled', $1, 'true'::jsonb)`,
        [org],
      );
    expect((await call('alice', 'GET', '/v1/ai/approvals', undefined, A())).statusCode).toBe(200);
  });
});

describe('web-app project: sandboxes, test-runs, exports, approvals over HTTP', () => {
  let projectId = '';
  it('sandboxes: roles, create / get / list / delete, runtime labelled simulated', async () => {
    const p = await app()
      .get<ProjectsPort>(ProjectsPort)
      .create(A(), {
        type: 'webapp',
        name: 'CRM',
        dataRegion: 'sa-central',
        createdBy: e.ids.alice!,
      });
    projectId = p.id;
    const files = generateProject(CRM_SPEC).files;
    await app()
      .get<ProjectsPort>(ProjectsPort)
      .commit(A(), projectId, {
        baseVersionId: null,
        files: new Map([...files, ['package-lock.json', fakeLock()]]),
        source: 'ai',
        createdBy: e.ids.alice!,
      });
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
    expect(r.statusCode, r.body.slice(0, 200)).toBe(202);
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
  });
  it('test-runs: 202 queued; an undeclared suite is 422; exports: ready with a signed URL; a viewer is 403', async () => {
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
    const ex = await call('alice', 'POST', `/v1/builder/projects/${projectId}/exports`, {}, A());
    expect(ex.statusCode, ex.body.slice(0, 300)).toBe(202);
    expect(ex.json()).toMatchObject({ status: 'ready' });
    expect(
      (
        await call(
          'alice',
          'GET',
          `/v1/builder/projects/${projectId}/exports/${ex.json().id}`,
          undefined,
          A(),
        )
      ).json().downloadUrl,
    ).toMatch(/^https:\/\//);
    expect(
      (await call('carol', 'POST', `/v1/builder/projects/${projectId}/exports`, {}, A()))
        .statusCode,
    ).toBe(403);
  });
  it('approvals inbox: only the roles of the type decide; stale hash 409; identical repeat idempotent', async () => {
    const ap = await app()
      .get<ApprovalService>(ApprovalService)
      .request(A(), {
        subject: { type: 'project', id: projectId },
        type: 'production_deploy',
        action: { t: 1 },
        requestedBy: { kind: 'user', userId: e.ids.dave! },
        dataRegion: 'sa-central',
      });
    expect(
      (await call('carol', 'GET', '/v1/ai/approvals?status=pending', undefined, A()))
        .json()
        .items.some((x: Row) => x.id === ap.id),
    ).toBe(true);
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
    ).toBe(403);
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
    ).toBe(200);
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
  });
  it('CROSS-TENANT MATRIX: org B gets 404 for every org A resource on every endpoint implemented here (AC-M10-08)', async () => {
    const sid = (
      await call('dave', 'POST', `/v1/builder/projects/${projectId}/sandboxes`, {}, A())
    ).json().id;
    const tr = (
      await call('dave', 'GET', `/v1/builder/projects/${projectId}/test-runs`, undefined, A())
    ).json().items[0].id;
    const ex = (
      await call('alice', 'GET', `/v1/builder/projects/${projectId}/exports`, undefined, A())
    ).json().items[0].id;
    const ap = (await call('alice', 'GET', '/v1/ai/approvals', undefined, A())).json().items[0].id;
    const matrix: [string, string, object?][] = [
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
      ['GET', `/v1/ai/approvals/${ap}`],
      [
        'POST',
        `/v1/ai/approvals/${ap}/decisions`,
        { decision: 'approve', scopeHash: 'a'.repeat(64) },
      ],
    ];
    for (const [m, u, b] of matrix) {
      const r = await call('bob', m as never, u, b, B());
      expect(r.statusCode, `${m} ${u} -> ${r.statusCode} ${r.body.slice(0, 120)}`).toBe(404);
    }
    expect((await call('bob', 'GET', '/v1/ai/approvals', undefined, B())).json().items).toEqual([]);
  });
});
