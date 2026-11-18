import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, jarFrom } from './testing/app-harness';

const h = new Harness();
const sql = (q: string, p?: unknown[]) => h.env.sql(q, p);
let app: Awaited<ReturnType<Harness['buildApp']>>['app'];
let mailer: Awaited<ReturnType<Harness['buildApp']>>['mailer'];
let sink: Awaited<ReturnType<Harness['buildApp']>>['sink'];

const PW = 'a long passphrase 2026';
let n = 0;
const fresh = () => `user${++n}-${Date.now()}@example.test`;

const post = (url: string, payload: unknown, jar: Record<string, string> = {}, csrf = false) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: {
      cookie: cookieHeader(jar),
      ...(csrf ? { 'x-csrf-token': jar.nuzm_csrf ?? '' } : {}),
    },
  });
const register = (email = fresh(), password = PW, extra: object = {}) =>
  post('/v1/auth/register', { email, password, ...extra });
const login = (email: string, password: string) =>
  post('/v1/auth/password/login', { email, password });
const me = (jar: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: cookieHeader(jar) } });
/** The problem body without the per-request trace members. */
const shape = (r: { json: () => Record<string, unknown> }) =>
  Object.fromEntries(Object.entries(r.json()).filter(([k]) => !/trace|instance/i.test(k)));
const lastMail = (template: string, to: string) =>
  [...mailer.sent].reverse().find((m) => m.template === template && m.to === to) as
    { data: { token: string } } | undefined;

beforeAll(async () => {
  await h.init();
  const b = await h.buildApp({ PASSWORD_SCRYPT_LOG_N: '12', PASSWORD_LOCK_THRESHOLD: '3' });
  app = b.app;
  mailer = b.mailer;
  sink = b.sink;
});
afterAll(() => h.close());

describe('registration', () => {
  it('creates the account, signs it in, stores a hash only and mails a verification token', async () => {
    const email = `  Layla.${fresh().toUpperCase()}`;
    const res = await register(email, PW, { displayName: 'Layla', locale: 'en' });
    expect(res.statusCode).toBe(201);
    const norm = email.trim().toLowerCase();
    expect(res.json()).toMatchObject({
      email: norm,
      emailVerified: false,
      displayName: 'Layla',
      locale: 'en',
    });
    const set = [res.headers['set-cookie']].flat().join('\n');
    expect(set).toMatch(/nuzm_session=nzs_[^;]+; .*HttpOnly/);
    expect(set).toMatch(/nuzm_csrf=nzc_/);
    const jar = jarFrom(res);
    const who = await me(jar);
    expect(who.statusCode).toBe(200);
    expect(who.json()).toMatchObject({ email: norm, isPlatformUser: false, memberships: [] });

    const [row] = await sql(
      `SELECT u.issuer, u.email_verified, k.password_hash FROM identity.users u
         JOIN identity.credentials k ON k.user_id=u.id WHERE u.email=$1`,
      [norm],
    );
    expect(row).toMatchObject({ issuer: 'nuzm:local', email_verified: false });
    expect(row?.password_hash).toMatch(/^scrypt\$4096\$8\$1\$/);
    expect(JSON.stringify(await sql(`SELECT * FROM identity.credentials`))).not.toContain(PW);

    const mail = lastMail('email_verification', norm);
    expect(mail?.data.token).toMatch(/^nzt_/);
    // only the hash of the token is stored
    expect(JSON.stringify(await sql(`SELECT * FROM identity.auth_tokens`))).not.toContain(
      mail!.data.token,
    );
    const ev = sink.events.find((e) => e.action === 'auth.account.registered');
    expect(ev).toBeTruthy();
    expect(JSON.stringify(sink.events)).not.toContain(PW);
  });

  it('refuses a duplicate email in any letter case (409) and an invalid email or weak password (422)', async () => {
    const email = fresh();
    expect((await register(email)).statusCode).toBe(201);
    const dup = await register(email.toUpperCase());
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code ?? dup.json().type).toMatch(/email_in_use/);
    expect((await register('not-an-email')).statusCode).toBe(422);
    expect((await register(fresh(), 'short')).statusCode).toBe(422);
    expect((await register(fresh(), 'password1234')).statusCode).toBe(422);
    const same = fresh();
    expect((await register(same, same)).statusCode).toBe(422);
    expect((await register(fresh(), 'x'.repeat(129))).statusCode).toBe(422);
  });

  it('still creates the account when the verification mail cannot be sent', async () => {
    mailer.failNext = true;
    const email = fresh();
    expect((await register(email)).statusCode).toBe(201);
    expect(sink.events.some((e) => e.action === 'auth.email.mail_failed')).toBe(true);
    expect(lastMail('email_verification', email)).toBeUndefined();
  });

  it('two simultaneous registrations of one email produce exactly one account', async () => {
    const email = fresh();
    const rs = await Promise.all([register(email), register(email), register(email)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await sql(`SELECT 1 FROM identity.users WHERE email=$1`, [email])).toHaveLength(1);
  });
});

