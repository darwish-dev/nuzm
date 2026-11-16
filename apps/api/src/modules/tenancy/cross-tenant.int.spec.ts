import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OperationsService } from '@nuzm/platform';
import { NotificationService } from '../notifications';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';

/**
 * Cross-tenant suite GENERATED FROM spec/openapi/openapi.yaml (M01 S03 task 13).
 * For every org-scoped operation that takes an id, org B's owner (session AND API key) calls it with
 * org A's real ids and must get 404 (existence hiding), never 403/200. A new route without a fixture
 * fails the coverage test, so isolation cannot silently go untested.
 */
type Op = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  permission: string;
  params: string[];
  /** Global reference data (e.g. the plan catalogue): the same for every organization, so no 404 isolation applies. */
  global: boolean;
};
const spec = parse(
  readFileSync(join(__dirname, '../../../../../spec/openapi/openapi.yaml'), 'utf8'),
) as { paths: Record<string, Record<string, Record<string, unknown>>> };
const allOps: Op[] = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!['get', 'post', 'patch', 'delete'].includes(m)) continue;
    allOps.push({
      method: m.toUpperCase() as Op['method'],
      path,
      permission: (op['x-nuzm-permission'] as string) ?? '',
      global: op['x-nuzm-global-reference'] === true,
      params: [...path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!),
    });
  }
}
const orgScoped = allOps.filter((o) => o.permission);
const withIds = orgScoped.filter((o) => o.params.length > 0 && !o.global);

const h = new Harness();
let app: App;
const A: Record<string, string> = {};
let bobJar: Record<string, string>;
let bobKey = '';
let orgA = '';
let orgB = '';
let aliceId = '';

/** Which of org A's ids fills a path parameter. */
const fixtureFor = (o: Op, p: string): string | undefined => {
  if (p === 'orgId') return orgA;
  if (p === 'userId') return aliceId;
  if (p === 'envId') return A.env;
  const root = o.path.split('/')[2]!; // /v1/<root>/...
  return (
    {
      workspaces: A.workspace,
      projects: A.project,
      invitations: A.invitation,
      'api-keys': A.apiKey,
      operations: A.operation,
      notifications: A.notification,
    } as Record<string, string>
  )[root];
};
const urlFor = (o: Op) => o.path.replace(/\{(\w+)\}/g, (_m, p) => fixtureFor(o, p)!);
const bodyFor = (o: Op): unknown => {
  if (o.method === 'PATCH') {
    if (o.path.startsWith('/v1/notifications/')) return { read: true };
    return o.path.includes('/members/') ? { role: 'viewer' } : { name: 'hijack' };
  }
  if (o.method === 'POST')
    return o.path.endsWith('/environments') ? { name: 'x', kind: 'dev' } : undefined;
  return undefined;
};
const extraHeaders = (o: Op): Record<string, string> => ({
  ...(o.method === 'PATCH' ? { 'if-match': '"1"' } : {}),
  ...(o.method === 'POST' ? { 'idempotency-key': `ct-${Math.random()}` } : {}),
});

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp());
  aliceId = await h.createUser('alice');
  const bobId = await h.createUser('bob');
  const aliceJar = await h.sessionFor(app, aliceId);
  bobJar = await h.sessionFor(app, bobId);
  await h.elevate(aliceJar);
  await h.elevate(bobJar);
  const mk = async (jar: Record<string, string>, name: string) => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': jar.nuzm_csrf! },
      payload: { name },
    });
    expect(r.statusCode, `create org ${name}: ${r.body}`).toBe(201);
    return r.json().id as string;
  };
  orgA = await mk(aliceJar, 'Tenant Alpha');
  orgB = await mk(bobJar, 'Tenant Beta');
  const a = (method: 'POST' | 'GET', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(aliceJar),
        'x-csrf-token': aliceJar.nuzm_csrf!,
        'x-nuzm-org': orgA,
        'idempotency-key': `fx-${url}-${Math.random()}`,
      },
      ...(payload ? { payload } : {}),
    });
  A.workspace = (await a('POST', '/v1/workspaces', { name: 'A-ws' })).json().id;
  A.project = (
    await a('POST', '/v1/projects', { workspaceId: A.workspace, name: 'A-proj' })
  ).json().id;
  A.env = (
    await a('POST', `/v1/projects/${A.project}/environments`, { name: 'prod', kind: 'prod' })
  ).json().id;
  A.invitation = (
    await a('POST', '/v1/invitations', { email: 'someone@example.test', role: 'viewer' })
  ).json().id;
  A.apiKey = (
    await a('POST', '/v1/api-keys', { name: 'A-key', scopes: ['project:read'] })
  ).json().id;
  A.operation = (await app.get(OperationsService).create(orgA, { kind: 'ct.op' })).id;
  await app
    .get(NotificationService)
    .notify({ orgId: orgA, userId: aliceId, kind: 'test.fixture', params: {} });
  A.notification = (
    await h.env.sql(`SELECT id FROM platform.notifications WHERE user_id=$1`, [aliceId])
  )[0]!.id as string;
  // org B's API key carries EVERY org permission an owner has: the strongest key org B can hold
  const ownerPerms = (
    await h.env.sql(`SELECT permission FROM tenancy.role_permissions WHERE role='owner'`)
  ).map((r) => r.permission as string);
  const k = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: {
      cookie: cookieHeader(bobJar),
      'x-csrf-token': bobJar.nuzm_csrf!,
      'x-nuzm-org': orgB,
      'idempotency-key': 'bob-key',
    },
    payload: { name: 'B-key', scopes: ownerPerms },
  });
  bobKey = k.json().key;
});
afterAll(() => h.close());

