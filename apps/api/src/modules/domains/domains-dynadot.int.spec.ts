import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DynadotAdapter, startDynadotMock, type DynadotMock } from '@nuzm/adapter-dynadot';
import { FetchHttpClient } from '@nuzm/registrar-contracts';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { ADAPTER_FACTORIES, type AdapterFactory } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
const h = new Harness();
let app: App;
let mock: DynadotMock;
let jar: Record<string, string>;
let sink: { events: any[] };
const admin = (method: 'GET' | 'PUT' | 'POST', url: string, body?: object) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jar),
      'x-csrf-token': jar.nuzm_admin_csrf!,
      ...(method === 'POST' ? { 'idempotency-key': `k-${Math.random()}` } : {}),
    },
    ...(body ? { payload: body } : {}),
  });

beforeAll(async () => {
  process.env.DOMAINS_ENABLED = 'true';
  process.env.DOMAINS_ALLOW_NON_LIVE_REGISTRARS = 'true';
  await h.init();
  mock = await startDynadotMock();
  const factories: Record<string, AdapterFactory> = {
    // the REAL adapter against the local mock (same code path as production, loopback egress); credentials come from the sealed vault the admin API wrote
    dynadot: (a, d) =>
      new DynadotAdapter({
        baseUrl: mock.url,
        http: new FetchHttpClient({
          adapterId: 'dynadot',
          hosts: ['127.0.0.1'],
          allowLoopback: true,
        }),
        vault: d.vault,
        evidenceKind: 'mock',
        currency: a.currency,
        searchBatch: typeof a.settings.searchBatch === 'number' ? a.settings.searchBatch : 1,
      }),
  };
  const built = await h.buildApp({}, undefined, [], {
    realAudit: false,
    overrides: [[ADAPTER_FACTORIES, factories]],
  });
  app = built.app;
  sink = built.sink as unknown as { events: any[] };
  jar = (await h.platformUser(app, 'dyn-root', ['platform_admin'])).jar;
});
afterAll(async () => {
  await h.close();
  await mock.close();
});

describe('Dynadot through the admin console (typed key → sealed → adapter → enabled)', () => {
  let accountId = '';
  it('saves the settings and the typed key; only the reference reaches the database, the response and the audit', async () => {
    const r = await admin('PUT', '/v1/admin/registrars/dynadot', {
      environment: 'sandbox',
      searchBatch: 1,
      credentials: { apiKey: mock.credentials.apiKey },
    });
    expect(r.statusCode).toBe(200);
    const a = r.json();
    accountId = a.id;
    expect(a).toMatchObject({
      providerCode: 'dynadot',
      credentialStored: true,
      enabled: false,
      dataRegion: 'US',
      currency: 'USD',
    });
    expect(a.vaultRef).toMatch(/^vault:\/\/(dev|mem)\/domains-dynadot-/);
    const everything = JSON.stringify([
      a,
      await h.env.sql(`SELECT * FROM domains.registrar_accounts`),
      sink.events,
    ]);
    expect(everything).not.toContain(mock.credentials.apiKey);
    expect(sink.events.some((e) => e.action === 'registrar.dynadot.settings_saved')).toBe(true);
  });

  it('a wrong key fails the connection test and enables nothing', async () => {
    await admin('PUT', '/v1/admin/registrars/dynadot', {
      environment: 'sandbox',
      credentials: { apiKey: 'a-wrong-key-123456' },
    });
    const v = await admin('POST', `/v1/admin/registrars/${accountId}/verification`, {
      enable: true,
    });
    expect(v.statusCode).toBe(422); // search/register are not supported without a working key
    const list = (await admin('GET', '/v1/admin/registrars')).json();
    expect(list.accounts.find((x: any) => x.id === accountId).enabled).toBe(false);
  });

  it('the right key: the probe reads the account, the TLD catalogue, and the account is enabled with NOT VERIFIED (mock) evidence', async () => {
    await admin('PUT', '/v1/admin/registrars/dynadot', {
      environment: 'sandbox',
      credentials: { apiKey: mock.credentials.apiKey },
    });
    const v = await admin('POST', `/v1/admin/registrars/${accountId}/verification`, {
      enable: true,
    });
    expect(v.statusCode).toBe(200);
    const b = v.json();
    expect(b.evidenceKind).toBe('mock');
    expect(b.capabilities['registrar.search']).toBe('supported');
    expect(b.capabilities['registrar.register']).toBe('supported');
    expect(b.capabilities['registrar.dns']).toBe('unsupported');
    expect(b.tlds).toBeGreaterThan(0);
    expect(b.account).toMatchObject({ enabled: true, verification: 'NOT VERIFIED' });
  });

  it('a later save (for example a new batch size) disables the account again until it is re-tested', async () => {
    const r = await admin('PUT', '/v1/admin/registrars/dynadot', {
      environment: 'sandbox',
      searchBatch: 50,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: accountId, enabled: false, credentialStored: true });
    expect(r.json().settings.searchBatch).toBe(50);
  });
});
