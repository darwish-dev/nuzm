import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from './internal/session.service';
import { RealmOnly } from './index';
import { Harness, cookieHeader, jarFrom, type App } from './testing/app-harness';

@Controller('test-admin')
class AdminProbeController {
  @RealmOnly('admin')
  @Get('probe')
  probe() {
    return { ok: true };
  }
}

const h = new Harness();
const env = { sql: (q: string, p?: unknown[]) => h.env.sql(q, p) };
const idp = h.idp;
const login = (app: App, returnTo?: string, jar?: Record<string, string>) =>
  h.login(app, returnTo, jar);
const authed = (
  app: App,
  jar: Record<string, string>,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  csrf = true,
) => h.authed(app, jar, method, url, { csrf });
const buildApp = (overrides: Record<string, string> = {}, issuer?: string) =>
  h.buildApp(overrides, issuer, [AdminProbeController]);

let main: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await h.init();
  main = await buildApp();
});

afterAll(() => h.close());

describe('oidc_login_pkce_flow', () => {
  it('redirects to the IdP with state, nonce and an S256 PKCE challenge, then logs in and lands on returnTo', async () => {
    idp.user = {
      sub: 'u-flow',
      email: 'flow@example.test',
      email_verified: true,
      name: 'Flow User',
    };
    const { r1, r2, jar } = await login(main.app, '/dashboard');
    const auth = new URL(r1.headers.location as string);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.searchParams.get('state')?.length).toBeGreaterThan(20);
    expect(auth.searchParams.get('nonce')?.length).toBeGreaterThan(20);
    expect(r2.statusCode).toBe(302);
    expect(r2.headers.location).toBe('/dashboard');
    const set = [r2.headers['set-cookie']].flat().join('\n');
    expect(set).toMatch(/nuzm_session=nzs_[^;]+; .*HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/nuzm_csrf=nzc_/);
    expect(set).not.toMatch(/nuzm_csrf=[^;]*;.*HttpOnly/); // csrf cookie must be readable by the SPA
    const me = await authed(main.app, jar, 'GET', '/v1/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      email: 'flow@example.test',
      isPlatformUser: false,
      memberships: [],
    });
  });

  it('stores only hashes: the raw session token never appears in the database', async () => {
    idp.user = { sub: 'u-hash', email: 'hash@example.test' };
    const { jar } = await login(main.app);
    const rows = await env.sql(`SELECT token_hash, csrf_hash FROM identity.sessions`);
    const all = JSON.stringify(rows);
    expect(all).not.toContain(jar.nuzm_session);
    expect(all).not.toContain(jar.nuzm_csrf);
  });

  it('rejects an authorization-code replay at the IdP (single use) → 400 oidc_token_invalid', async () => {
    idp.user = { sub: 'u-replay', email: 'replay@example.test' };
    const { back, r1 } = await login(main.app);
    const again = await main.app.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback${back.search}`,
      headers: { cookie: cookieHeader(jarFrom(r1)) },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('oidc_token_invalid');
  });

  it('state mismatch → 400 oidc_state_mismatch, and no session is created', async () => {
    const before = (await env.sql(`SELECT count(*)::int n FROM identity.sessions`))[0]!.n;
    const r1 = await main.app.inject({ method: 'GET', url: '/v1/auth/oidc/login' });
    const bad = await main.app.inject({
      method: 'GET',
      url: '/v1/auth/oidc/callback?code=abc&state=forged',
      headers: { cookie: cookieHeader(jarFrom(r1)) },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('oidc_state_mismatch');
    const noCtx = await main.app.inject({
      method: 'GET',
      url: '/v1/auth/oidc/callback?code=abc&state=x',
    });
    expect(noCtx.json().code).toBe('oidc_state_mismatch');
    expect((await env.sql(`SELECT count(*)::int n FROM identity.sessions`))[0]!.n).toBe(before);
  });

  it.each([
    ['nonce mismatch', { badNonce: true }],
    ['wrong audience', { wrongAudience: true }],
    ['expired id_token', { expiredToken: true }],
  ])('tampered id_token (%s) → 400 oidc_token_invalid, no session', async (_n, knob) => {
    idp.user = { sub: `u-bad-${_n}`, email: `bad-${_n.replace(/\s/g, '')}@example.test` };
    Object.assign(idp.knobs, knob);
    try {
      const { r2 } = await login(main.app);
      expect(r2.statusCode).toBe(400);
      expect(r2.json().code).toBe('oidc_token_invalid');
    } finally {
      idp.knobs.badNonce = idp.knobs.wrongAudience = idp.knobs.expiredToken = false;
    }
    expect(
      await env.sql(`SELECT 1 FROM identity.users WHERE subject = $1`, [`u-bad-${_n}`]),
    ).toHaveLength(0);
  });
});

describe('open-redirect and returnTo', () => {
  it.each([
    'https://evil.example/x',
    '//evil.example',
    'javascript:alert(1)',
    '/ok\\@evil.example',
  ])('rejects returnTo=%s', async (rt) => {
    const res = await main.app.inject({
      method: 'GET',
      url: `/v1/auth/oidc/login?returnTo=${encodeURIComponent(rt)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_return_to');
  });
  it('accepts relative paths and allow-listed origins only', async () => {
    expect(
      (
        await main.app.inject({
          method: 'GET',
          url: '/v1/auth/oidc/login?returnTo=%2Fprojects%3Fa%3D1',
        })
      ).statusCode,
    ).toBe(302);
    expect(
      (
        await main.app.inject({
          method: 'GET',
          url: `/v1/auth/oidc/login?returnTo=${encodeURIComponent('http://127.0.0.1:3000/x')}`,
        })
      ).statusCode,
    ).toBe(302);
  });
});