describe('generated cross-tenant coverage', () => {
  it('discovers the org-scoped operations from the OpenAPI spec', () => {
    expect(orgScoped.length).toBeGreaterThan(20);
    expect(withIds.length).toBeGreaterThan(15);
  });

  it('has a fixture for every path parameter of every org-scoped operation (new routes must add one)', () => {
    const missing = withIds.flatMap((o) =>
      o.params.filter((p) => !fixtureFor(o, p)).map((p) => `${o.method} ${o.path} {${p}}`),
    );
    expect(missing).toEqual([]);
  });

  it('every operation declares an access rule: a permission, any-authenticated, or no security (public)', () => {
    const bad = allOps.filter((o) => {
      const op = spec.paths[o.path]![o.method.toLowerCase()]!;
      const sec = op.security as unknown[] | undefined;
      return (
        !op['x-nuzm-permission'] &&
        !op['x-nuzm-platform-permission'] &&
        op['x-nuzm-access'] !== 'any-authenticated' &&
        !(Array.isArray(sec) && sec.length === 0)
      );
    });
    // session-only identity routes (logout, sessions, MFA, /me) are declared with security but no permission: they are @AnyAuthenticated
    expect(bad.map((o) => `${o.method} ${o.path}`).every((s) => /\/v1\/(auth|me)/.test(s))).toBe(
      true,
    );
  });
});

describe('org B owner (session) vs org A ids → 404 on every id-bearing route', () => {
  it.each(withIds.map((o) => [`${o.method} ${o.path}`, o] as const))('%s', async (_n, o) => {
    const isOrgPath = o.params.includes('orgId');
    const r = await app.inject({
      method: o.method,
      url: urlFor(o),
      headers: {
        cookie: cookieHeader(bobJar),
        'x-csrf-token': bobJar.nuzm_csrf!,
        ...(isOrgPath ? {} : { 'x-nuzm-org': orgB }),
        ...extraHeaders(o),
      },
      ...(bodyFor(o) ? { payload: bodyFor(o) as object } : {}),
    });
    expect(r.statusCode, `${o.method} ${o.path} → ${r.body.slice(0, 120)}`).toBe(404);
  });
});

describe('org B API key (every owner permission) vs org A ids → 404', () => {
  it.each(
    withIds
      .filter((o) => !o.path.startsWith('/v1/api-keys') || o.method !== 'POST')
      .map((o) => [`${o.method} ${o.path}`, o] as const),
  )('%s', async (_n, o) => {
    const r = await app.inject({
      method: o.method,
      url: urlFor(o),
      headers: { authorization: `Bearer ${bobKey}`, ...extraHeaders(o) },
      ...(bodyFor(o) ? { payload: bodyFor(o) as object } : {}),
    });
    // a route that needs step-up is session-only in practice; for keys the id lookup still must not confirm existence
    expect([404, 401], `${o.method} ${o.path} → ${r.statusCode} ${r.body.slice(0, 100)}`).toContain(
      r.statusCode,
    );
    expect(r.statusCode).not.toBe(200);
    expect(r.statusCode).not.toBe(403);
  });
});

