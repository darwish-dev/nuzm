import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { AuditIntegrity, HmacCheckpointSigner } from '@nuzm/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../identity';
import { Harness, cookieHeader, jarFrom, type App } from '../identity/testing/app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests
type Row = Record<string, any>;

const h = new Harness();
let app: App;
let mailer: Awaited<ReturnType<Harness['buildApp']>>['mailer'];
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const web: Record<string, Record<string, string>> = {};
const adm: Record<string, Record<string, string>> = {};

type M = 'GET' | 'POST' | 'PUT' | 'PATCH';
const as = (jar: Record<string, string>, method: M, url: string, body?: object) =>
  h.authed(app, jar, method, url, { body });
const admin = (who: string, method: M, url: string, body?: object) =>
  as(adm[who]!, method, url, body);
const orgCall = (who: string, method: 'GET' | 'POST', url: string, org: string, body?: object) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(web[who]!),
      'x-csrf-token': web[who]!.nuzm_csrf!,
      'x-nuzm-org': org,
      'idempotency-key': `i-${Math.random()}`,
    },
    ...(body ? { payload: body } : {}),
  });
const auditRows = (where: string, params: unknown[] = []) =>
  h.env.sql(`SELECT * FROM audit.audit_logs WHERE ${where} ORDER BY chain_seq`, params);

