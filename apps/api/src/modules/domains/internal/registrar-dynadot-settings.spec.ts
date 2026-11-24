import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../../../common/secrets';
import type { DomainsConfig } from './ports';
import { RegistrarAdminService } from './registrar-admin.service';
import type { RegistrarAccount } from './registrar-access.service';

const ADMIN = '22222222-2222-4222-8222-222222222222';
const KEY = 'dynadot-test-key-1234567890';
const API_SECRET_VALUE = 'dynadot-test-secret-abcdefgh';

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
          if (/FROM domains.registrars/i.test(sql)) return { rows: [{ id: 'reg-dynadot' }] };
          if (/^\s*INSERT/i.test(sql)) {
            account = {
              id: params[0] as string,
              registrarId: 'reg-dynadot',
              providerCode: 'dynadot',
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

const base = { environment: 'sandbox' };
const prodEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = prodEnv;
});

describe('Dynadot settings (admin)', () => {
  it('creates the account on the first save with the documented defaults and no credential yet', async () => {
    const { svc } = setup();
    const r = await svc.saveSettings('dynadot', ADMIN, {
      ...base,
      timeoutMs: 20000,
      searchBatch: 50,
    });
    expect(r.providerCode).toBe('dynadot');
    expect(r.settings).toEqual({ timeoutMs: 20000, searchBatch: 50 });
    expect(r.label).toBe('Dynadot');
    expect(r.dataRegion).toBe('US');
    expect(r.currency).toBe('USD');
    expect(r.credentialStored).toBe(false);
    expect(r.enabled).toBe(false);
  });

  it('typed credentials go to the sealed store; only the reference reaches the database, the audit and the response', async () => {
    const { svc, secrets, queries, events } = setup();
    const r = await svc.saveSettings('dynadot', ADMIN, {
      ...base,
      credentials: { apiKey: KEY, apiSecret: API_SECRET_VALUE },
    });
    expect(r.credentialStored).toBe(true);
    expect(r.vaultRef).toMatch(/^vault:\/\/mem\/domains-dynadot-/);
    expect(JSON.parse(await secrets.get(r.vaultRef))).toEqual({
      apiKey: KEY,
      apiSecret: API_SECRET_VALUE,
    });
    const everything = JSON.stringify([queries, events, r]);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(API_SECRET_VALUE);
    expect(events[0]).toMatchObject({ action: 'registrar.dynadot.settings_saved' });
  });

  it('a second save updates the same account, keeps the stored credential and disables it again', async () => {
    const { svc, get } = setup();
    const a = await svc.saveSettings('dynadot', ADMIN, { ...base, credentials: { apiKey: KEY } });
    const b = await svc.saveSettings('dynadot', ADMIN, {
      ...base,
      environment: 'production',
      searchBatch: 100,
    });
    expect(b.id).toBe(a.id);
    expect(b.environment).toBe('production');
    expect(b.settings.searchBatch).toBe(100);
    expect(b.credentialStored).toBe(true);
    expect(get()!.enabled).toBe(false);
  });

  it('refuses typed credentials in production (D-12) but accepts a vault reference', async () => {
    const { svc } = setup();
    process.env.NODE_ENV = 'production';
    await expect(
      svc.saveSettings('dynadot', ADMIN, {
        environment: 'production',
        credentials: { apiKey: KEY },
      }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    const r = await svc.saveSettings('dynadot', ADMIN, {
      environment: 'production',
      vaultRef: 'vault://prod/dynadot',
    });
    expect(r.vaultRef).toBe('vault://prod/dynadot');
  });

  it.each([
    [
      'a base URL (the address comes from the environment)',
      { ...base, baseUrl: 'https://x.example.test' },
    ],
    ['a reseller id (not a Dynadot setting)', { ...base, resellerId: 'R1' }],
    ['a bad environment', { ...base, environment: 'staging' }],
    ['a search batch of 0', { ...base, searchBatch: 0 }],
    ['a search batch of 101', { ...base, searchBatch: 101 }],
    ['a timeout out of range', { ...base, timeoutMs: 10 }],
    ['a short key', { ...base, credentials: { apiKey: 'short' } }],
    [
      'key and vault reference together',
      { ...base, credentials: { apiKey: KEY }, vaultRef: 'vault://x/y' },
    ],
    ['a credential-looking field', { ...base, apiKey: KEY }],
  ])('rejects %s', async (_n, body) => {
    const { svc } = setup();
    await expect(
      svc.saveSettings('dynadot', ADMIN, body as Record<string, unknown>),
    ).rejects.toBeTruthy();
  });
});