describe('session lifecycle', () => {
  it('session_idle_and_absolute_timeout', async () => {
    idp.user = { sub: 'u-time', email: 'time@example.test' };
    const { jar } = await login(main.app);
    expect((await authed(main.app, jar, 'GET', '/v1/me')).statusCode).toBe(200);
    await env.sql(
      `UPDATE identity.sessions SET idle_expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM identity.users WHERE subject='u-time')`,
    );
    expect((await authed(main.app, jar, 'GET', '/v1/me')).statusCode).toBe(401);

    const second = await login(main.app);
    expect((await authed(main.app, second.jar, 'GET', '/v1/me')).statusCode).toBe(200);
    await env.sql(
      `UPDATE identity.sessions SET absolute_expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM identity.users WHERE subject='u-time') AND revoked_at IS NULL AND idle_expires_at > now()`,
    );
    expect((await authed(main.app, second.jar, 'GET', '/v1/me')).statusCode).toBe(401);
  });

  it('idle timeout slides forward on activity but never beyond the absolute limit', async () => {
    idp.user = { sub: 'u-slide', email: 'slide@example.test' };
    const { jar } = await login(main.app);
    await env.sql(
      `UPDATE identity.sessions SET idle_expires_at = now() + interval '5 seconds', absolute_expires_at = now() + interval '20 seconds' WHERE user_id = (SELECT id FROM identity.users WHERE subject='u-slide')`,
    );
    await authed(main.app, jar, 'GET', '/v1/me');
    const r = (
      await env.sql(
        `SELECT idle_expires_at <= absolute_expires_at AS ok, idle_expires_at > now() + interval '10 seconds' AS slid FROM identity.sessions WHERE user_id = (SELECT id FROM identity.users WHERE subject='u-slide')`,
      )
    )[0]!;
    expect(r.ok).toBe(true);
    expect(r.slid).toBe(true);
  });

  it('logout needs the CSRF token, revokes the session, and clears cookies', async () => {
    idp.user = { sub: 'u-logout', email: 'logout@example.test' };
    const { jar } = await login(main.app);
    const noCsrf = await authed(main.app, jar, 'POST', '/v1/auth/logout', false);
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe('csrf_failed');
    const wrong = await main.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': 'nzc_wrong' },
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await authed(main.app, jar, 'POST', '/v1/auth/logout');
    expect(ok.statusCode).toBe(204);
    expect((await authed(main.app, jar, 'GET', '/v1/me')).statusCode).toBe(401);
    expect(main.sink.events.map((e) => e.action)).toContain('auth.logout');
  });

  it('session fixation: a pre-existing session is revoked on login and fresh tokens are issued', async () => {
    idp.user = { sub: 'u-fix', email: 'fix@example.test' };
    const first = await login(main.app);
    const second = await login(main.app, '/x', {
      nuzm_session: first.jar.nuzm_session!,
      nuzm_csrf: first.jar.nuzm_csrf!,
    });
    expect(second.jar.nuzm_session).not.toBe(first.jar.nuzm_session);
    expect((await authed(main.app, first.jar, 'GET', '/v1/me')).statusCode).toBe(401);
    expect((await authed(main.app, second.jar, 'GET', '/v1/me')).statusCode).toBe(200);
  });

  it("lists only own sessions; revoking another user's session is a 404; revoking your own works", async () => {
    idp.user = { sub: 'u-s1', email: 's1@example.test' };
    const a1 = await login(main.app);
    const a2 = await login(main.app); // second device, fixation rule revokes only the cookie it was given
    idp.user = { sub: 'u-s2', email: 's2@example.test' };
    const b = await login(main.app);
    const listA = (await authed(main.app, a1.jar, 'GET', '/v1/auth/sessions')).json();
    expect(listA.items).toHaveLength(2);
    expect(listA.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const otherId = (await authed(main.app, b.jar, 'GET', '/v1/auth/sessions')).json().items[0].id;
    expect(
      (await authed(main.app, a1.jar, 'DELETE', `/v1/auth/sessions/${otherId}`)).statusCode,
    ).toBe(404);
    const mine = listA.items.find((s: { current: boolean }) => !s.current).id;
    expect((await authed(main.app, a1.jar, 'DELETE', `/v1/auth/sessions/${mine}`)).statusCode).toBe(
      204,
    );
    expect((await authed(main.app, a2.jar, 'GET', '/v1/me')).statusCode).toBe(401);
    expect((await authed(main.app, b.jar, 'GET', '/v1/me')).statusCode).toBe(200);
    expect(
      (await authed(main.app, a1.jar, 'DELETE', `/v1/auth/sessions/not-a-uuid`)).statusCode,
    ).toBe(404);
  });

  it('a disabled user cannot log in and an existing session stops working', async () => {
    idp.user = { sub: 'u-dis', email: 'dis@example.test' };
    const { jar } = await login(main.app);
    await env.sql(`UPDATE identity.users SET status='disabled' WHERE subject='u-dis'`);
    expect((await authed(main.app, jar, 'GET', '/v1/me')).statusCode).toBe(401);
    const again = await login(main.app);
    expect(again.r2.statusCode).toBe(403);
    expect(again.r2.json().code).toBe('idp_user_disabled');
  });
});

describe('authentication is deny-by-default and realm-separated', () => {
  it('rejects unauthenticated access to protected routes; only health and auth entrypoints are public', async () => {
    expect((await main.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await main.app.inject({ method: 'GET', url: '/v1/auth/sessions' })).statusCode).toBe(
      401,
    );
    expect((await main.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect(
      (
        await main.app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { cookie: 'nuzm_session=nzs_garbage' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('an admin-realm session is rejected on web routes and a web session is rejected on admin routes', async () => {
    idp.user = { sub: 'u-realm', email: 'realm@example.test' };
    const web = await login(main.app);
    const userId = (await env.sql(`SELECT id FROM identity.users WHERE subject='u-realm'`))[0]!
      .id as string;
    const admin = await main.app.get(SessionService).create(userId, 'admin', {});
    // admin token presented in the web cookie → rejected
    expect(
      (
        await main.app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { cookie: `nuzm_session=${admin.token}` },
        })
      ).statusCode,
    ).toBe(401);
    // web token presented in the admin cookie → rejected
    expect(
      (
        await main.app.inject({
          method: 'GET',
          url: '/test-admin/probe',
          headers: { cookie: `nuzm_admin_session=${web.jar.nuzm_session}` },
        })
      ).statusCode,
    ).toBe(401);
    // web cookie on an admin route → no admin cookie at all → rejected
    expect(
      (
        await main.app.inject({
          method: 'GET',
          url: '/test-admin/probe',
          headers: { cookie: cookieHeader(web.jar) },
        })
      ).statusCode,
    ).toBe(401);
    // correct admin cookie but no MFA yet → refused (admin realm requires MFA)
    const noMfa = await main.app.inject({
      method: 'GET',
      url: '/test-admin/probe',
      headers: { cookie: `nuzm_admin_session=${admin.token}` },
    });
    expect(noMfa.statusCode).toBe(403);
    expect(noMfa.json().code).toBe('mfa_required');
    // after MFA elevation the same request is accepted
    await env.sql(
      `UPDATE identity.sessions SET mfa_level='totp', mfa_verified_at=now() WHERE id=$1`,
      [admin.id],
    );
    expect(
      (
        await main.app.inject({
          method: 'GET',
          url: '/test-admin/probe',
          headers: { cookie: `nuzm_admin_session=${admin.token}` },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('failure handling and abuse controls', () => {
  it('IdP unreachable at discovery → 503 service_unavailable, no session', async () => {
    const { app } = await buildApp({}, 'http://127.0.0.1:1');
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/auth/oidc/login' });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('service_unavailable');
    } finally {
      await h.closeApp(app);
    }
  });

  it('IdP token endpoint failing (500) → 503 and no session or user is created', async () => {
    idp.user = { sub: 'u-500', email: 'five@example.test' };
    idp.knobs.tokenStatus = 500;
    try {
      const { r2 } = await login(main.app);
      expect(r2.statusCode).toBe(503);
    } finally {
      idp.knobs.tokenStatus = 0;
    }
    expect(await env.sql(`SELECT 1 FROM identity.users WHERE subject='u-500'`)).toHaveLength(0);
  });

  it('rate limits the auth endpoints per client → 429 (brute-force/abuse control)', async () => {
    const { app } = await buildApp({ LOGIN_RATE_PER_MINUTE: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push((await app.inject({ method: 'GET', url: '/v1/auth/oidc/login' })).statusCode);
      expect(codes).toEqual([302, 302, 302, 429, 429]);
    } finally {
      await h.closeApp(app);
    }
  });
});

describe('audit trail of auth outcomes', () => {
  it('records success and failure events without secrets', async () => {
    const actions = main.sink.events.map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.login.succeeded:success',
        'auth.login.failed:failure',
        'auth.logout:success',
        'auth.login.rejected:failure',
      ]),
    );
    const blob = JSON.stringify(main.sink.events);
    expect(blob).not.toMatch(/nzs_|nzc_|code_verifier|client_secret/);
  });
});
