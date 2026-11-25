import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../../../common/secrets';
import type { DomainsConfig } from './ports';
import { RegistrarAdminService } from './registrar-admin.service';
import type { RegistrarAccount } from './registrar-access.service';

const ADMIN = '22222222-2222-4222-8222-222222222222';
const KEY = 'dnet-test-key-1234567890';
const API_SECRET_VALUE = 'dnet-test-secret-abcdefgh';

/** A recording stand-in for the database and the account reads: the saved DNet account is kept in memory. */
function setup() {
  let account: RegistrarAccount | null = null;
  const queries: { sql: string; params: unknown[] }[] = [];
  const events: Record<string, unknown>[] = [];
  const db = {
    withPlatformScope: async (
      fn: (c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }) => unknown,
    ) =>
      fn({
        query: async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (/FROM domains.registrars/i.test(sql)) return { rows: [{ id: 'reg-dnet' }] };
          if (/^\s*INSERT/i.test(sql)) {
            account = {
              id: params[0] as string,
              registrarId: 'reg-dnet',
              providerCode: 'dnet',
              label: params[2] as string,
              environment: params[3] as 'sandbox',
              vaultRef: params[4] as string,
              webhookSecretRef: null,
              dataRegion: params[5] as string,
              providerRegionId: null,
              currency: params[6] as string,
              priority: 100,
              enabled: false,
              registrarEnabled: false,
              health: 'unknown',
              capabilities: {},
              tldSupport: [],
              settings: JSON.parse(params[7] as string),
              evidenceKind: null,
              probedAt: null,
            };
          }
          if (/^\s*UPDATE/i.test(sql) && account) {
            account = {
              ...account,
              label: params[1] as string,
              environment: params[2] as 'sandbox',
              dataRegion: params[3] as string,
              currency: params[4] as string,
              settings: JSON.parse(params[5] as string),
              vaultRef: (params[6] as string | null) ?? account.vaultRef,
              enabled: false,
            };
          }
          return { rows: [] };
        },
      }),
  };
  const access = {
    listAccounts: async () => (account ? [account] : []),
    getAccount: async () => account,
  };
  const secrets = new MemorySecretStore();
  const svc = new RegistrarAdminService(
    db as never,
    access as never,
    { record: (e: Record<string, unknown>) => void events.push(e) } as never,
    {} as DomainsConfig,
    secrets,
  );
  return { svc, secrets, queries, events, get: () => account };
}

const base = { environment: 'sandbox', baseUrl: 'https://api.example.test/v1/' };
const prodEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = prodEnv;
});

describe('DNet settings (admin)', () => {
  it('creates the account on the first save with the non-secret settings and no credential yet', async () => {
    const { svc } = setup();
    const r = await svc.saveDnetSettings(ADMIN, { ...base, resellerId: 'R-77', timeoutMs: 20000 });
    expect(r.providerCode).toBe('dnet');
    expect(r.settings).toEqual({
      baseUrl: 'https://api.example.test/v1',
      resellerId: 'R-77',
      timeoutMs: 20000,
    });
    expect(r.credentialStored).toBe(false);
    expect(r.enabled).toBe(false);
    expect(r.dataRegion).toBe('SA');
    expect(r.currency).toBe('SAR');
  });

  it('typed credentials go to the sealed store; only the reference reaches the database, the audit and the response', async () => {
    const { svc, secrets, queries, events } = setup();
    const r = await svc.saveDnetSettings(ADMIN, {
      ...base,
      credentials: { apiKey: KEY, apiSecret: API_SECRET_VALUE },
    });
    expect(r.credentialStored).toBe(true);
    expect(r.vaultRef).toMatch(/^vault:\/\/mem\/domains-dnet-/);
    expect(JSON.parse(await secrets.get(r.vaultRef))).toEqual({
      apiKey: KEY,
      apiSecret: API_SECRET_VALUE,
    });
    const everything = JSON.stringify([queries, events, r]);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(API_SECRET_VALUE);
    expect(events[0]).toMatchObject({ action: 'registrar.dnet.settings_saved' });
  });

  it('a second save updates the same account and disables it again', async () => {
    const { svc, get } = setup();
    const a = await svc.saveDnetSettings(ADMIN, { ...base, credentials: { apiKey: KEY } });
    const b = await svc.saveDnetSettings(ADMIN, { ...base, timeoutMs: 30000, label: 'DNet KSA' });
    expect(b.id).toBe(a.id);
    expect(b.label).toBe('DNet KSA');
    expect(b.settings.timeoutMs).toBe(30000);
    expect(b.credentialStored).toBe(true); // the stored credential stays when none is sent
    expect(get()!.enabled).toBe(false);
  });

  it('refuses typed credentials in production (D-12) but accepts a vault reference', async () => {
    const { svc } = setup();
    process.env.NODE_ENV = 'production';
    await expect(
      svc.saveDnetSettings(ADMIN, {
        ...base,
        environment: 'production',
        credentials: { apiKey: KEY },
      }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    const r = await svc.saveDnetSettings(ADMIN, {
      ...base,
      environment: 'production',
      vaultRef: 'vault://prod/dnet',
    });
    expect(r.credentialStored).toBe(true);
    expect(r.vaultRef).toBe('vault://prod/dnet');
  });

  it.each([
    ['an http URL', { ...base, baseUrl: 'http://api.example.test' }],
    ['a URL with credentials', { ...base, baseUrl: 'https://u:p@api.example.test' }],
    ['a URL with a query', { ...base, baseUrl: 'https://api.example.test/?k=1' }],
    ['an unknown field', { ...base, apiKey: KEY }],
    ['a bad environment', { ...base, environment: 'staging' }],
    ['a timeout out of range', { ...base, timeoutMs: 10 }],
    ['a reseller id with spaces', { ...base, resellerId: 'a b' }],
    ['a short key', { ...base, credentials: { apiKey: 'short' } }],
    [
      'key and vault reference together',
      { ...base, credentials: { apiKey: KEY }, vaultRef: 'vault://x/y' },
    ],
  ])('rejects %s', async (_n, body) => {
    const { svc } = setup();
    await expect(svc.saveDnetSettings(ADMIN, body as Record<string, unknown>)).rejects.toBeTruthy();
  });

  it('rejects a vault reference that is not a vault:// reference as a credential value', async () => {
    const { svc } = setup();
    await expect(svc.saveDnetSettings(ADMIN, { ...base, vaultRef: KEY })).rejects.toMatchObject({
      code: 'credential_value_rejected',
    });
  });
});
