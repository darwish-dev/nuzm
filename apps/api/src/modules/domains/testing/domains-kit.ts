import 'reflect-metadata';
import {
  OpenproviderAdapter,
  startOpenproviderMock,
  type OpenproviderMock,
} from '@nuzm/adapter-openprovider';
import {
  ResellerClubAdapter,
  startResellerClubMock,
  type ResellerClubMock,
} from '@nuzm/adapter-resellerclub';
import { MemoryVault } from '@nuzm/registrar-conformance';
import { FetchHttpClient } from '@nuzm/registrar-contracts';
import { Harness, cookieHeader, type App } from '../../identity/testing/app-harness';
import { LedgerPostingService, recipes } from '../../billing';
import { ADAPTER_FACTORIES, DOMAINS_VAULT, type AdapterFactory } from '../index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON in tests */
export type Row = Record<string, any>;

export const PNG = 'unused';
export interface DomainsKit {
  h: Harness;
  app: App;
  op: OpenproviderMock;
  rc: ResellerClubMock;
  vault: MemoryVault;
  orgA: string;
  orgB: string;
  ids: Record<string, string>;
  jars: Record<string, Record<string, string>>;
  staff: Record<string, { id: string; jar: Record<string, string> }>;
  accounts: { op: string; rc: string };
  call(
    who: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: object,
    opts?: { org?: string; key?: string | null; headers?: Record<string, string> },
  ): ReturnType<App['inject']>;
  admin(
    who: string,
    method: 'GET' | 'POST',
    url: string,
    body?: object,
    key?: string,
  ): ReturnType<App['inject']>;
  fund(org: string, amountMinor: string): Promise<void>;
  count(sql: string, p?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

let seq = 0;
/** Builds the whole API with mock registrar servers behind the real adapters (NOT VERIFIED vendor behaviour: gating and orchestration logic only). */
export async function startDomainsKit(): Promise<DomainsKit> {
  process.env.DOMAINS_ENABLED = 'true';
  process.env.DOMAINS_ALLOW_NON_LIVE_REGISTRARS = 'true';
  process.env.DOMAINS_FX_JSON = JSON.stringify({ SAR: '1', USD: '3.75', EUR: '4.10' });
  process.env.DOMAINS_SEARCH_RATE_PER_MINUTE = '100000';
  process.env.DOMAINS_ACCOUNT_BURST = '5000'; // the per-account limiter is real; the tests drive far more calls per second than a person would
  process.env.DOMAINS_ACCOUNT_RATE_PER_SECOND = '5000';
  const h = new Harness();
  await h.init();
  const op = await startOpenproviderMock();
  const rc = await startResellerClubMock();
  const vault = new MemoryVault()
    .set('vault://test/openprovider', op.credentials)
    .set('vault://test/resellerclub', rc.credentials)
    .set('vault://test/openprovider-webhook', { secret: op.webhookSecret });
  const http = (id: string) =>
    new FetchHttpClient({ adapterId: id, hosts: ['127.0.0.1'], allowLoopback: true });
  const factories: Record<string, AdapterFactory> = {
    openprovider: (_a, d) =>
      new OpenproviderAdapter({
        baseUrl: op.url,
        http: http('openprovider'),
        vault: d.vault,
        evidenceKind: 'mock',
      }),
    resellerclub: (a, d) =>
      new ResellerClubAdapter({
        baseUrl: rc.url,
        domainCheckUrl: rc.url,
        http: http('resellerclub'),
        vault: d.vault,
        evidenceKind: 'mock',
        currency: a.currency,
        defaultNameservers: ['ns1.example.net', 'ns2.example.net'],
      }),
  };
  const { app } = await h.buildApp({}, undefined, [], {
    realAudit: true,
    override: (b) =>
      b
        .overrideProvider(ADAPTER_FACTORIES)
        .useValue(factories)
        .overrideProvider(DOMAINS_VAULT)
        .useValue(vault),
  });
  const ids: Record<string, string> = {};
  const jars: Record<string, Record<string, string>> = {};
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  const mk = async (who: string, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: {
          cookie: cookieHeader(jars[who]!),
          'x-csrf-token': jars[who]!.nuzm_csrf!,
          'idempotency-key': `org-${++seq}`,
        },
        payload: { name },
      })
    ).json().id as string;
  const orgA = await mk('alice', 'Domains A');
  const orgB = await mk('bob', 'Domains B');
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'billing_admin'],
    ['erin', 'developer'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgA, ids[u], role],
    );
  const staff: DomainsKit['staff'] = {};
  staff.root = await h.platformUser(app, 'dom-root', ['platform_admin']);
  staff.support = await h.platformUser(app, 'dom-support', ['support']);
  staff.finance = await h.platformUser(app, 'dom-finance', ['finance']);

  const call: DomainsKit['call'] = (who, method, url, body, o = {}) =>
    app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(jars[who]!),
        'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
        'x-nuzm-org': o.org ?? orgA,
        ...(method === 'POST' && o.key !== null
          ? { 'idempotency-key': o.key ?? `k-${++seq}-${Math.random()}` }
          : {}),
        ...(o.headers ?? {}),
      },
      ...(body ? { payload: body } : {}),
    });
  const admin: DomainsKit['admin'] = (who, method, url, body, key) =>
    app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(staff[who]!.jar),
        'x-csrf-token': staff[who]!.jar.nuzm_admin_csrf!,
        ...(method === 'POST' ? { 'idempotency-key': key ?? `k-${++seq}-${Math.random()}` } : {}),
      },
      ...(body ? { payload: body } : {}),
    });
  const count = async (q: string, p: unknown[] = []) => Number((await h.env.sql(q, p))[0]!.n);

  // registrar accounts: created and verified (enabled) through the admin API, exactly as an operator would
  const mkAcct = async (
    providerCode: string,
    vaultRef: string,
    dataRegion: string,
    currency: string,
    priority: number,
  ) => {
    const c = await admin('root', 'POST', '/v1/admin/registrars', {
      providerCode,
      label: `${providerCode} mock`,
      environment: 'sandbox',
      vaultRef,
      dataRegion,
      currency,
      priority,
      ...(providerCode === 'openprovider'
        ? { webhookSecretRef: 'vault://test/openprovider-webhook' }
        : {}),
    });
    if (c.statusCode !== 201)
      throw new Error(`create registrar account: ${c.statusCode} ${c.body}`);
    const id = c.json().id as string;
    const v = await admin('root', 'POST', `/v1/admin/registrars/${id}/verification`, {
      enable: true,
    });
    if (v.statusCode !== 200)
      throw new Error(`verify registrar account: ${v.statusCode} ${v.body}`);
    return id;
  };
  const accounts = {
    op: await mkAcct('openprovider', 'vault://test/openprovider', 'NL', 'EUR', 10),
    rc: await mkAcct('resellerclub', 'vault://test/resellerclub', 'IN', 'USD', 20),
  };

  // residency: the registrars must be known processors (ROPA) and the organization must allow personal data to go there
  await h.env.sql(
    `INSERT INTO compliance.ropa_entries (id, entry_key, version, kind, adapter_kind, activity, purpose, data_classes, processors, regions, status, change_note)
     VALUES (gen_random_uuid(),'adapter:registrar',2,'adapter','registrar','Domain registrar','Register and manage domains for customers', '{personal,internal}',
       $1::jsonb,'{}','draft','test processors')`,
    [
      JSON.stringify([
        {
          name: 'openprovider',
          role: 'processor',
          region: 'NL',
          dataClasses: ['personal', 'internal'],
          contractRef: null,
        },
        {
          name: 'resellerclub',
          role: 'processor',
          region: 'IN',
          dataClasses: ['personal', 'internal'],
          contractRef: null,
        },
      ]),
    ],
  );
  for (const [who, org] of [
    ['alice', orgA],
    ['bob', orgB],
  ] as const) {
    const r = await call(
      who,
      'PUT',
      '/v1/compliance/residency-policy',
      { mode: 'allow_listed', allowedCountriesByClass: { personal: ['NL', 'IN'] } },
      { org },
    );
    if (r.statusCode !== 200) throw new Error(`residency policy: ${r.statusCode} ${r.body}`);
  }
  const fund = async (org: string, amountMinor: string) => {
    await app.get(LedgerPostingService).post(
      recipes.creditGrant({
        orgId: org,
        amountMinor,
        currency: 'SAR',
        reason: 'test funding',
        grantId: crypto.randomUUID(),
      }),
      `fund-${org}-${++seq}`,
    );
  };
  return {
    h,
    app,
    op,
    rc,
    vault,
    orgA,
    orgB,
    ids,
    jars,
    staff,
    accounts,
    call,
    admin,
    fund,
    count,
    close: async () => {
      await h.close();
      await op.close();
      await rc.close();
    },
  };
}