describe('admin-console routes are unreachable with tenant credentials', () => {
  const adminOps = allOps.filter((o) =>
    Boolean(spec.paths[o.path]![o.method.toLowerCase()]!['x-nuzm-platform-permission']),
  );
  it('discovers the admin operations from the spec', () =>
    expect(adminOps.length).toBeGreaterThan(5));
  it.each(adminOps.map((o) => [`${o.method} ${o.path}`, o] as const))(
    '%s refuses an org owner session and an API key',
    async (_n, o) => {
      const url = o.path.replace(/\{(\w+)\}/g, aliceId);
      const viaSession = await app.inject({
        method: o.method,
        url,
        headers: {
          cookie: cookieHeader(bobJar),
          'x-csrf-token': bobJar.nuzm_csrf!,
          'x-nuzm-org': orgB,
        },
        ...(o.method === 'GET' ? {} : { payload: {} }),
      });
      const viaKey = await app.inject({
        method: o.method,
        url,
        headers: { authorization: `Bearer ${bobKey}` },
        ...(o.method === 'GET' ? {} : { payload: {} }),
      });
      expect(viaSession.statusCode, viaSession.body).toBe(401); // no admin-realm session cookie
      expect(viaKey.statusCode, viaKey.body).toBe(401);
    },
  );
});

describe("list routes never leak the other org's rows", () => {
  const lists = orgScoped.filter((o) => o.method === 'GET' && o.params.length === 0);
  it.each(lists.map((o) => [o.path, o] as const))('GET %s', async (_p, o) => {
    const viaSession = await app.inject({
      method: 'GET',
      url: o.path,
      headers: { cookie: cookieHeader(bobJar), 'x-nuzm-org': orgB },
    });
    const viaKey = await app.inject({
      method: 'GET',
      url: o.path,
      headers: { authorization: `Bearer ${bobKey}` },
    });
    for (const r of [viaSession, viaKey]) {
      for (const [name, id] of Object.entries(A))
        expect(r.body, `${o.path} leaked org A ${name}`).not.toContain(id);
      expect(r.body).not.toContain('A-ws');
      expect(r.body).not.toContain('A-proj');
    }
  });
});

describe("after all the hostile calls, org A's data is untouched", () => {
  it('fixtures still exist at their original versions (nothing was changed, deleted or revoked)', async () => {
    const rows = await h.env.sql(
      `SELECT 'workspace' k, version::int v, deleted_at FROM tenancy.workspaces WHERE id=$1
      UNION ALL SELECT 'project', version::int, deleted_at FROM tenancy.projects WHERE id=$2
      UNION ALL SELECT 'env', version::int, deleted_at FROM tenancy.environments WHERE id=$3`,
      [A.workspace, A.project, A.env],
    );
    for (const r of rows) {
      expect(r.v, String(r.k)).toBe(1);
      expect(r.deleted_at, String(r.k)).toBeNull();
    }
    expect(
      (await h.env.sql(`SELECT revoked_at FROM identity.api_keys WHERE id=$1`, [A.apiKey]))[0]!
        .revoked_at,
    ).toBeNull();
    expect(
      (
        await h.env.sql(`SELECT revoked_at, accepted_at FROM tenancy.invitations WHERE id=$1`, [
          A.invitation,
        ])
      )[0],
    ).toEqual({ revoked_at: null, accepted_at: null });
    expect(
      (
        await h.env.sql(`SELECT state, cancel_requested FROM platform.operations WHERE id=$1`, [
          A.operation,
        ])
      )[0],
    ).toEqual({ state: 'pending', cancel_requested: false });
    expect(
      (
        await h.env.sql(`SELECT count(*)::int n FROM tenancy.memberships WHERE org_id=$1`, [orgA])
      )[0]!.n,
    ).toBe(1);
  });

  it("positive control: the same ids resolve for org A's own owner, so the 404s above were isolation, not bad fixtures", async () => {
    const alice = await h.sessionFor(app, aliceId);
    for (const o of withIds.filter((x) => x.method === 'GET' && !x.path.includes('{userId}'))) {
      const r = await app.inject({
        method: 'GET',
        url: urlFor(o),
        headers: { cookie: cookieHeader(alice), 'x-nuzm-org': orgA },
      });
      expect(r.statusCode, `${o.path} → ${r.body.slice(0, 100)}`).toBe(200);
    }
  });
});
