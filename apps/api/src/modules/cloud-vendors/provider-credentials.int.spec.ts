import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { VAULT } from '../cloud';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
const h = new Harness();
let app: App;
const staff: Record<string, Record<string, string>> = {};
const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const admin = (
  who: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: object,
) =>
  app.inject({
    method,
    url,
    headers: { cookie: cookieHeader(staff[who]!), 'x-csrf-token': staff[who]!.nuzm_admin_csrf! },
    ...(body ? { payload: body } : {}),
  });
const AK_SECRET = 'CANARY-AKSECRET-5f3a91c0-NEVER-STORE';
const NEW_SECRET = 'CANARY-ROTATED-9b27e4d1-NEVER-STORE';
let providerIds: Record<string, string> = {};
let sink: { events: Row[] };

beforeAll(async () => {
  await h.init();
  const built = await h.buildApp({}, undefined, [], { realAudit: false });
  app = built.app;
  sink = built.sink as unknown as { events: Row[] };
  staff.pa = (await h.platformUser(app, 'cred-pa', ['platform_admin'])).jar;
  staff.sec = (await h.platformUser(app, 'cred-sec', ['security'])).jar;
  providerIds = Object.fromEntries(
    (await sql(`SELECT id, key FROM cloud.providers`)).map((r) => [r.key, r.id]),
  );
});
afterAll(() => h.close());

describe('connect a provider with typed credentials (write-only)', () => {
  let accountId = '';
  it('stores the keys sealed, keeps only the reference, and the adapters can resolve it', async () => {
    const r = await admin('pa', 'POST', '/v1/admin/provider-accounts/connect', {
      providerId: providerIds.alibaba,
      name: 'ksa-main',
      credentials: { accessKeyId: 'LTAI5tExampleId', accessKeySecret: AK_SECRET },
    });
    expect(r.statusCode).toBe(201);
    accountId = r.json().id;
    expect(r.json().credentialRef).toMatch(/^vault:\/\/(dev|mem)\/provider-alibaba-/);
    // nothing secret in the response, the database or the audit trail
    const everything = JSON.stringify([
      r.json(),
      await sql(`SELECT * FROM cloud.provider_accounts`),
      sink.events,
    ]);
    expect(everything).not.toContain(AK_SECRET);
    // the same reference resolves through the cloud vault to exactly the typed fields
    const vault = app.get<{ resolve(ref: string): Promise<{ fields: Record<string, string> }> }>(
      VAULT,
    );
    expect((await vault.resolve(r.json().credentialRef)).fields).toEqual({
      accessKeyId: 'LTAI5tExampleId',
      accessKeySecret: AK_SECRET,
    });
  });
  it('rotates the keys: a new reference, verification cleared, the old entry gone, still no secret stored', async () => {
    const before = (await admin('pa', 'GET', `/v1/admin/provider-accounts/${accountId}`)).json();
    const r = await admin('pa', 'PUT', `/v1/admin/provider-accounts/${accountId}/credentials`, {
      credentials: { accessKeyId: 'LTAI5tNewId', accessKeySecret: NEW_SECRET },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().credentialRef).not.toBe(before.credentialRef);
    expect(r.json().verifiedAt).toBeNull();
    const vault = app.get<{ resolve(ref: string): Promise<unknown> }>(VAULT);
    await expect(vault.resolve(before.credentialRef)).rejects.toMatchObject({ code: 'not_found' });
    const everything = JSON.stringify([r.json(), sink.events]);
    expect(everything).not.toContain(NEW_SECRET);
    expect(sink.events.some((e) => e.action === 'provider.account.credentials_changed')).toBe(true);
  });
  it('refuses wrong field sets, unknown providers and reference + credentials together, without echoing values', async () => {
    const bad = await admin('pa', 'POST', '/v1/admin/provider-accounts/connect', {
      providerId: providerIds.contabo,
      name: 'de-main',
      credentials: { clientId: 'INT-1', clientSecret: AK_SECRET },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.body).not.toContain(AK_SECRET);
    const both = await admin('pa', 'POST', '/v1/admin/provider-accounts/connect', {
      providerId: providerIds.contabo,
      name: 'de-main',
      credentialRef: 'vault://x/y',
      credentials: {
        clientId: 'INT-1',
        clientSecret: 'cs-1',
        apiUser: 'a@b.co',
        apiPassword: 'pw-123',
      },
    });
    expect(both.statusCode).toBe(422);
    const mock = await admin('pa', 'POST', '/v1/admin/provider-accounts/connect', {
      providerId: providerIds.mock,
      name: 'm',
      credentials: { accessKeyId: 'LTAI123', accessKeySecret: 'secret-1' },
    });
    expect(mock.statusCode).toBe(422);
    expect((await sql(`SELECT 1 FROM cloud.provider_accounts WHERE name = 'de-main'`)).length).toBe(
      0,
    );
  });
  it('needs manage permission and a duplicate name does not leave a secret behind', async () => {
    const body = {
      providerId: providerIds.huawei,
      name: 'ksa-hw',
      credentials: { accessKey: 'AKEXAMPLE1', secretKey: 'SK-example-secret-1' },
    };
    expect(
      (await admin('sec', 'POST', '/v1/admin/provider-accounts/connect', body)).statusCode,
    ).toBe(403);
    expect(
      (await admin('pa', 'POST', '/v1/admin/provider-accounts/connect', body)).statusCode,
    ).toBe(201);
    expect(
      (await admin('pa', 'POST', '/v1/admin/provider-accounts/connect', body)).statusCode,
    ).toBe(409);
  });
});

describe('provisioning network settings (identifiers, not secrets)', () => {
  it('saves, lists, validates and removes the settings of a region', async () => {
    const put = await admin('pa', 'PUT', '/v1/admin/provider-network/alibaba/me-central-1', {
      vSwitchId: 'vsw-abc123',
      securityGroupId: 'sg-abc123',
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ providerKey: 'alibaba', regionId: 'me-central-1' });
    const list = (await admin('pa', 'GET', '/v1/admin/provider-network')).json();
    expect(list.items).toHaveLength(1);
    expect(
      (
        await admin('pa', 'PUT', '/v1/admin/provider-network/alibaba/me-central-1', {
          vSwitchId: 'vsw-abc123',
        })
      ).statusCode,
    ).toBe(422); // security group missing
    expect(
      (await admin('pa', 'PUT', '/v1/admin/provider-network/contabo/eu', { vpcId: 'x' }))
        .statusCode,
    ).toBe(404); // not a provider with network settings
    expect((await admin('sec', 'GET', '/v1/admin/provider-network')).statusCode).toBe(200);
    expect(
      (await admin('sec', 'PUT', '/v1/admin/provider-network/alibaba/me-central-1', {})).statusCode,
    ).toBe(403);
    expect(
      (await admin('pa', 'DELETE', '/v1/admin/provider-network/alibaba/me-central-1')).statusCode,
    ).toBe(204);
    expect(
      (await admin('pa', 'DELETE', '/v1/admin/provider-network/alibaba/me-central-1')).statusCode,
    ).toBe(404);
  });
});
