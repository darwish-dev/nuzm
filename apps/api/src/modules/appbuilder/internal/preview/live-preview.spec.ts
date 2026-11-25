import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@nuzm/platform';
import { LivePreviewRegistry } from '../../../builder';
import { loadBuilderConfig } from '../../../builder';
import { CRM_SPEC } from '../fixtures/crm-appspec';
import type { AppSpecService } from '../spec/spec.service';
import { DEFAULT_LIVE_PREVIEW, WebappLivePreviewService } from './live-preview.service';

const ORG = '01a1f444-2b63-76c9-9eac-788bdccc7efc';
const PROJECT = '01a1f97c-1a9b-71ee-a132-002abe7b5c19';
const cfg = loadBuilderConfig({
  BUILDER_PREVIEW_DOMAIN: 'preview.localhost',
  BUILDER_PREVIEW_SCHEME: 'http',
  BUILDER_PREVIEW_PORT: '4000',
  BUILDER_CONSOLE_ORIGIN: 'http://localhost:3000',
} as NodeJS.ProcessEnv);
const flagDb = (on: boolean) =>
  ({ withOrg: async () => (on ? { value: true } : undefined) }) as unknown as Db;
const specs = {
  get: async () => ({ version: 3, spec: CRM_SPEC }),
} as unknown as AppSpecService;
const audit = { events: [] as unknown[], record: async (e: unknown) => void audit.events.push(e) };
const registry = new LivePreviewRegistry(cfg);
const svc = (on = true) =>
  new WebappLivePreviewService(flagDb(on), audit as never, specs, registry, {
    ...DEFAULT_LIVE_PREVIEW,
    ttlMs: 120_000,
  });
// R5 (P3-S02): the preview runs template code on the API host, so the host-exec guard needs the explicit local-development opt-in (like the other host-runner specs)
const savedOptIn = process.env.NUZM_LOCAL_DEV_EXEC;
beforeAll(() => {
  process.env.NUZM_LOCAL_DEV_EXEC = '1';
});
afterAll(() => {
  registry.stopAll();
  if (savedOptIn === undefined) delete process.env.NUZM_LOCAL_DEV_EXEC;
  else process.env.NUZM_LOCAL_DEV_EXEC = savedOptIn;
});

const tokenOf = (url: string) => new URL(url).hostname.split('.')[0]!;
const sessionOf = (url: string) =>
  decodeURIComponent(new URL(url).hash.slice('#/autologin='.length));
const hostOf = (url: string) => new URL(url).hostname;

describe('live preview of a generated web app', () => {
  it('is refused while the flag is off', async () => {
    await expect(svc(false).start(ORG, 'u', PROJECT)).rejects.toMatchObject({
      code: 'feature_disabled',
    });
  });

  it('runs the app on the isolated origin: front end, signed-in API with sample data, no console credentials, wrong host refused', async () => {
    const p = await svc().start(ORG, 'u', PROJECT);
    expect(p.specVersion).toBe(3);
    expect(p.url).toMatch(/^http:\/\/[a-z2-7]{32}\.preview\.localhost:4000\/#\/autologin=/);
    expect(audit.events).toContainEqual(
      expect.objectContaining({ action: 'builder.webapp_preview.started' }),
    );
    const token = tokenOf(p.url);
    const host = hostOf(p.url);
    const get = (path: string, h: Record<string, string> = {}) =>
      registry.proxy(host, token, 'GET', path, '', h, undefined);

    const index = await get('');
    expect(index.status).toBe(200);
    expect(String(index.body)).toContain('/app.js');
    expect(index.headers['content-security-policy']).toContain(
      'frame-ancestors http://localhost:3000',
    );
    const meta = JSON.parse(String((await get('meta.json')).body));
    expect(meta).toMatchObject({ preview: true, authHeader: 'x-preview-authorization' });

    // the app's own API: the preview header is the app's session; the console's authorization header never reaches it
    const auth = { 'x-preview-authorization': `Bearer ${sessionOf(p.url)}` };
    const list = await get('api/v1/accounts', auth);
    expect(list.status).toBe(200);
    expect(JSON.parse(String(list.body)).total).toBeGreaterThan(0); // sample data
    expect(
      (await get('api/v1/accounts', { authorization: auth['x-preview-authorization'] })).status,
    ).toBe(401);

    // writes work too
    const created = await registry.proxy(
      host,
      token,
      'POST',
      'api/v1/accounts',
      '',
      { ...auth, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      Buffer.from(JSON.stringify({ name: 'Preview Co' })),
    );
    expect(created.status).toBe(201);

    // another host, or an unknown token, is a plain 404
    expect((await registry.proxy('evil.example', token, 'GET', '', '', {}, undefined)).status).toBe(
      404,
    );
    expect((await registry.proxy(host, 'a'.repeat(32), 'GET', '', '', {}, undefined)).status).toBe(
      404,
    );

    // a new preview of the same project replaces the old one
    const p2 = await svc().start(ORG, 'u', PROJECT);
    expect(registry.has(token)).toBe(false);
    expect(registry.has(tokenOf(p2.url))).toBe(true);
    svc().stop(ORG, PROJECT);
    expect(registry.has(tokenOf(p2.url))).toBe(false);
  }, 60_000);
});