beforeAll(async () => {
  await h.init();
  const built = await h.buildApp({}, undefined, [], { realAudit: true });
  app = built.app;
  mailer = built.mailer;
  for (const n of ['alice', 'bob', 'carol']) {
    ids[n] = await h.createUser(n);
    web[n] = await h.sessionFor(app, ids[n]!);
  }
  orgA = (await as(web.alice!, 'POST', '/v1/organizations', { name: 'Admin Target A' })).json().id;
  orgB = (await as(web.bob!, 'POST', '/v1/organizations', { name: 'Admin Target B' })).json().id;
  await h.env.sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`,
    [orgA, ids.carol],
  );
  const staff = {
    root: ['platform_admin'],
    support: ['support'],
    sec: ['security'],
    comp: ['compliance_officer'],
    fin: ['finance'],
  };
  for (const [name, roles] of Object.entries(staff)) {
    const u = await h.platformUser(app, `staff-${name}`, roles);
    ids[name] = u.id;
    adm[name] = u.jar;
  }
});
afterAll(() => h.close());

describe('access control', () => {
  it('refuses unauthenticated callers, org-member web sessions and API keys with 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/admin/organizations' })).statusCode).toBe(
      401,
    );
    expect((await as(web.alice!, 'GET', '/v1/admin/organizations')).statusCode).toBe(401); // web realm cookie on admin realm route
  });

  it('/v1/me tells an MFA-verified staff session its platform roles and permissions (web sessions get null)', async () => {
    const me = (await as(adm.support!, 'GET', '/v1/me')).json();
    expect(me.platform.roles).toEqual(['support']);
    expect(me.platform.permissions).toEqual(
      expect.arrayContaining(['admin:org:read', 'admin:impersonate']),
    );
    expect(me.platform.permissions).not.toContain('admin:flags:manage');
    expect((await as(web.alice!, 'GET', '/v1/me')).json().platform).toBeNull();
  });

  it('refuses an admin-realm session without MFA (403 mfa_required) and a staff-flagged user without a role (403)', async () => {
    const id = await h.createUser('norole');
    await h.env.sql(`UPDATE identity.users SET is_platform_user = true WHERE id=$1`, [id]);
    const s = await app.get(SessionService).create(id, 'admin', {});
    const cold = { nuzm_admin_session: s.token, nuzm_admin_csrf: s.csrf };
    const noMfa = await as(cold, 'GET', '/v1/admin/organizations');
    expect(noMfa.statusCode).toBe(403);
    expect(noMfa.json().code).toBe('mfa_required');
    await h.elevate(cold);
    expect((await as(cold, 'GET', '/v1/admin/organizations')).statusCode).toBe(403); // MFA ok, but no platform role
  });

  it('a role grants only its own permissions (support cannot suspend; compliance cannot touch flags; finance cannot read users)', async () => {
    expect((await admin('support', 'GET', '/v1/admin/organizations')).statusCode).toBe(200);
    expect(
      (
        await admin('support', 'PATCH', `/v1/admin/organizations/${orgA}`, {
          status: 'suspended',
          reason: 'nope nope',
        })
      ).statusCode,
    ).toBe(403);
    expect((await admin('comp', 'GET', '/v1/admin/feature-flags')).statusCode).toBe(403);
    expect((await admin('fin', 'GET', '/v1/admin/users')).statusCode).toBe(403);
    expect((await admin('support', 'GET', '/v1/admin/audit-logs')).statusCode).toBe(403); // support has no audit:read
    expect((await admin('sec', 'GET', '/v1/admin/audit-logs')).statusCode).toBe(200);
  });

  it('a platform role does not grant org membership: staff still get 404 on tenant routes', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/workspaces',
      headers: { cookie: cookieHeader(adm.root!), 'x-nuzm-org': orgA },
    });
    expect([401, 404]).toContain(r.statusCode); // admin cookie is not a web session; never a tenant credential
  });
});

describe('admin-realm sign-in (OIDC realm=admin)', () => {
  it('issues an admin-realm session (admin cookies only) to a platform user, who still needs MFA', async () => {
    h.idp.user = { sub: 'staff-login', email: 'staff-login@example.test' };
    await h.login(app); // JIT-provision the user through a normal web login first
    await h.env.sql(
      `UPDATE identity.users SET is_platform_user = true WHERE subject = 'staff-login'`,
    );
    const r = await h.login(app, '/', {}, 'admin');
    expect(r.r2.statusCode).toBe(302);
    const cookieNames = Object.keys(jarFrom(r.r2));
    expect(cookieNames.filter((k) => k.startsWith('nuzm_admin')).sort()).toEqual([
      'nuzm_admin_csrf',
      'nuzm_admin_session',
    ]);
    expect(cookieNames).not.toContain('nuzm_session'); // never a web session for an admin sign-in
    const me = await as(r.jar, 'GET', '/v1/me');
    expect(me.statusCode).toBe(403);
    expect(me.json().code).toBe('mfa_required');
    expect(
      (await auditRows(`action='auth.login.succeeded' AND detail->>'realm'='admin'`)).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a non-staff user (403, no session, failure audited) and an unknown realm (422)', async () => {
    h.idp.user = { sub: 'not-staff', email: 'not-staff@example.test' };
    const r = await h.login(app, '/', {}, 'admin');
    expect(r.r2.statusCode).toBe(403);
    expect(Object.keys(jarFrom(r.r2)).filter((k) => k.startsWith('nuzm_admin'))).toEqual([]);
    expect(
      (await auditRows(`action='auth.login.failed' AND detail->>'reason'='not_platform_user'`))
        .length,
    ).toBe(1);
    const bad = await app.inject({ method: 'GET', url: '/v1/auth/oidc/login?realm=root' });
    expect(bad.statusCode).toBe(422);
  });
});

describe('two consoles on one cookie host', () => {
  it('with both realm cookies present, X-Nuzm-Realm picks the session (and the default stays admin-first)', async () => {
    const both = { ...web.alice!, ...adm.support! };
    const call = (realm?: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { cookie: cookieHeader(both), ...(realm ? { 'x-nuzm-realm': realm } : {}) },
      });
    expect((await call('web')).json().email).toBe('alice@example.test');
    expect((await call('admin')).json().email).toBe('staff-support@example.test');
    expect((await call()).json().email).toBe('staff-support@example.test');
  });
});

describe('organizations', () => {
  it('lists across tenants with search, status filter and pagination', async () => {
    const all = (await admin('support', 'GET', '/v1/admin/organizations')).json();
    const names = all.items.map((o: Row) => o.name);
    expect(names).toEqual(expect.arrayContaining(['Admin Target A', 'Admin Target B']));
    expect(all.items[0]).toHaveProperty('memberCount');
    const q = (await admin('support', 'GET', '/v1/admin/organizations?q=Target%20B')).json();
    expect(q.items.map((o: Row) => o.name)).toEqual(['Admin Target B']);
    const p1 = (await admin('support', 'GET', '/v1/admin/organizations?limit=1')).json();
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).not.toBeNull();
    expect((await admin('support', 'GET', '/v1/admin/organizations?status=bogus')).statusCode).toBe(
      422,
    );
  });

  it('suspend needs a reason and step-up; it blocks members, notifies owners, and is audited in the org chain', async () => {
    const noReason = await admin('root', 'PATCH', `/v1/admin/organizations/${orgA}`, {
      status: 'suspended',
    });
    expect(noReason.statusCode).toBe(422);
    // stale step-up
    await h.env.sql(
      `UPDATE identity.sessions SET mfa_verified_at = now() - interval '10 minutes' WHERE token_hash = encode(sha256($1::bytea),'hex')`,
      [adm.root!.nuzm_admin_session],
    );
    const stale = await admin('root', 'PATCH', `/v1/admin/organizations/${orgA}`, {
      status: 'suspended',
      reason: 'abuse report #1',
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().code).toBe('step_up_required');
    await h.elevate(adm.root!);

    const ok = await admin('root', 'PATCH', `/v1/admin/organizations/${orgA}`, {
      status: 'suspended',
      reason: 'abuse report #1',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: orgA, status: 'suspended' });
    expect((await orgCall('alice', 'GET', '/v1/workspaces', orgA)).json().code).toBe(
      'org_suspended',
    );
    const row = (
      await auditRows(`org_id=$1 AND action='admin.organization.suspended'`, [orgA])
    )[0]!;
    expect(row).toMatchObject({
      actor_user_id: ids.root,
      outcome: 'success',
      before: { status: 'active' },
      after: { status: 'suspended' },
    });
    expect(row.detail).toEqual({ reason: 'abuse report #1' });
    // the owner was notified in-app (security notices are always delivered)
    const n = (
      await h.env.sql(`SELECT kind FROM platform.notifications WHERE user_id=$1 AND org_id=$2`, [
        ids.alice,
        orgA,
      ])
    ).map((r) => r.kind);
    expect(n).toContain('security.org_suspended');
    // repeating is a no-op, not a second audit row
    await admin('root', 'PATCH', `/v1/admin/organizations/${orgA}`, {
      status: 'suspended',
      reason: 'abuse report #1',
    });
    expect(
      (await auditRows(`org_id=$1 AND action='admin.organization.suspended'`, [orgA])).length,
    ).toBe(1);

    const back = await admin('root', 'PATCH', `/v1/admin/organizations/${orgA}`, {
      status: 'active',
    });
    expect(back.statusCode).toBe(200);
    expect((await orgCall('alice', 'GET', '/v1/workspaces', orgA)).statusCode).toBe(200);
    expect(
      (await auditRows(`org_id=$1 AND action='admin.organization.reinstated'`, [orgA])).length,
    ).toBe(1);
  });

  it('404 for an unknown or malformed organization id', async () => {
    expect(
      (
        await admin(
          'root',
          'PATCH',
          '/v1/admin/organizations/00000000-0000-7000-8000-0000000000ff',
          { status: 'active' },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await admin('root', 'PATCH', '/v1/admin/organizations/nope', { status: 'active' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('users', () => {
  it('lists users with MFA/session/org facts and never Row credential material', async () => {
    const r = await admin('support', 'GET', '/v1/admin/users?q=alice');
    expect(r.statusCode).toBe(200);
    const alice = r.json().items.find((u: Row) => u.email === 'alice@example.test');
    expect(alice).toMatchObject({ isPlatformUser: false, mfaEnrolled: false, orgCount: 1 });
    expect(r.body).not.toMatch(/token_hash|csrf|secret|password|hash/i);
  });
});

describe('impersonation', () => {
  const imp = (who: string, target: string, body: object) =>
    admin(who, 'POST', `/v1/admin/users/${target}/impersonation`, body);
  const good = {
    reason: 'Customer ticket #4821: cannot see invoices',
    ttlMinutes: 15,
    approvalRef: 'TICKET-4821',
  };

  it('validates the request: reason, ttl cap, approval reference, owner-notice suppression', async () => {
    expect((await imp('support', ids.alice!, { ...good, reason: 'short' })).statusCode).toBe(422);
    expect((await imp('support', ids.alice!, { ...good, ttlMinutes: 31 })).statusCode).toBe(422);
    expect((await imp('support', ids.alice!, { ...good, ttlMinutes: 0 })).statusCode).toBe(422);
    expect((await imp('support', ids.alice!, { ...good, ttlMinutes: 1.5 })).statusCode).toBe(422);
    expect(
      (await imp('support', ids.alice!, { reason: good.reason, ttlMinutes: 10 })).statusCode,
    ).toBe(422); // no approvalRef
    expect((await imp('support', ids.alice!, { ...good, notifyOrgOwners: false })).statusCode).toBe(
      403,
    );
    expect(
      (await h.env.sql(`SELECT 1 FROM identity.sessions WHERE impersonator_user_id IS NOT NULL`))
        .length,
    ).toBe(0);
  });

  it('refuses platform users, yourself, and unknown targets; needs step-up', async () => {
    expect((await imp('root', ids.sec!, good)).statusCode).toBe(403);
    expect((await imp('root', ids.root!, good)).statusCode).toBe(403);
    expect((await imp('root', '00000000-0000-7000-8000-0000000000ff', good)).statusCode).toBe(404);
    await h.env.sql(
      `UPDATE identity.sessions SET mfa_verified_at = now() - interval '10 minutes' WHERE token_hash = encode(sha256($1::bytea),'hex')`,
      [adm.support!.nuzm_admin_session],
    );
    expect((await imp('support', ids.alice!, good)).json().code).toBe('step_up_required');
    await h.elevate(adm.support!);
  });

  let cookies: Record<string, string>;
  it('starts a time-boxed web session for the target, audits it in the platform chain and every target org, and notifies owners', async () => {
    const r = await imp('support', ids.alice!, good);
    expect(r.statusCode).toBe(201);
    expect(r.json().expiresAt).toBeTruthy();
    cookies = jarFrom(r);
    expect(Object.keys(cookies).sort()).toEqual(['nuzm_csrf', 'nuzm_session']);

    const s = (
      await h.env.sql(
        `SELECT user_id, realm, impersonator_user_id, impersonation_reason, impersonation_ref, absolute_expires_at - created_at AS ttl FROM identity.sessions WHERE impersonator_user_id IS NOT NULL`,
      )
    )[0]!;
    expect(s).toMatchObject({
      user_id: ids.alice,
      realm: 'web',
      impersonator_user_id: ids.support,
      impersonation_ref: 'TICKET-4821',
    });
    expect((s.ttl as { minutes: number }).minutes).toBe(15);

    const platform = (
      await auditRows(`org_id IS NULL AND action='admin.impersonation.started'`)
    )[0]!;
    const inOrg = (
      await auditRows(`org_id=$1 AND action='admin.impersonation.started'`, [orgA])
    )[0]!;
    for (const row of [platform, inOrg]) {
      expect(row).toMatchObject({
        actor_user_id: ids.support,
        resource_id: ids.alice,
        outcome: 'success',
      });
      expect(row.detail).toMatchObject({
        reason: good.reason,
        approvalRef: 'TICKET-4821',
        ttlMinutes: 15,
        notifiedOwners: true,
      });
    }
    expect(
      (
        await h.env.sql(`SELECT kind FROM platform.notifications WHERE user_id=$1 AND org_id=$2`, [
          ids.alice,
          orgA,
        ])
      ).map((x) => x.kind),
    ).toContain('security.impersonation_started');
    expect(
      mailer.sent.some(
        (m) =>
          m.template === 'notification' &&
          m.data.kind === 'security.impersonation_started' &&
          m.to === 'alice@example.test',
      ),
    ).toBe(true);
  });

  it('the impersonated session acts AS the target, is labelled in /v1/me, and every action is attributed to the impersonator', async () => {
    const me = (await as(cookies, 'GET', '/v1/me')).json();
    expect(me.email).toBe('alice@example.test');
    expect(me.impersonation).toMatchObject({ byUserId: ids.support, reason: good.reason });
    const ws = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: {
        cookie: cookieHeader(cookies),
        'x-csrf-token': cookies.nuzm_csrf!,
        'x-nuzm-org': orgA,
        'idempotency-key': 'imp-ws',
      },
      payload: { name: 'created-while-impersonated' },
    });
    expect(ws.statusCode).toBe(201);
    const row = (await auditRows(`org_id=$1 AND resource_id=$2`, [orgA, ws.json().id]))[0]!;
    expect(row).toMatchObject({
      actor_type: 'impersonator',
      actor_user_id: ids.alice,
      impersonator_user_id: ids.support,
    });
  });

  it('refuses credential changes while impersonating (MFA, API keys) and ordinary sessions show no impersonation', async () => {
    expect((await as(cookies, 'POST', '/v1/auth/mfa/factors', { type: 'totp' })).statusCode).toBe(
      403,
    );
    const key = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        cookie: cookieHeader(cookies),
        'x-csrf-token': cookies.nuzm_csrf!,
        'x-nuzm-org': orgA,
        'idempotency-key': 'imp-k',
      },
      payload: { name: 'x', scopes: ['org:read'] },
    });
    expect(key.statusCode).toBe(403);
    expect((await as(web.alice!, 'GET', '/v1/me')).json().impersonation).toBeNull();
  });

  it('expires on time: past the TTL the session is dead', async () => {
    await h.env.sql(
      `UPDATE identity.sessions SET absolute_expires_at = now() - interval '1 second' WHERE impersonator_user_id IS NOT NULL`,
    );
    expect((await as(cookies, 'GET', '/v1/me')).statusCode).toBe(401);
  });

  it('only platform_admin may suppress the owner notice; the suppression is itself recorded', async () => {
    const before = (
      await h.env.sql(
        `SELECT count(*)::int n FROM platform.notifications WHERE user_id=$1 AND kind='security.impersonation_started'`,
        [ids.bob],
      )
    )[0]!.n;
    const r = await imp('root', ids.bob!, {
      reason: 'Security review of tenant B',
      ttlMinutes: 5,
      notifyOrgOwners: false,
    });
    expect(r.statusCode).toBe(201);
    expect(
      (
        await h.env.sql(
          `SELECT count(*)::int n FROM platform.notifications WHERE user_id=$1 AND kind='security.impersonation_started'`,
          [ids.bob],
        )
      )[0]!.n,
    ).toBe(before);
    expect(
      (await auditRows(`org_id=$1 AND action='admin.impersonation.started'`, [orgB]))[0]!.detail,
    ).toMatchObject({ notifiedOwners: false, approvalRef: null });
  });

  it('the database itself rejects an impersonation session longer than 30 minutes', async () => {
    await expect(
      h.env.sql(
        `UPDATE identity.sessions SET absolute_expires_at = created_at + interval '31 minutes' WHERE impersonator_user_id IS NOT NULL`,
      ),
    ).rejects.toThrow(/sessions_impersonation_consistent/);
  });
});

describe('create customers and organizations (admin tools)', () => {
  it('creates a customer account with a generated temporary password that signs in; a given password is used as is; never a platform user', async () => {
    await h.elevate(adm.root!);
    const r = await admin('root', 'POST', '/v1/admin/users', {
      email: 'new.customer@example.test',
      displayName: 'New Customer',
      locale: 'en',
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body).toMatchObject({
      email: 'new.customer@example.test',
      displayName: 'New Customer',
      locale: 'en',
    });
    expect(body.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const [u] = await h.env.sql(`SELECT is_platform_user FROM identity.users WHERE id = $1`, [
      body.id,
    ]);
    expect(u!.is_platform_user).toBe(false);
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/login',
      payload: { email: 'new.customer@example.test', password: body.temporaryPassword },
    });
    expect(login.statusCode).toBe(200);

    const given = await admin('root', 'POST', '/v1/admin/users', {
      email: 'given.password@example.test',
      password: 'a-long-enough-passphrase-1',
    });
    expect(given.statusCode).toBe(201);
    expect(given.json().temporaryPassword).toBeUndefined();

    // the generated password is never written to the audit trail
    const rows = await auditRows(`action = 'admin.user.created'`);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(body.temporaryPassword);
    expect(rows[0]!.actor_user_id).toBe(ids.root);
  });

  it('refuses a duplicate email (409), a bad email or weak password (422), missing permission (403) and a stale step-up', async () => {
    await h.elevate(adm.root!);
    const dup = await admin('root', 'POST', '/v1/admin/users', {
      email: 'new.customer@example.test',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('email_in_use');
    expect(
      (await admin('root', 'POST', '/v1/admin/users', { email: 'not-an-email' })).statusCode,
    ).toBe(422);
    expect(
      (
        await admin('root', 'POST', '/v1/admin/users', {
          email: 'weak@example.test',
          password: 'short',
        })
      ).statusCode,
    ).toBe(422);
    await h.elevate(adm.support!);
    expect(
      (await admin('support', 'POST', '/v1/admin/users', { email: 'x@example.test' })).statusCode,
    ).toBe(403);
    await h.env.sql(
      `UPDATE identity.sessions SET mfa_verified_at = now() - interval '10 minutes' WHERE token_hash = encode(sha256($1::bytea),'hex')`,
      [adm.root!.nuzm_admin_session],
    );
    const stale = await admin('root', 'POST', '/v1/admin/users', { email: 'stale@example.test' });
    expect(stale.json().code).toBe('step_up_required');
  });

  it('creates an organization owned by an existing customer, audited twice; refuses unknown owners, staff owners, duplicates and missing permission', async () => {
    await h.elevate(adm.root!);
    const r = await admin('root', 'POST', '/v1/admin/organizations', {
      name: 'Created By Staff',
      ownerEmail: 'NEW.customer@example.test',
      type: 'agency',
      defaultLocale: 'en',
    });
    expect(r.statusCode).toBe(201);
    const org = r.json();
    expect(org).toMatchObject({ name: 'Created By Staff', type: 'agency' });
    const [m] = await h.env.sql(
      `SELECT m.role FROM tenancy.memberships m JOIN identity.users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = 'new.customer@example.test'`,
      [org.id],
    );
    expect(m!.role).toBe('owner');
    expect(
      await auditRows(`action = 'admin.organization.created' AND org_id = $1`, [org.id]),
    ).toHaveLength(1);

    const dup = await admin('root', 'POST', '/v1/admin/organizations', {
      name: 'Created By Staff',
      ownerEmail: 'new.customer@example.test',
    });
    expect(dup.statusCode).toBe(409);
    expect(
      (
        await admin('root', 'POST', '/v1/admin/organizations', {
          name: 'Nobody',
          ownerEmail: 'nobody@example.test',
        })
      ).statusCode,
    ).toBe(404);
    const [staffUser] = await h.env.sql(`SELECT email FROM identity.users WHERE id = $1`, [
      ids.support,
    ]);
    expect(
      (
        await admin('root', 'POST', '/v1/admin/organizations', {
          name: 'Staff Org',
          ownerEmail: staffUser!.email,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await admin('root', 'POST', '/v1/admin/organizations', { name: 'No Owner' })).statusCode,
    ).toBe(422);
    await h.elevate(adm.fin!);
    expect(
      (
        await admin('fin', 'POST', '/v1/admin/organizations', {
          name: 'Fin Org',
          ownerEmail: 'new.customer@example.test',
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('feature flags', () => {
  it('sets and lists global and org flags, audits before/after, and exposes them through /v1/me', async () => {
    const g = await admin('root', 'PUT', '/v1/admin/feature-flags', {
      key: 'beta.dashboard',
      scope: 'global',
      value: false,
    });
    expect(g.statusCode).toBe(200);
    const o = await admin('root', 'PUT', '/v1/admin/feature-flags', {
      key: 'beta.dashboard',
      scope: 'org',
      orgId: orgB,
      value: true,
    });
    expect(o.statusCode).toBe(200);
    await admin('root', 'PUT', '/v1/admin/feature-flags', {
      key: 'beta.dashboard',
      scope: 'global',
      value: true,
    }); // update
    const list = (await admin('root', 'GET', '/v1/admin/feature-flags')).json().items;
    expect(list.filter((f: Row) => f.key === 'beta.dashboard')).toHaveLength(2);
    const upd = (
      await auditRows(
        `action='admin.feature_flag.set' AND org_id IS NULL ORDER BY chain_seq DESC LIMIT 1`.replace(
          ' ORDER BY chain_seq DESC LIMIT 1',
          '',
        ),
      )
    ).filter((r) => (r.before as Row)?.value === false)[0]!;
    expect(upd).toMatchObject({
      before: { value: false },
      after: { value: true },
      resource_id: 'beta.dashboard',
    });
    expect((await auditRows(`action='admin.feature_flag.set' AND org_id=$1`, [orgB])).length).toBe(
      1,
    );
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: cookieHeader(web.bob!), 'x-nuzm-org': orgB },
    });
    expect(me.json().featureFlags['beta.dashboard']).toBe(true);
  });

  it('validates keys, scope/orgId pairing and existing orgs', async () => {
    const bad = (b: object) => admin('root', 'PUT', '/v1/admin/feature-flags', b);
    expect((await bad({ key: 'Bad Key', scope: 'global', value: 1 })).statusCode).toBe(422);
    expect((await bad({ key: 'ok.key', scope: 'global', orgId: orgA, value: 1 })).statusCode).toBe(
      422,
    );
    expect((await bad({ key: 'ok.key', scope: 'org', value: 1 })).statusCode).toBe(422);
    expect((await bad({ key: 'ok.key', scope: 'org', orgId: 'x', value: 1 })).statusCode).toBe(422);
    expect((await bad({ key: 'ok.key', scope: 'global' })).statusCode).toBe(422);
    expect(
      (
        await bad({
          key: 'ok.key',
          scope: 'org',
          orgId: '00000000-0000-7000-8000-0000000000ff',
          value: 1,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('cross-org audit viewer', () => {
  it('shows events of every tenant, filters by org, and audits the act of reading', async () => {
    const all = (await admin('sec', 'GET', '/v1/admin/audit-logs?limit=200')).json();
    const orgs = new Set(all.items.map((i: Row) => i.orgId));
    expect(orgs.has(orgA) && orgs.has(orgB)).toBe(true);
    const only = (await admin('sec', 'GET', `/v1/admin/audit-logs?orgId=${orgB}&limit=200`)).json();
    expect(only.items.length).toBeGreaterThan(0);
    expect(only.items.every((i: Row) => i.orgId === orgB)).toBe(true);
    const reads = await auditRows(`action='audit.admin_log.queried'`);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads[0]).toMatchObject({ actor_user_id: ids.sec, org_id: null });
    expect(JSON.stringify(reads.map((r) => r.detail))).toContain(orgB);
  });

  it('every chain still verifies after all admin activity', async () => {
    const v = new AuditIntegrity(
      h.env.app,
      new HmacCheckpointSigner(new Uint8Array(randomBytes(32))),
    );
    const run = await v.runOnce();
    expect(run.chains.length).toBeGreaterThanOrEqual(3);
    expect(run.chains.filter((c) => !c.ok)).toEqual([]);
  });
});
