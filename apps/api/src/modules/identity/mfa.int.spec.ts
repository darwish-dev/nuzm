import 'reflect-metadata';
import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from './internal/session.service';
import { Harness, jarFrom, type App } from './testing/app-harness';

const h = new Harness();
let main: Awaited<ReturnType<Harness['buildApp']>>;
let app: App;

const totp = (secret: string) =>
  new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  });
const codeAt = (secret: string, steps = 0) =>
  totp(secret).generate({ timestamp: Date.now() + steps * 30_000 });
const wrongCode = (secret: string) => (codeAt(secret) === '000000' ? '111111' : '000000');

beforeAll(async () => {
  await h.init();
  main = await h.buildApp();
  app = main.app;
});
afterAll(() => h.close());

async function loginAs(sub: string) {
  h.idp.user = { sub, email: `${sub}@example.test` };
  const r = await h.login(app);
  expect(r.r2.statusCode).toBe(302);
  return r.jar;
}
const post = (jar: Record<string, string>, url: string, body?: unknown) =>
  h.authed(app, jar, 'POST', url, { body: body ?? {} });

/** Enrol + activate TOTP; returns the fresh jar (session rotated) and secret. */
async function enrolled(sub: string) {
  let jar = await loginAs(sub);
  const e = await post(jar, '/v1/auth/mfa/factors', { type: 'totp' });
  expect(e.statusCode).toBe(201);
  const { id, secret } = e.json();
  const used = codeAt(secret);
  const v = await post(jar, `/v1/auth/mfa/factors/${id}/verification`, { code: used });
  expect(v.statusCode).toBe(200);
  jar = jarFrom(v, jar);
  return { jar, id: id as string, secret: secret as string, used };
}

