import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createEnv, type TestEnv } from '@nuzm/platform/testing';
import type { Type } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { AuditSink, type AuditEvent } from '../../../common/audit';
import { Mailer, type MailMessage } from '../../../common/mailer';
import { MemorySecretStore, SecretStore } from '../../../common/secrets';
import { SessionService } from '../index';
import { createHash } from 'node:crypto';
import { applyTestIdentityEnv } from './env';
import { TestIdp } from './test-idp';

export class MemorySink extends AuditSink {
  events: AuditEvent[] = [];
  record(e: AuditEvent) {
    this.events.push(e);
  }
}

export class MemoryMailer extends Mailer {
  sent: MailMessage[] = [];
  failNext = false;
  async send(m: MailMessage) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('smtp down');
    }
    this.sent.push(m);
  }
}

export type App = NestFastifyApplication;
export const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
export const jarFrom = (
  res: { cookies: { name: string; value: string }[] },
  into: Record<string, string> = {},
) => {
  for (const c of res.cookies) into[c.name] = c.value;
  return into;
};

export class Harness {
  env!: TestEnv;
  idp = new TestIdp();
  apps: App[] = [];

  async init() {
    this.env = await createEnv();
    await this.idp.start();
  }

  async buildApp(
    overrides: Record<string, string> = {},
    issuer?: string,
    controllers: Type[] = [],
    opts: { realAudit?: boolean; overrides?: [unknown, unknown][] } = {},
  ) {
    applyTestIdentityEnv(issuer ?? this.idp.issuer, {
      LOGIN_RATE_PER_MINUTE: '100000',
      ...overrides,
    });
    process.env.DATABASE_URL = this.env.appUrl;
    const sink = new MemorySink();
    const secrets = new MemorySecretStore();
    const mailer = new MemoryMailer();
    const builder = Test.createTestingModule({ imports: [AppModule], controllers });
    // Real audit = the hash-chained DB sink (audit/admin tests); default = in-memory sink for fast assertions.
    if (!opts.realAudit) builder.overrideProvider(AuditSink).useValue(sink);
    for (const [token, value] of opts.overrides ?? [])
      builder.overrideProvider(token as never).useValue(value);
    const moduleRef = await builder
      .overrideProvider(SecretStore)
      .useValue(secrets)
      .overrideProvider(Mailer)
      .useValue(mailer)
      .compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      rawBody: true,
    });
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    this.apps.push(app);
    return { app, sink, secrets, mailer };
  }

  /** login → IdP authorize → callback; returns the cookie jar. */
  async login(
    app: App,
    returnTo = '/dashboard',
    jar: Record<string, string> = {},
    realm?: 'web' | 'admin',
  ) {
    const r1 = await app.inject({
      method: 'GET',
      url: `/v1/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}${realm ? `&realm=${realm}` : ''}`,
      headers: { cookie: cookieHeader(jar) },
    });
    if (r1.statusCode !== 302) return { r1, r2: r1, back: new URL('http://x'), jar };
    const idpRes = await fetch(r1.headers.location as string, { redirect: 'manual' });
    const back = new URL(idpRes.headers.get('location')!);
    const r2 = await app.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback${back.search}`,
      headers: { cookie: cookieHeader({ ...jar, ...jarFrom(r1) }) },
    });
    return { r1, r2, back, jar: jarFrom(r2, { ...jar, ...jarFrom(r1) }) };
  }

  authed(
    app: App,
    jar: Record<string, string>,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    opts: { csrf?: boolean; body?: unknown } = {},
  ) {
    return app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(jar),
        ...(opts.csrf === false
          ? {}
          : { 'x-csrf-token': jar.nuzm_csrf ?? jar.nuzm_admin_csrf ?? '' }),
      },
      ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    });
  }

  /** Close one app early (e.g. a short-lived app inside a test); the harness will not close it again. */
  /** Create a user row directly (verified email) and return its id. */
  async createUser(
    sub: string,
    opts: { emailVerified?: boolean; email?: string } = {},
  ): Promise<string> {
    const r = await this.env.sql(
      `INSERT INTO identity.users (id, issuer, subject, email, email_verified) VALUES (gen_random_uuid(), 'test', $1, $2, $3) RETURNING id`,
      [sub, opts.email ?? `${sub}@example.test`, opts.emailVerified ?? true],
    );
    return r[0]!.id as string;
  }

  /** A signed-in web session for a user without going through OIDC (OIDC itself is tested separately). */
  async sessionFor(app: App, userId: string): Promise<Record<string, string>> {
    const s = await app.get(SessionService).create(userId, 'web', {});
    return { nuzm_session: s.token, nuzm_csrf: s.csrf };
  }

  /** Mark a session as recently MFA-verified (satisfies @StepUp()). */
  async elevate(jar: Record<string, string>) {
    const hash = createHash('sha256')
      .update((jar.nuzm_session ?? jar.nuzm_admin_session)!)
      .digest('hex');
    await this.env.sql(
      `UPDATE identity.sessions SET mfa_level='totp', mfa_verified_at=now() WHERE token_hash=$1`,
      [hash],
    );
  }

  /** A platform (staff) user with the given platform roles and an MFA-verified admin-realm session. */
  async platformUser(app: App, sub: string, roles: string[]) {
    const id = await this.createUser(sub);
    await this.env.sql(`UPDATE identity.users SET is_platform_user = true WHERE id = $1`, [id]);
    for (const r of roles)
      await this.env.sql(`INSERT INTO tenancy.platform_roles (user_id, role) VALUES ($1, $2)`, [
        id,
        r,
      ]);
    const s = await app.get(SessionService).create(id, 'admin', {});
    const jar = { nuzm_admin_session: s.token, nuzm_admin_csrf: s.csrf };
    await this.elevate(jar);
    return { id, jar };
  }

  async closeApp(app: App) {
    this.apps = this.apps.filter((a) => a !== app);
    await app.close();
  }

  async close() {
    for (const a of this.apps) await a.close().catch(() => undefined);
    await this.idp.stop();
    await this.env.close();
  }
}