describe('password sign-in', () => {
  it('signs in with the right password, mints a fresh session and revokes the presented one', async () => {
    const email = fresh();
    const reg = await register(email);
    const first = jarFrom(reg);
    const res = await post(
      '/v1/auth/password/login',
      { email: email.toUpperCase(), password: PW },
      first,
    );
    expect(res.statusCode).toBe(200);
    const second = jarFrom(res, {});
    expect(second.nuzm_session).not.toBe(first.nuzm_session);
    expect((await me(second)).statusCode).toBe(200);
    expect((await me(first)).statusCode).toBe(401);
  });

  it('answers a wrong password, an unknown email and a platform user identically', async () => {
    const email = fresh();
    await register(email);
    const wrong = await login(email, 'not the password at all');
    const unknown = await login(fresh(), PW);
    const [created] = await sql(
      `INSERT INTO identity.users (id, issuer, subject, email, is_platform_user)
       VALUES (gen_random_uuid(),'nuzm:local','staff-x','staff-x@example.test', true) RETURNING id`,
    );
    expect(created?.id).toBeTruthy();
    const staff = await login('staff-x@example.test', PW);
    for (const r of [wrong, unknown, staff]) expect(r.statusCode).toBe(401);
    expect(shape(wrong)).toEqual(shape(unknown));
    expect(shape(wrong)).toEqual(shape(staff));
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('a platform user can never have a password (database refuses it)', async () => {
    const [created] = await sql(
      `INSERT INTO identity.users (id, issuer, subject, email, is_platform_user)
       VALUES (gen_random_uuid(),'nuzm:local','staff-y','staff-y@example.test', true) RETURNING id`,
    );
    await expect(
      sql(`INSERT INTO identity.credentials (user_id, password_hash) VALUES ($1,'x')`, [
        created?.id,
      ]),
    ).rejects.toThrow(/platform users cannot have a password/);
  });

  it('locks after 3 failures (configured), even for the right password, and unlocks when the lock ends', async () => {
    const email = fresh();
    await register(email);
    for (let i = 0; i < 3; i++)
      expect((await login(email, `wrong password ${i} xx`)).statusCode).toBe(401);
    const locked = await login(email, PW);
    expect(locked.statusCode).toBe(401);
    expect(shape(locked)).toEqual(shape(await login(fresh(), PW)));
    expect(
      sink.events.some((e) => e.action === 'auth.login.failed' && e.detail?.reason === 'locked'),
    ).toBe(true);
    await sql(
      `UPDATE identity.credentials SET locked_until = now() - interval '1 second'
        WHERE user_id = (SELECT id FROM identity.users WHERE email=$1)`,
      [email],
    );
    expect((await login(email, PW)).statusCode).toBe(200);
    const [c] = await sql(
      `SELECT failed_attempts, locked_until FROM identity.credentials
        WHERE user_id=(SELECT id FROM identity.users WHERE email=$1)`,
      [email],
    );
    expect(c).toMatchObject({ failed_attempts: 0, locked_until: null });
  });

  it('refuses a disabled user and malformed input without a session', async () => {
    const email = fresh();
    await register(email);
    await sql(`UPDATE identity.users SET status='disabled' WHERE email=$1`, [email]);
    expect((await login(email, PW)).statusCode).toBe(401);
    expect((await post('/v1/auth/password/login', {})).statusCode).toBe(401);
    expect((await post('/v1/auth/password/login', { email: 5, password: [] })).statusCode).toBe(
      401,
    );
  });

  it('is rate limited per client address', async () => {
    const limited = await h.buildApp({ PASSWORD_SCRYPT_LOG_N: '12', LOGIN_RATE_PER_MINUTE: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push(
        (
          await limited.app.inject({
            method: 'POST',
            url: '/v1/auth/password/login',
            payload: { email: 'x@example.test', password: 'whatever password' },
          })
        ).statusCode,
      );
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});

describe('password reset', () => {
  it('always answers 202, mails only known accounts, and a token works once', async () => {
    const email = fresh();
    const reg = await register(email);
    const old = jarFrom(reg);
    const before = mailer.sent.length;
    expect((await post('/v1/auth/password/forgot', { email: fresh() })).statusCode).toBe(202);
    expect((await post('/v1/auth/password/forgot', { email: 12 })).statusCode).toBe(202);
    expect(mailer.sent.length).toBe(before);
    expect((await post('/v1/auth/password/forgot', { email })).statusCode).toBe(202);
    const token = lastMail('password_reset', email)!.data.token;

    const weak = await post('/v1/auth/password/reset', { token, newPassword: 'short' });
    expect(weak.statusCode).toBe(422); // does not consume the token
    const NEW = 'a brand new passphrase 77';
    expect((await post('/v1/auth/password/reset', { token, newPassword: NEW })).statusCode).toBe(
      204,
    );
    expect(
      (await post('/v1/auth/password/reset', { token, newPassword: NEW + '!' })).statusCode,
    ).toBe(400);
    expect((await me(old)).statusCode).toBe(401); // every session revoked
    expect((await login(email, PW)).statusCode).toBe(401);
    expect((await login(email, NEW)).statusCode).toBe(200);
  });

  it('a new request cancels the earlier token; an expired or unknown token is 400; a reset clears a lock', async () => {
    const email = fresh();
    await register(email);
    await post('/v1/auth/password/forgot', { email });
    const first = lastMail('password_reset', email)!.data.token;
    await post('/v1/auth/password/forgot', { email });
    const second = lastMail('password_reset', email)!.data.token;
    expect(second).not.toBe(first);
    const NEW = 'yet another passphrase 9';
    expect(
      (await post('/v1/auth/password/reset', { token: first, newPassword: NEW })).statusCode,
    ).toBe(400);
    expect(
      (await post('/v1/auth/password/reset', { token: 'nzt_' + 'x'.repeat(40), newPassword: NEW }))
        .statusCode,
    ).toBe(400);
    expect((await post('/v1/auth/password/reset', { token: 5, newPassword: NEW })).statusCode).toBe(
      400,
    );
    await sql(
      `UPDATE identity.auth_tokens SET expires_at = now() - interval '1 minute' WHERE purpose='password_reset' AND used_at IS NULL
        AND user_id=(SELECT id FROM identity.users WHERE email=$1)`,
      [email],
    );
    expect(
      (await post('/v1/auth/password/reset', { token: second, newPassword: NEW })).statusCode,
    ).toBe(400);

    for (let i = 0; i < 3; i++) await login(email, `wrong password ${i} xx`);
    await post('/v1/auth/password/forgot', { email });
    const third = lastMail('password_reset', email)!.data.token;
    expect(
      (await post('/v1/auth/password/reset', { token: third, newPassword: NEW })).statusCode,
    ).toBe(204);
    expect((await login(email, NEW)).statusCode).toBe(200);
  });

  it('two simultaneous uses of one token succeed once', async () => {
    const email = fresh();
    await register(email);
    await post('/v1/auth/password/forgot', { email });
    const token = lastMail('password_reset', email)!.data.token;
    const rs = await Promise.all(
      [1, 2, 3].map((i) =>
        post('/v1/auth/password/reset', { token, newPassword: `race passphrase number ${i}` }),
      ),
    );
    expect(rs.map((r) => r.statusCode).sort()).toEqual([204, 400, 400]);
  });
});

describe('email verification', () => {
  it('verifies once, then the token is spent; resending needs a session and cancels the old token', async () => {
    const email = fresh();
    const reg = await register(email);
    const jar = jarFrom(reg);
    const t1 = lastMail('email_verification', email)!.data.token;

    expect((await post('/v1/auth/email/verification/resend', {})).statusCode).toBe(401);
    expect((await post('/v1/auth/email/verification/resend', {}, jar, false)).statusCode).toBe(403); // csrf
    const re = await post('/v1/auth/email/verification/resend', {}, jar, true);
    expect(re.statusCode).toBe(202);
    const t2 = lastMail('email_verification', email)!.data.token;
    expect(t2).not.toBe(t1);
    expect((await post('/v1/auth/email/verification', { token: t1 })).statusCode).toBe(400);
    expect((await post('/v1/auth/email/verification', { token: t2 })).statusCode).toBe(204);
    expect((await post('/v1/auth/email/verification', { token: t2 })).statusCode).toBe(400);
    expect((await me(jar)).json().emailVerified).toBe(true);
    expect((await post('/v1/auth/email/verification/resend', {}, jar, true)).statusCode).toBe(204);
  });

  it('a verification token cannot be used as a reset token or the other way round', async () => {
    const email = fresh();
    await register(email);
    const v = lastMail('email_verification', email)!.data.token;
    expect(
      (await post('/v1/auth/password/reset', { token: v, newPassword: 'cross purpose passphrase' }))
        .statusCode,
    ).toBe(400);
    await post('/v1/auth/password/forgot', { email });
    const r = lastMail('password_reset', email)!.data.token;
    expect((await post('/v1/auth/email/verification', { token: r })).statusCode).toBe(400);
  });
});

describe('change password', () => {
  it('needs the current password and CSRF; keeps this session and revokes the others', async () => {
    const email = fresh();
    const a = jarFrom(await register(email));
    const b = jarFrom(await login(email, PW), {});
    const NEW = 'changed passphrase 4242';
    expect(
      (await post('/v1/auth/password/change', { currentPassword: PW, newPassword: NEW }, b, false))
        .statusCode,
    ).toBe(403);
    const bad = await post(
      '/v1/auth/password/change',
      { currentPassword: 'nope nope nope', newPassword: NEW },
      b,
      true,
    );
    expect(bad.statusCode).toBe(401);
    expect(
      (
        await post(
          '/v1/auth/password/change',
          { currentPassword: PW, newPassword: 'short' },
          b,
          true,
        )
      ).statusCode,
    ).toBe(422);
    expect(
      (await post('/v1/auth/password/change', { currentPassword: PW, newPassword: NEW }, b, true))
        .statusCode,
    ).toBe(204);
    expect((await me(b)).statusCode).toBe(200);
    expect((await me(a)).statusCode).toBe(401);
    expect((await login(email, PW)).statusCode).toBe(401);
    expect((await login(email, NEW)).statusCode).toBe(200);
    expect(JSON.stringify(sink.events)).not.toContain(NEW);
  });

  it('an account created through the identity provider has no password to change', async () => {
    h.idp.user = { sub: 'sso-only', email: 'sso-only@example.test', email_verified: true };
    const { jar } = await h.login(app);
    const r = await post(
      '/v1/auth/password/change',
      { currentPassword: PW, newPassword: 'whatever passphrase 1' },
      jar,
      true,
    );
    expect(r.statusCode).toBe(403);
  });
});