describe('mfa_enroll_verify_recover', () => {
  it('enrols TOTP: secret is returned once, stored only in the secret store, and activation rotates the session', async () => {
    const jar = await loginAs('m-life');
    const e = await post(jar, '/v1/auth/mfa/factors', { type: 'totp' });
    expect(e.statusCode).toBe(201);
    const { id, secret, otpauthUri } = e.json();
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/.*secret=/);
    const row = (
      await h.env.sql(`SELECT secret_ref, status FROM identity.mfa_factors WHERE id=$1`, [id])
    )[0]!;
    expect(row.secret_ref).toMatch(/^vault:\/\//);
    expect(JSON.stringify(await h.env.sql(`SELECT * FROM identity.mfa_factors`))).not.toContain(
      secret,
    );
    expect(row.status).toBe('pending');

    expect((await post(jar, '/v1/auth/mfa/factors', { type: 'totp' })).statusCode).toBe(409); // pending exists
    expect((await post(jar, '/v1/auth/mfa/factors', { type: 'sms' })).statusCode).toBe(422);

    const bad = await post(jar, `/v1/auth/mfa/factors/${id}/verification`, {
      code: wrongCode(secret),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('validation_failed');

    const ok = await post(jar, `/v1/auth/mfa/factors/${id}/verification`, { code: codeAt(secret) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ mfaLevel: 'totp', activated: true });
    const fresh = jarFrom(ok, { ...jar });
    expect(fresh.nuzm_session).not.toBe(jar.nuzm_session);
    expect((await h.authed(app, jar, 'GET', '/v1/me')).statusCode).toBe(401); // old tokens dead
    expect((await h.authed(app, fresh, 'GET', '/v1/me')).json().mfaLevel).toBe('totp');
    expect((await post(fresh, '/v1/auth/mfa/factors', { type: 'totp' })).statusCode).toBe(409); // already active
  });

  it('rejects a replayed TOTP code but accepts the next time step', async () => {
    const { jar, id, secret, used } = await enrolled('m-replay');
    // replay the EXACT code used at activation (deterministic even if a 30 s step boundary passes)
    const same = await post(jar, `/v1/auth/mfa/factors/${id}/verification`, { code: used });
    expect(same.statusCode).toBe(422); // same step already used at activation
    const next = await post(jar, `/v1/auth/mfa/factors/${id}/verification`, {
      code: codeAt(secret, 1),
    });
    expect(next.statusCode).toBe(200);
  });

  it('locks after 5 consecutive failures (429), even for the correct code, until the lock expires', async () => {
    const { jar, id, secret } = await enrolled('m-lock');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push(
        (await post(jar, `/v1/auth/mfa/factors/${id}/verification`, { code: wrongCode(secret) }))
          .statusCode,
      );
    expect(statuses).toEqual([422, 422, 422, 422, 429]);
    expect(
      (await post(jar, `/v1/auth/mfa/factors/${id}/verification`, { code: codeAt(secret, 1) }))
        .statusCode,
    ).toBe(429);
    await h.env.sql(
      `UPDATE identity.mfa_factors SET locked_until = now() - interval '1 second' WHERE id=$1`,
      [id],
    );
    expect(
      (await post(jar, `/v1/auth/mfa/factors/${id}/verification`, { code: codeAt(secret, 1) }))
        .statusCode,
    ).toBe(200);
  });

  it('recovery codes: 10 shown once, stored only as hashes, regenerating invalidates the old batch, each code is single-use', async () => {
    const { jar, id } = await enrolled('m-recover');
    const gen1 = await post(jar, '/v1/auth/mfa/recovery-codes');
    expect(gen1.statusCode).toBe(201);
    const first: string[] = gen1.json().codes;
    expect(first).toHaveLength(10);
    expect(
      JSON.stringify(await h.env.sql(`SELECT code_hash FROM identity.recovery_codes`)),
    ).not.toContain(first[0]!.replace('-', ''));

    const gen2 = await post(jar, '/v1/auth/mfa/recovery-codes');
    const second: string[] = gen2.json().codes;
    expect(
      (
        await h.env.sql(
          `SELECT count(*)::int n FROM identity.recovery_codes WHERE user_id=(SELECT id FROM identity.users WHERE subject='m-recover')`,
        )
      )[0]!.n,
    ).toBe(10);

    // a fresh login has no MFA; recover with a code
    const j2 = await loginAs('m-recover');
    expect(
      (await post(j2, `/v1/auth/mfa/factors/${id}/verification`, { recoveryCode: first[0] }))
        .statusCode,
    ).toBe(422); // old batch invalid
    const used = await post(j2, `/v1/auth/mfa/factors/${id}/verification`, {
      recoveryCode: second[0]!.toLowerCase(),
    });
    expect(used.statusCode).toBe(200);
    expect(used.json().mfaLevel).toBe('recovery');
    const j3 = await loginAs('m-recover');
    expect(
      (await post(j3, `/v1/auth/mfa/factors/${id}/verification`, { recoveryCode: second[0] }))
        .statusCode,
    ).toBe(422); // recovery_code_single_use
    expect(
      (await post(j3, `/v1/auth/mfa/factors/${id}/verification`, { recoveryCode: second[1] }))
        .statusCode,
    ).toBe(200);
  });

  it('recovery-code guessing feeds the same lockout', async () => {
    const { id } = await enrolled('m-rguess');
    const jar = await loginAs('m-rguess');
    const s: number[] = [];
    for (let i = 0; i < 5; i++)
      s.push(
        (
          await post(jar, `/v1/auth/mfa/factors/${id}/verification`, {
            recoveryCode: 'AAAAA-AAAAA',
          })
        ).statusCode,
      );
    expect(s).toEqual([422, 422, 422, 422, 429]);
  });
});

describe('step-up', () => {
  it('sensitive actions need a recent MFA verification (401 step_up_required)', async () => {
    const { jar } = await enrolled('m-step');
    const cold = await loginAs('m-step'); // new session, no MFA performed
    const denied = await post(cold, '/v1/auth/mfa/recovery-codes');
    expect(denied.statusCode).toBe(401);
    expect(denied.json().code).toBe('step_up_required');
    // a recent verification passes
    expect((await post(jar, '/v1/auth/mfa/recovery-codes')).statusCode).toBe(201);
  });

  it('a stale verification on the exact session is refused', async () => {
    const { jar } = await enrolled('m-stale');
    const sid = (
      await h.env.sql(
        `SELECT id FROM identity.sessions WHERE user_id=(SELECT id FROM identity.users WHERE subject='m-stale') AND revoked_at IS NULL`,
      )
    )[0]!.id;
    await h.env.sql(
      `UPDATE identity.sessions SET mfa_verified_at = now() - interval '10 minutes' WHERE id=$1`,
      [sid],
    );
    const r = await post(jar, '/v1/auth/mfa/recovery-codes');
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('step_up_required');
  });

  it('removing a factor needs step-up; platform users cannot remove their last factor', async () => {
    const { jar, id } = await enrolled('m-remove');
    const cold = await loginAs('m-remove');
    expect((await h.authed(app, cold, 'DELETE', `/v1/auth/mfa/factors/${id}`)).statusCode).toBe(
      401,
    );
    await h.env.sql(`UPDATE identity.users SET is_platform_user = true WHERE subject='m-remove'`);
    const blocked = await h.authed(app, jar, 'DELETE', `/v1/auth/mfa/factors/${id}`);
    expect(blocked.statusCode).toBe(409);
    await h.env.sql(`UPDATE identity.users SET is_platform_user = false WHERE subject='m-remove'`);
    expect((await h.authed(app, jar, 'DELETE', `/v1/auth/mfa/factors/${id}`)).statusCode).toBe(204);
    expect((await h.env.sql(`SELECT 1 FROM identity.mfa_factors WHERE id=$1`, [id])).length).toBe(
      0,
    );
  });
});

describe('admin realm requires MFA', () => {
  it('an admin session can only enrol/verify MFA until verified, then reaches normal routes', async () => {
    h.idp.user = { sub: 'm-admin', email: 'm-admin@example.test' };
    await h.login(app); // creates the user
    const uid = (await h.env.sql(`SELECT id FROM identity.users WHERE subject='m-admin'`))[0]!
      .id as string;
    const s = await app.get(SessionService).create(uid, 'admin', {});
    let jar: Record<string, string> = { nuzm_admin_session: s.token, nuzm_admin_csrf: s.csrf };

    const me = await h.authed(app, jar, 'GET', '/v1/me');
    expect(me.statusCode).toBe(403);
    expect(me.json().code).toBe('mfa_required');

    const e = await post(jar, '/v1/auth/mfa/factors', { type: 'totp' });
    expect(e.statusCode).toBe(201);
    const { id, secret } = e.json();
    const v = await post(jar, `/v1/auth/mfa/factors/${id}/verification`, { code: codeAt(secret) });
    expect(v.statusCode).toBe(200);
    jar = jarFrom(v, jar);
    expect(jar.nuzm_admin_session).not.toBe(s.token);
    expect((await h.authed(app, jar, 'GET', '/v1/me')).statusCode).toBe(200);
  });
});

describe('audit of MFA outcomes', () => {
  it('records MFA events without leaking secrets or codes', () => {
    const actions = main.sink.events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.mfa.activated',
        'auth.mfa.verify_failed',
        'auth.mfa.recovery_used',
        'auth.mfa.recovery_codes_generated',
      ]),
    );
    expect(JSON.stringify(main.sink.events)).not.toMatch(/otpauth:|secret|recoveryCode/i);
  });
});
