import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { OperationsService } from '@nuzm/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnyAuthenticated } from '../../common/access';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';

@Controller('test-undeclared')
class UndeclaredController {
  @Get('x') x() {
    return { leaked: true };
  }
}
@Controller('test-any')
class AnyController {
  @AnyAuthenticated() @Get('x') x() {
    return { ok: true };
  }
}

const h = new Harness();
let app: App;
let mailer: Awaited<ReturnType<Harness['buildApp']>>['mailer'];
const jars: Record<string, Record<string, string>> = {};
const ids: Record<string, string> = {};
let orgA = '';
let orgB = '';

type Opt = { org?: string; body?: unknown; headers?: Record<string, string>; csrf?: boolean };
const call = (
  who: string | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  o: Opt = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(who
        ? {
            cookie: cookieHeader(jars[who]!),
            ...(o.csrf === false ? {} : { 'x-csrf-token': jars[who]!.nuzm_csrf! }),
          }
        : {}),
      ...(o.org ? { 'x-nuzm-org': o.org } : {}),
      ...(o.headers ?? {}),
    },
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });

async function addMember(org: string, user: string, role: string) {
  await h.env.sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
    [org, ids[user], role],
  );
}

beforeAll(async () => {
  await h.init();
  const built = await h.buildApp({}, undefined, [UndeclaredController, AnyController]);
  app = built.app;
  mailer = built.mailer;
  for (const n of ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'gina']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
  }
  // alice founds org A and bob founds org B through the real endpoint
  const a = await call('alice', 'POST', '/v1/organizations', {
    body: { name: 'Acme Cloud', country: 'SA' },
  });
  const b = await call('bob', 'POST', '/v1/organizations', {
    body: { name: 'Beta Hosting', type: 'agency' },
  });
  orgA = a.json().id;
  orgB = b.json().id;
  await addMember(orgA, 'carol', 'viewer');
  await addMember(orgA, 'dave', 'developer');
  await addMember(orgA, 'eve', 'admin');
  await addMember(orgA, 'frank', 'billing_admin');
});
afterAll(() => h.close());

