/**
 * DEV ONLY: runs the API against the project-local Postgres with an in-process dev IdP (a user picker), so the
 * portals can be exercised end to end without a real identity provider (D-04 is still open).
 *   pnpm --filter @nuzm/api dev:stack
 * Refuses to run in production or against a non-local database.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { rewritePreviewUrl } from '../modules/builder/isolation';
import { configureApp } from '../app.setup';
import { TestIdp } from '../modules/identity/testing/test-idp';
import { startDomainsDevMocks } from './domains-dev';

if (process.env.NODE_ENV === 'production') throw new Error('dev stack must not run in production');

/** The dev secret store is sealed with this key, so it must survive restarts or enrolled TOTP secrets become unreadable. */
function devSealKey(): string {
  if (process.env.SESSION_SEAL_KEY) return process.env.SESSION_SEAL_KEY;
  const dir = join(process.cwd(), '.dev-vault');
  const file = join(dir, 'dev-seal-key');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}
if (process.env.NUZM_FORBID_DEFAULT_DB === '1' && !process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is mandatory in a leased test environment (no default database)');
const dbUrl =
  process.env.DATABASE_URL ?? 'postgres://nuzm_app:nuzm_dev_only@127.0.0.1:54329/nuzm_dev';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(dbUrl))
  throw new Error('dev stack needs a local database');

const idp = new TestIdp();
idp.pickable = process.env.DEV_IDP_USERS
  ? (JSON.parse(process.env.DEV_IDP_USERS) as NonNullable<typeof idp.pickable>)
  : [
      { sub: 'dev-owner', email: 'owner@example.test', name: 'Layla Owner' },
      { sub: 'dev-viewer', email: 'viewer@example.test', name: 'Omar Viewer' },
      { sub: 'dev-staff', email: 'staff@example.test', name: 'Sara Staff' },
    ];

async function main() {
  await idp.start(Number(process.env.DEV_IDP_PORT ?? 4010));
  const web = process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3000';
  const admin = process.env.ADMIN_ORIGIN ?? 'http://127.0.0.1:3001';
  Object.assign(process.env, {
    DATABASE_URL: dbUrl,
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_CLIENT_SECRET: idp.clientSecret,
    OIDC_REDIRECT_URI: `${web}/v1/auth/oidc/callback`, // proxied by the web app; shared by both consoles in dev
    RETURN_TO_ORIGINS: `${web},${admin}`,
    SESSION_SEAL_KEY: devSealKey(),
    LOGIN_RATE_PER_MINUTE: '1000',
  });
  // The builder preview needs an address the browser can resolve and an edge that maps it to the preview path: `*.localhost` resolves to this machine in every
  // modern browser, and the rewrite below is the edge. (Production keeps its own domain, https and a real edge.)
  process.env.BUILDER_PREVIEW_DOMAIN ??= 'preview.localhost';
  process.env.BUILDER_PREVIEW_SCHEME ??= 'http';
  process.env.BUILDER_PREVIEW_PORT ??= String(process.env.PORT ?? 4000);
  process.env.BUILDER_CONSOLE_ORIGIN ??= 'http://localhost:3000 http://127.0.0.1:3000';
  const previewDomain = process.env.BUILDER_PREVIEW_DOMAIN;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      rewriteUrl: (req: IncomingMessage | Http2ServerRequest) =>
        rewritePreviewUrl(req.headers.host, req.url ?? '/', previewDomain),
    }),
    {
      logger: ['error', 'warn'],
      rawBody: true, // webhook signatures are computed over the exact request bytes
    },
  );
  await configureApp(app);
  const mocks = process.env.DOMAINS_DEV_MOCKS === 'true' ? await startDomainsDevMocks(app) : null;
  await app.listen(Number(process.env.PORT ?? 4000), '127.0.0.1');
  console.log(
    JSON.stringify({
      devStack: 'ready',
      api: 'http://127.0.0.1:4000',
      idp: idp.issuer,
      web,
      admin,
      ...(mocks ? { domainMocks: mocks } : {}),
    }),
  );
}
void main();
