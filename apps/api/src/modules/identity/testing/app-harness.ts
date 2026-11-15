import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createEnv, type TestEnv } from '@nuzm/platform/testing';
import type { Type } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { configureApp } from '../../../app.setup';
import { AuditSink, type AuditEvent } from '../../../common/audit';
import { MemorySecretStore, SecretStore } from '../../../common/secrets';
import { applyTestIdentityEnv } from './env';
import { TestIdp } from './test-idp';

export class MemorySink extends AuditSink {
  events: AuditEvent[] = [];
  record(e: AuditEvent) {
    this.events.push(e);
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
  ) {
    applyTestIdentityEnv(issuer ?? this.idp.issuer, {
      LOGIN_RATE_PER_MINUTE: '100000',
      ...overrides,
    });
    process.env.DATABASE_URL = this.env.appUrl;
    const sink = new MemorySink();
    const secrets = new MemorySecretStore();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers })
      .overrideProvider(AuditSink)
      .useValue(sink)
      .overrideProvider(SecretStore)
      .useValue(secrets)
      .compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    this.apps.push(app);
    return { app, sink, secrets };
  }

  /** login → IdP authorize → callback; returns the cookie jar. */
  async login(app: App, returnTo = '/dashboard', jar: Record<string, string> = {}) {
    const r1 = await app.inject({
      method: 'GET',
      url: `/v1/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`,
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
    method: 'GET' | 'POST' | 'DELETE',
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