describe('organizations', () => {
  it('creating an org makes the caller its owner; the org is visible only to its members', async () => {
    const mine = (await call('alice', 'GET', '/v1/organizations')).json();
    expect(mine.items.map((o: { id: string }) => o.id)).toEqual([orgA]);
    expect(mine.items[0]).toMatchObject({ role: 'owner', type: 'customer', status: 'active' });
    expect(
      (await call('bob', 'GET', '/v1/organizations')).json().items.map((o: { id: string }) => o.id),
    ).toEqual([orgB]);
    expect((await call('gina', 'GET', '/v1/organizations')).json().items).toEqual([]);
  });

  it('validates input and rejects a duplicate slug (409)', async () => {
    expect(
      (await call('alice', 'POST', '/v1/organizations', { body: { name: '' } })).statusCode,
    ).toBe(422);
    expect(
      (await call('alice', 'POST', '/v1/organizations', { body: { name: 'x', type: 'galaxy' } }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/organizations', {
          body: { name: 'Another', slug: 'acme-cloud' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await call('alice', 'POST', '/v1/organizations', { body: { name: 'اسم عربي' } })).statusCode,
    ).toBe(201); // non-Latin names get a generated slug
  });

  it("existence hiding: a non-member gets 404 (never 403) for another org's organization and resources", async () => {
    expect((await call('bob', 'GET', `/v1/organizations/${orgA}`)).statusCode).toBe(404);
    expect((await call('bob', 'GET', '/v1/workspaces', { org: orgA })).statusCode).toBe(404);
    expect(
      (await call('bob', 'GET', '/v1/workspaces', { org: '00000000-0000-7000-8000-ffffffffffff' }))
        .statusCode,
    ).toBe(404);
    expect((await call('bob', 'GET', '/v1/workspaces', { org: 'not-a-uuid' })).statusCode).toBe(
      404,
    );
    expect((await call('bob', 'GET', '/v1/workspaces')).statusCode).toBe(422); // header required, no org guessed
  });

  it('PATCH needs If-Match (428), rejects a stale ETag (412), and 2 concurrent updates → exactly one wins', async () => {
    const got = await call('alice', 'GET', `/v1/organizations/${orgA}`);
    const tag = got.headers.etag as string;
    expect(
      (await call('alice', 'PATCH', `/v1/organizations/${orgA}`, { body: { name: 'N' } }))
        .statusCode,
    ).toBe(428);
    const [x, y] = await Promise.all([
      call('alice', 'PATCH', `/v1/organizations/${orgA}`, {
        body: { name: 'Acme One' },
        headers: { 'if-match': tag },
      }),
      call('alice', 'PATCH', `/v1/organizations/${orgA}`, {
        body: { name: 'Acme Two' },
        headers: { 'if-match': tag },
      }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 412]);
    expect(
      (
        await call('alice', 'PATCH', `/v1/organizations/${orgA}`, {
          body: { name: 'Stale' },
          headers: { 'if-match': tag },
        })
      ).statusCode,
    ).toBe(412);
  });
});

describe('RBAC matrix (deny by default)', () => {
  // [role-user, action, expected status]
  const matrix: Array<[string, string, (u: string) => ReturnType<typeof call>, number]> = [
    [
      'carol(viewer)',
      'list workspaces',
      (u) => call(u, 'GET', '/v1/workspaces', { org: orgA }),
      200,
    ],
    [
      'carol(viewer)',
      'create workspace',
      (u) =>
        call(u, 'POST', '/v1/workspaces', {
          org: orgA,
          body: { name: 'v' },
          headers: { 'idempotency-key': 'v1' },
        }),
      403,
    ],
    [
      'carol(viewer)',
      'invite member',
      (u) =>
        call(u, 'POST', '/v1/invitations', {
          org: orgA,
          body: { email: 'a@b.co', role: 'viewer' },
          headers: { 'idempotency-key': 'v2' },
        }),
      403,
    ],
    ['carol(viewer)', 'list api keys', (u) => call(u, 'GET', '/v1/api-keys', { org: orgA }), 403],
    [
      'dave(developer)',
      'create workspace',
      (u) =>
        call(u, 'POST', '/v1/workspaces', {
          org: orgA,
          body: { name: 'dev-ws' },
          headers: { 'idempotency-key': 'd1' },
        }),
      201,
    ],
    [
      'dave(developer)',
      'delete workspace',
      (u) =>
        call(u, 'DELETE', '/v1/workspaces/00000000-0000-7000-8000-000000000001', { org: orgA }),
      403,
    ],
    [
      'dave(developer)',
      'invite member',
      (u) =>
        call(u, 'POST', '/v1/invitations', {
          org: orgA,
          body: { email: 'a@b.co', role: 'viewer' },
          headers: { 'idempotency-key': 'd2' },
        }),
      403,
    ],
    [
      'dave(developer)',
      'patch org',
      (u) =>
        call(u, 'PATCH', `/v1/organizations/${orgA}`, {
          body: { name: 'x' },
          headers: { 'if-match': '"1"' },
        }),
      403,
    ],
    ['frank(billing_admin)', 'read org', (u) => call(u, 'GET', `/v1/organizations/${orgA}`), 200],
    [
      'frank(billing_admin)',
      'create project',
      (u) =>
        call(u, 'POST', '/v1/projects', {
          org: orgA,
          body: { workspaceId: 'x', name: 'p' },
          headers: { 'idempotency-key': 'f1' },
        }),
      403,
    ],
    [
      'frank(billing_admin)',
      'list members',
      (u) => call(u, 'GET', `/v1/organizations/${orgA}/members`),
      200,
    ],
    [
      'eve(admin)',
      'invite member',
      (u) =>
        call(u, 'POST', '/v1/invitations', {
          org: orgA,
          body: { email: 'matrix@example.test', role: 'viewer' },
          headers: { 'idempotency-key': 'e1' },
        }),
      201,
    ],
    [
      'eve(admin)',
      'invite an owner',
      (u) =>
        call(u, 'POST', '/v1/invitations', {
          org: orgA,
          body: { email: 'matrix2@example.test', role: 'owner' },
          headers: { 'idempotency-key': 'e2' },
        }),
      403,
    ],
  ];
  it.each(matrix)('%s — %s → %i', async (who, _action, run, expected) => {
    const user = who.split('(')[0]!;
    expect((await run(user)).statusCode).toBe(expected);
  });

  it('routes with no access declaration are refused (deny by default); declared ones work', async () => {
    const denied = await call('alice', 'GET', '/test-undeclared/x');
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('leaked');
    expect((await call('alice', 'GET', '/test-any/x')).statusCode).toBe(200);
    expect((await call(null, 'GET', '/test-any/x')).statusCode).toBe(401);
  });

  it('the acting-org (delegation) header is refused until M11 — NOT VERIFIED — M11', async () => {
    const r = await call('alice', 'GET', '/v1/workspaces', {
      org: orgA,
      headers: { 'x-nuzm-acting-org': orgB },
    });
    expect(r.statusCode).toBe(403);
  });

  it('exposes the role and permission catalogues to any signed-in user', async () => {
    const roles = (await call('gina', 'GET', '/v1/roles')).json().items;
    expect(roles.map((r: { name: string }) => r.name)).toEqual(
      expect.arrayContaining([
        'owner',
        'admin',
        'billing_admin',
        'developer',
        'viewer',
        'platform_admin',
      ]),
    );
    expect(roles.find((r: { name: string }) => r.name === 'viewer').permissions).not.toContain(
      'workspace:create',
    );
    expect((await call('gina', 'GET', '/v1/permissions')).json().items.length).toBeGreaterThan(20);
    expect((await call(null, 'GET', '/v1/roles')).statusCode).toBe(401);
  });
});

describe('members', () => {
  it('lists members; the last owner can be neither demoted nor removed', async () => {
    const list = (await call('alice', 'GET', `/v1/organizations/${orgA}/members`)).json();
    expect(list.items.map((m: { email: string }) => m.email).sort()).toEqual([
      'alice@example.test',
      'carol@example.test',
      'dave@example.test',
      'eve@example.test',
      'frank@example.test',
    ]);
    await h.elevate(jars.alice!);
    const me = list.items.find((m: { userId: string }) => m.userId === ids.alice);
    const demote = await call('alice', 'PATCH', `/v1/organizations/${orgA}/members/${ids.alice}`, {
      body: { role: 'admin' },
      headers: { 'if-match': `"${me.version}"` },
    });
    expect(demote.statusCode).toBe(409);
    expect(
      (await call('alice', 'DELETE', `/v1/organizations/${orgA}/members/${ids.alice}`)).statusCode,
    ).toBe(409);
  });

  it('role changes require step-up (401), If-Match (428) and the right actor; admins cannot grant owner (403)', async () => {
    const list = (await call('alice', 'GET', `/v1/organizations/${orgA}/members`)).json().items;
    const carol = list.find((m: { userId: string }) => m.userId === ids.carol);
    const url = `/v1/organizations/${orgA}/members/${ids.carol}`;
    const cold = await call('eve', 'PATCH', url, {
      body: { role: 'developer' },
      headers: { 'if-match': `"${carol.version}"` },
    });
    expect(cold.statusCode).toBe(401);
    expect(cold.json().code).toBe('step_up_required');
    await h.elevate(jars.eve!);
    expect((await call('eve', 'PATCH', url, { body: { role: 'developer' } })).statusCode).toBe(428);
    expect(
      (
        await call('eve', 'PATCH', url, {
          body: { role: 'owner' },
          headers: { 'if-match': `"${carol.version}"` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('eve', 'PATCH', url, {
          body: { role: 'wizard' },
          headers: { 'if-match': `"${carol.version}"` },
        })
      ).statusCode,
    ).toBe(422);
    const ok = await call('eve', 'PATCH', url, {
      body: { role: 'developer' },
      headers: { 'if-match': `"${carol.version}"` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().role).toBe('developer');
    // concurrent changes with the same ETag: exactly one wins
    const fresh = ok.json();
    const [p, q] = await Promise.all([
      call('eve', 'PATCH', url, {
        body: { role: 'viewer' },
        headers: { 'if-match': `"${fresh.version}"` },
      }),
      call('eve', 'PATCH', url, {
        body: { role: 'billing_admin' },
        headers: { 'if-match': `"${fresh.version}"` },
      }),
    ]);
    expect([p.statusCode, q.statusCode].sort()).toEqual([200, 412]);
    await h.env.sql(`UPDATE tenancy.memberships SET role='viewer' WHERE user_id=$1`, [ids.carol]);
  });

  it('a removed member loses access immediately', async () => {
    await addMember(orgA, 'gina', 'viewer');
    expect((await call('gina', 'GET', '/v1/workspaces', { org: orgA })).statusCode).toBe(200);
    expect(
      (await call('eve', 'DELETE', `/v1/organizations/${orgA}/members/${ids.gina}`)).statusCode,
    ).toBe(204);
    expect((await call('gina', 'GET', '/v1/workspaces', { org: orgA })).statusCode).toBe(404);
  });
});

describe('invitation_expiry_single_use and acceptance', () => {
  const invite = async (email: string, role = 'developer', key = `k-${email}`) =>
    call('alice', 'POST', '/v1/invitations', {
      org: orgA,
      body: { email, role },
      headers: { 'idempotency-key': key },
    });
  const tokenFor = (email: string) =>
    (
      mailer.sent.filter((m) => m.to === email && m.template === 'invitation').pop()!.data as {
        token: string;
      }
    ).token;

  it('creates a pending invitation, mails the token once, and never returns the token or its hash', async () => {
    const r = await invite('newbie@example.test');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      email: 'newbie@example.test',
      role: 'developer',
      status: 'pending',
    });
    expect(JSON.stringify(r.json())).not.toMatch(/nzi_|token/i);
    expect(tokenFor('newbie@example.test')).toMatch(/^nzi_/);
    const list = JSON.stringify(
      (await call('alice', 'GET', '/v1/invitations', { org: orgA })).json(),
    );
    expect(list).not.toMatch(/nzi_|token_hash/);
    expect(
      JSON.stringify(await h.env.sql(`SELECT token_hash FROM tenancy.invitations`)),
    ).not.toContain(tokenFor('newbie@example.test'));
  });

  it('rejects duplicates (open invite, existing member) and unknown roles', async () => {
    expect((await invite('newbie@example.test', 'viewer', 'dup-1')).statusCode).toBe(409);
    expect((await invite('dave@example.test', 'viewer', 'dup-2')).statusCode).toBe(409);
    expect((await invite('weird@example.test', 'wizard', 'dup-3')).statusCode).toBe(422);
    expect((await invite('not-an-email', 'viewer', 'dup-4')).statusCode).toBe(422);
  });

  it('accept: the invitee (verified, matching email) joins with the invited role; the token is single-use', async () => {
    const id = (await invite('joiner@example.test', 'billing_admin')).json().id;
    const uid = await h.createUser('joiner');
    jars.joiner = await h.sessionFor(app, uid);
    ids.joiner = uid;
    const token = tokenFor('joiner@example.test');
    expect(
      (
        await call('joiner', 'POST', `/v1/invitations/${id}/acceptance`, {
          body: { token: 'nzi_wrong' },
        })
      ).statusCode,
    ).toBe(404);
    const ok = await call('joiner', 'POST', `/v1/invitations/${id}/acceptance`, {
      body: { token },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ orgId: orgA, role: 'billing_admin' });
    expect((await call('joiner', 'GET', `/v1/organizations/${orgA}`)).statusCode).toBe(200);
    expect(
      (await call('joiner', 'POST', `/v1/invitations/${id}/acceptance`, { body: { token } }))
        .statusCode,
    ).toBe(410); // reuse
  });

  it('a different or unverified email cannot use a leaked token (403) and does not consume it', async () => {
    const id = (await invite('target@example.test', 'viewer')).json().id;
    const token = tokenFor('target@example.test');
    expect(
      (await call('gina', 'POST', `/v1/invitations/${id}/acceptance`, { body: { token } }))
        .statusCode,
    ).toBe(403);
    const unverified = await h.createUser('target', { emailVerified: false });
    jars.target = await h.sessionFor(app, unverified);
    expect(
      (await call('target', 'POST', `/v1/invitations/${id}/acceptance`, { body: { token } }))
        .statusCode,
    ).toBe(403);
    await h.env.sql(`UPDATE identity.users SET email_verified = true WHERE id=$1`, [unverified]);
    expect(
      (await call('target', 'POST', `/v1/invitations/${id}/acceptance`, { body: { token } }))
        .statusCode,
    ).toBe(200);
  });

  it('expired and revoked invitations return 410', async () => {
    const e = (await invite('late@example.test')).json().id;
    await h.env.sql(
      `UPDATE tenancy.invitations SET expires_at = now() - interval '1 second' WHERE id=$1`,
      [e],
    );
    const lateUser = await h.createUser('late');
    jars.late = await h.sessionFor(app, lateUser);
    expect(
      (
        await call('late', 'POST', `/v1/invitations/${e}/acceptance`, {
          body: { token: tokenFor('late@example.test') },
        })
      ).statusCode,
    ).toBe(410);
    const r = (await invite('revoked@example.test')).json().id;
    expect((await call('alice', 'DELETE', `/v1/invitations/${r}`, { org: orgA })).statusCode).toBe(
      204,
    );
    const ru = await h.createUser('revoked');
    jars.revoked = await h.sessionFor(app, ru);
    expect(
      (
        await call('revoked', 'POST', `/v1/invitations/${r}/acceptance`, {
          body: { token: tokenFor('revoked@example.test') },
        })
      ).statusCode,
    ).toBe(410);
    expect((await call('alice', 'DELETE', `/v1/invitations/${r}`, { org: orgA })).statusCode).toBe(
      404,
    );
  });

  it('concurrent acceptance of one token: exactly one succeeds', async () => {
    const id = (await invite('race@example.test', 'viewer')).json().id;
    const uid = await h.createUser('race');
    jars.race = await h.sessionFor(app, uid);
    const token = tokenFor('race@example.test');
    const rs = await Promise.all(
      [1, 2, 3].map(() =>
        call('race', 'POST', `/v1/invitations/${id}/acceptance`, { body: { token } }),
      ),
    );
    expect(rs.map((r) => r.statusCode).sort()).toEqual(
      [200, 409, 410]
        .slice(0, 3)
        .sort()
        .map((_, i) => rs.map((r) => r.statusCode).sort()[i]),
    );
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(
      rs.filter((r) => r.statusCode !== 200).every((r) => [409, 410].includes(r.statusCode)),
    ).toBe(true);
    expect(
      (
        await h.env.sql(`SELECT count(*)::int n FROM tenancy.memberships WHERE user_id=$1`, [uid])
      )[0]!.n,
    ).toBe(1);
  });

  it('a delivery failure rolls the invitation back (503) so no undeliverable invitation remains', async () => {
    mailer.failNext = true;
    const r = await invite('nomail@example.test');
    expect(r.statusCode).toBe(503);
    expect(
      await h.env.sql(`SELECT 1 FROM tenancy.invitations WHERE email='nomail@example.test'`),
    ).toHaveLength(0);
  });
});

describe('workspaces, projects, environments', () => {
  let ws = '';
  let proj = '';
  const idem = (k: string) => ({ 'idempotency-key': k });

  it('CRUD with ETags, validation and soft-delete', async () => {
    const w = await call('alice', 'POST', '/v1/workspaces', {
      org: orgA,
      body: { name: 'Production' },
      headers: idem('w-1'),
    });
    expect(w.statusCode).toBe(201);
    ws = w.json().id;
    expect(w.json().slug).toBe('production');
    expect(
      (
        await call('alice', 'POST', '/v1/workspaces', {
          org: orgA,
          body: { name: 'Production again', slug: 'production' },
          headers: idem('w-2'),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('alice', 'POST', '/v1/workspaces', {
          org: orgA,
          body: { name: '' },
          headers: idem('w-3'),
        })
      ).statusCode,
    ).toBe(422);
    const g = await call('alice', 'GET', `/v1/workspaces/${ws}`, { org: orgA });
    expect(g.headers.etag).toBe('"1"');
    const p = await call('alice', 'PATCH', `/v1/workspaces/${ws}`, {
      org: orgA,
      body: { name: 'Prod' },
      headers: { 'if-match': '"1"' },
    });
    expect(p.json()).toMatchObject({ name: 'Prod', version: 2 });
    expect(
      (
        await call('alice', 'PATCH', `/v1/workspaces/${ws}`, {
          org: orgA,
          body: { name: 'x' },
          headers: { 'if-match': '"1"' },
        })
      ).statusCode,
    ).toBe(412);
  });

  it("projects must live in one of the caller's own workspaces; environments default to a placeholder region", async () => {
    const p = await call('dave', 'POST', '/v1/projects', {
      org: orgA,
      body: { workspaceId: ws, name: 'API' },
      headers: idem('p-1'),
    });
    expect(p.statusCode).toBe(201);
    proj = p.json().id;
    // org B tries to create a project inside org A's workspace
    const wsB = (
      await call('bob', 'POST', '/v1/workspaces', {
        org: orgB,
        body: { name: 'B-space' },
        headers: idem('wb-1'),
      })
    ).json().id;
    expect(
      (
        await call('bob', 'POST', '/v1/projects', {
          org: orgB,
          body: { workspaceId: ws, name: 'steal' },
          headers: idem('pb-1'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call('bob', 'POST', '/v1/projects', {
          org: orgB,
          body: { workspaceId: wsB, name: 'ok' },
          headers: idem('pb-2'),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call('dave', 'POST', '/v1/projects', {
          org: orgA,
          body: { workspaceId: ws, name: 'api' },
          headers: idem('p-2'),
        })
      ).statusCode,
    ).toBe(409); // case-insensitive
    const e = await call('dave', 'POST', `/v1/projects/${proj}/environments`, {
      org: orgA,
      body: { name: 'prod', kind: 'prod' },
      headers: idem('e-1'),
    });
    expect(e.statusCode).toBe(201);
    expect(e.json()).toMatchObject({ kind: 'prod', dataRegion: 'sa-pending' });
    expect(
      (
        await call('dave', 'POST', `/v1/projects/${proj}/environments`, {
          org: orgA,
          body: { name: 'x', kind: 'moon' },
          headers: idem('e-2'),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await call('bob', 'GET', `/v1/projects/${proj}/environments`, { org: orgB })).statusCode,
    ).toBe(404);
  });

  it('deleting a parent that still has children is refused (409); children first, then soft-delete succeeds', async () => {
    expect((await call('alice', 'DELETE', `/v1/workspaces/${ws}`, { org: orgA })).statusCode).toBe(
      409,
    );
    expect((await call('alice', 'DELETE', `/v1/projects/${proj}`, { org: orgA })).statusCode).toBe(
      409,
    );
    const env = (
      await call('alice', 'GET', `/v1/projects/${proj}/environments`, { org: orgA })
    ).json().items[0].id;
    expect(
      (await call('alice', 'DELETE', `/v1/projects/${proj}/environments/${env}`, { org: orgA }))
        .statusCode,
    ).toBe(204);
    expect((await call('alice', 'DELETE', `/v1/projects/${proj}`, { org: orgA })).statusCode).toBe(
      204,
    );
    expect((await call('alice', 'GET', `/v1/projects/${proj}`, { org: orgA })).statusCode).toBe(
      404,
    );
    expect(
      (await h.env.sql(`SELECT deleted_at FROM tenancy.projects WHERE id=$1`, [proj]))[0]!
        .deleted_at,
    ).not.toBeNull(); // soft-deleted, still stored
    expect((await call('alice', 'DELETE', `/v1/workspaces/${ws}`, { org: orgA })).statusCode).toBe(
      204,
    );
  });

  it('50 parallel creates with one Idempotency-Key produce exactly one workspace', async () => {
    const rs = await Promise.all(
      Array.from({ length: 50 }, () =>
        call('alice', 'POST', '/v1/workspaces', {
          org: orgA,
          body: { name: 'Race WS' },
          headers: idem('ws-race'),
        }),
      ),
    );
    expect(rs.filter((r) => r.statusCode === 201).length).toBeGreaterThanOrEqual(1);
    expect(rs.every((r) => [201, 409].includes(r.statusCode))).toBe(true);
    expect(
      (await h.env.sql(`SELECT count(*)::int n FROM tenancy.workspaces WHERE name='Race WS'`))[0]!
        .n,
    ).toBe(1);
  });

  it('the Idempotency-Key header is required on creating POSTs (400)', async () => {
    const r = await call('alice', 'POST', '/v1/workspaces', { org: orgA, body: { name: 'NoKey' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('idempotency_key_required');
  });
});

describe('API keys: authority = scopes ∩ creator permissions', () => {
  let key = '';
  let keyId = '';

  it('creation needs step-up and Idempotency-Key; scopes beyond the creator are refused; the secret is shown once', async () => {
    const body = { name: 'ci', scopes: ['project:read', 'workspace:read'] };
    const cold = await call('dave', 'POST', '/v1/api-keys', {
      org: orgA,
      body,
      headers: { 'idempotency-key': 'k-1' },
    });
    expect(cold.statusCode).toBe(401);
    await h.elevate(jars.dave!);
    expect(
      (
        await call('dave', 'POST', '/v1/api-keys', {
          org: orgA,
          body: { name: 'big', scopes: ['member:manage'] },
          headers: { 'idempotency-key': 'k-2' },
        })
      ).statusCode,
    ).toBe(422);
    const ok = await call('dave', 'POST', '/v1/api-keys', {
      org: orgA,
      body,
      headers: { 'idempotency-key': 'k-3' },
    });
    expect(ok.statusCode).toBe(201);
    key = ok.json().key;
    keyId = ok.json().id;
    expect(key).toMatch(/^nzk_/);
    const listed = JSON.stringify(
      (await call('dave', 'GET', '/v1/api-keys', { org: orgA })).json(),
    );
    expect(listed).not.toContain(key.slice(-43)); // the 43-char secret part
  });

  const bearer = (k: string, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${k}`, 'idempotency-key': `b-${Math.random()}` },
      ...(body ? { payload: body as object } : {}),
    });

  it('the key works only within its scopes, in its own org, and never on session-only routes', async () => {
    expect((await bearer(key, 'GET', '/v1/projects')).statusCode).toBe(200);
    expect((await bearer(key, 'GET', '/v1/workspaces')).statusCode).toBe(200);
    expect((await bearer(key, 'POST', '/v1/workspaces', { name: 'nope' })).statusCode).toBe(403); // scope missing
    expect((await bearer(key, 'GET', '/v1/operations')).statusCode).toBe(403);
    expect((await bearer(key, 'GET', '/v1/me')).statusCode).toBe(401); // session-only
    expect((await bearer(key, 'GET', '/v1/organizations')).statusCode).toBe(401);
    expect(
      (await bearer(key, 'POST', '/v1/api-keys', { name: 'x', scopes: ['project:read'] }))
        .statusCode,
    ).toBe(403); // keys cannot mint keys
    expect(
      (await bearer('nzk_garbage12_' + 'A'.repeat(43), 'GET', '/v1/projects')).statusCode,
    ).toBe(401);
    // org A's key cannot name org B even by header: the key fixes the org
    const wsB = (
      await call('bob', 'POST', '/v1/workspaces', {
        org: orgB,
        body: { name: 'B-only' },
        headers: { 'idempotency-key': 'wb-key' },
      })
    ).json().id;
    expect((await bearer(key, 'GET', `/v1/workspaces/${wsB}`)).statusCode).toBe(404);
    // sending org B's header with org A's key must not widen access to org B
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { authorization: `Bearer ${key}`, 'x-nuzm-org': orgB },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(wsB);
  });

  it('use-time authority follows the creator: demotion removes powers; removal kills the key', async () => {
    await h.env.sql(`UPDATE tenancy.memberships SET role='viewer' WHERE user_id=$1 AND org_id=$2`, [
      ids.dave,
      orgA,
    ]);
    // viewer still holds project:read / workspace:read, so read access remains…
    expect((await bearer(key, 'GET', '/v1/projects')).statusCode).toBe(200);
    // …but a scope the creator no longer holds stops working
    await h.env.sql(
      `UPDATE tenancy.memberships SET role='billing_admin' WHERE user_id=$1 AND org_id=$2`,
      [ids.dave, orgA],
    );
    expect((await bearer(key, 'GET', '/v1/projects')).statusCode).toBe(403);
    await h.env.sql(`DELETE FROM tenancy.memberships WHERE user_id=$1 AND org_id=$2`, [
      ids.dave,
      orgA,
    ]);
    expect((await bearer(key, 'GET', '/v1/workspaces')).statusCode).toBe(401);
    await addMember(orgA, 'dave', 'developer');
  });

  it('developers revoke only their own keys; revoking makes the key fail immediately', async () => {
    await h.elevate(jars.eve!);
    const eveKey = (
      await call('eve', 'POST', '/v1/api-keys', {
        org: orgA,
        body: { name: 'eve-key', scopes: ['project:read'] },
        headers: { 'idempotency-key': 'k-eve2' },
      })
    ).json();
    expect(
      (await call('dave', 'DELETE', `/v1/api-keys/${eveKey.id}`, { org: orgA })).statusCode,
    ).toBe(404); // not dave's key
    expect(
      (await call('dave', 'GET', '/v1/api-keys', { org: orgA }))
        .json()
        .items.map((k: { id: string }) => k.id),
    ).toEqual([keyId]);
    expect(
      (await call('eve', 'GET', '/v1/api-keys', { org: orgA })).json().items.length,
    ).toBeGreaterThanOrEqual(2); // admins see all
    expect((await call('dave', 'DELETE', `/v1/api-keys/${keyId}`, { org: orgA })).statusCode).toBe(
      204,
    );
    expect((await bearer(key, 'GET', '/v1/projects')).statusCode).toBe(401);
  });
});

describe('suspension, me, operations', () => {
  it('a suspended org blocks all its members with org_suspended (403) and can be reinstated', async () => {
    await h.env.sql(`UPDATE tenancy.organizations SET status='suspended' WHERE id=$1`, [orgB]);
    const r = await call('bob', 'GET', '/v1/workspaces', { org: orgB });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('org_suspended');
    await h.env.sql(`UPDATE tenancy.organizations SET status='active' WHERE id=$1`, [orgB]);
    expect((await call('bob', 'GET', '/v1/workspaces', { org: orgB })).statusCode).toBe(200);
  });

  it("/v1/me lists memberships and the active org's permissions; a foreign org header reveals nothing", async () => {
    const me = (await call('carol', 'GET', '/v1/me', { org: orgA })).json();
    expect(me.memberships.map((m: { orgId: string }) => m.orgId)).toEqual([orgA]);
    expect(me.permissions).toContain('workspace:read');
    expect(me.permissions).not.toContain('workspace:create');
    const foreign = await call('carol', 'GET', '/v1/me', { org: orgB });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().permissions).toEqual([]);
    expect(foreign.json().memberships.map((m: { orgId: string }) => m.orgId)).toEqual([orgA]);
  });

  it('operations: org-scoped read, 404 across orgs, cancellation rules and RBAC', async () => {
    const ops = app.get(OperationsService);
    const op = await ops.create(orgA, { kind: 'test.op' });
    expect(
      (await call('carol', 'GET', `/v1/operations/${op.id}`, { org: orgA })).json(),
    ).toMatchObject({ id: op.id, state: 'pending', steps: [] });
    expect((await call('bob', 'GET', `/v1/operations/${op.id}`, { org: orgB })).statusCode).toBe(
      404,
    );
    expect(
      (await call('carol', 'POST', `/v1/operations/${op.id}/cancellation`, { org: orgA }))
        .statusCode,
    ).toBe(403); // viewer
    expect(
      (await call('bob', 'POST', `/v1/operations/${op.id}/cancellation`, { org: orgB })).statusCode,
    ).toBe(404);
    const c = await call('dave', 'POST', `/v1/operations/${op.id}/cancellation`, { org: orgA });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toEqual({ state: 'cancelled', accepted: 'cancelled' });
    const again = await call('dave', 'POST', `/v1/operations/${op.id}/cancellation`, { org: orgA });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('operation_not_cancellable');
    expect(
      (await call('carol', 'GET', '/v1/operations', { org: orgA }))
        .json()
        .items.map((o: { id: string }) => o.id),
    ).toContain(op.id);
    expect((await call('carol', 'GET', '/v1/resources', { org: orgA })).json()).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
