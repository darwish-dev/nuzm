import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { EntitlementService, LedgerPostingService, recipes } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const web: Record<string, Record<string, string>> = {};
const adm: Record<string, Record<string, string>> = {};

const as = (
  jar: Record<string, string>,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: object,
  org?: string,
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jar),
      'x-csrf-token': jar.nuzm_csrf ?? jar.nuzm_admin_csrf ?? '',
      ...(org ? { 'x-nuzm-org': org } : {}),
      'idempotency-key': `k-${Math.random()}`,
    },
    ...(body ? { payload: body } : {}),
  });
const customer = (who: string, url: string, org: string) =>
  as(web[who]!, 'GET', url, undefined, org);
const admin = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: object) =>
  as(adm[who]!, method, url, body);
const refresh = (org: string) =>
  h.env.app.withOrg(org, (c) => c.query('SELECT billing.refresh_wallet($1)', [org]));

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol', 'dave']) {
    ids[n] = await h.createUser(n);
    web[n] = await h.sessionFor(app, ids[n]!);
  }
  orgA = (await as(web.alice!, 'POST', '/v1/organizations', { name: 'Billing A' })).json().id;
  orgB = (await as(web.bob!, 'POST', '/v1/organizations', { name: 'Billing B' })).json().id;
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'billing_admin'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgA, ids[u], role],
    );
  for (const [name, roles] of Object.entries({
    fin: ['finance'],
    sup: ['support'],
    comp: ['compliance_officer'],
    root: ['platform_admin'],
  })) {
    const u = await h.platformUser(app, `staff-${name}`, roles);
    ids[name] = u.id;
    adm[name] = u.jar;
  }
});
afterAll(() => h.close());

describe('plan catalogue and effective entitlements', () => {
  it('every member sees the same published catalogue (placeholder plans flagged DRAFT-NOT-APPROVED)', async () => {
    const r = await customer('carol', '/v1/billing/plans', orgA);
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Row[];
    expect(items.map((p) => p.key).sort()).toEqual(['free', 'starter']);
    for (const p of items) {
      expect(p.placeholder).toBe(true);
      expect(p.name.ar).toBeTruthy();
      expect(p.name.en).toBeTruthy();
      expect(p.price).toBeNull(); // price books arrive in S06
      expect(p.version).toMatchObject({ version: 1, currency: 'SAR' });
      for (const e of p.entitlements as Row[])
        expect(['string', 'object']).toContain(typeof e.limit); // never a float
    }
    const orgBView = (await customer('bob', '/v1/billing/plans', orgB)).json();
    expect(orgBView.items.map((p: Row) => p.id).sort()).toEqual(items.map((p) => p.id).sort()); // global catalogue
    const one = await customer('carol', `/v1/billing/plans/${items[0]!.id}`, orgA);
    expect(one.json().key).toBe(items[0]!.key);
    expect(
      (await customer('carol', '/v1/billing/plans/00000000-0000-7000-8000-0000000000ff', orgA))
        .statusCode,
    ).toBe(404);
  });

  it('defaults to the free plan until a plan is assigned; assignment and overrides then apply on top, newest wins', async () => {
    const e0 = (await customer('carol', '/v1/billing/entitlements', orgA)).json();
    expect(e0.plan).toMatchObject({ key: 'free', source: 'default' });
    expect(e0.marketplace).toEqual([]);
    expect(e0.limits.find((l: Row) => l.meterGroup === 'compute')).toMatchObject({
      limit: '0',
      mode: 'hard',
      source: 'plan',
    });

    const svc = app.get(EntitlementService);
    const starter = (
      await h.env.sql(
        `SELECT v.id FROM billing.plan_versions v JOIN billing.plans p ON p.id=v.plan_id WHERE p.key='starter'`,
      )
    )[0]!.id as string;
    await svc.assignPlan(orgA, starter, ids.fin);
    const e1 = (await customer('carol', '/v1/billing/entitlements', orgA)).json();
    expect(e1.plan).toMatchObject({ key: 'starter', source: 'assignment', versionId: starter });
    expect(e1.limits.find((l: Row) => l.meterGroup === 'compute')).toMatchObject({
      limit: '100',
      allowance: '50',
      source: 'plan',
    });

    await svc.setOverride(orgA, {
      kind: 'meter_limit',
      key: 'compute',
      limit: '500',
      mode: 'hard',
    });
    await svc.setOverride(orgA, {
      kind: 'meter_limit',
      key: 'compute',
      limit: '900',
      mode: 'soft',
    }); // newer wins
    await svc.setOverride(orgA, { kind: 'feature', key: 'projects', enabled: false });
    const e2 = (await customer('carol', '/v1/billing/entitlements', orgA)).json();
    expect(e2.limits.find((l: Row) => l.meterGroup === 'compute')).toMatchObject({
      limit: '900',
      mode: 'soft',
      source: 'override',
    });
    expect(e2.features.projects).toEqual({ enabled: false, source: 'override' });
    // another organization is unaffected
    expect((await customer('bob', '/v1/billing/entitlements', orgB)).json().plan).toMatchObject({
      key: 'free',
      source: 'default',
    });
  });

  it('only a PUBLISHED plan version can be assigned; customers can never write entitlements', async () => {
    await admin('fin', 'POST', '/v1/admin/billing/plans', {
      key: 'draft-only',
      name: { ar: 'تجريبية', en: 'Draft only' },
    });
    const draftVersion = (
      await h.env.sql(
        `SELECT v.id FROM billing.plan_versions v JOIN billing.plans p ON p.id=v.plan_id WHERE p.key='draft-only'`,
      )
    )[0]!.id as string;
    await expect(app.get(EntitlementService).assignPlan(orgA, draftVersion)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      h.env.app.withOrg(orgA, (c) =>
        c.query(
          `INSERT INTO billing.entitlements (id, scope, source, kind, org_id, feature_key) VALUES (gen_random_uuid(),'org_override','override','feature',$1,'free_stuff')`,
          [orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // RLS filters the rows away: the UPDATE affects nothing (it is not an error) and the catalogue is unchanged
    const hijack = await h.env.app.withOrg(orgA, (c) =>
      c.query(`UPDATE billing.plans SET name_en = 'hijacked'`),
    );
    expect(hijack.rowCount).toBe(0);
    expect((await h.env.sql(`SELECT 1 FROM billing.plans WHERE name_en = 'hijacked'`)).length).toBe(
      0,
    );
  });
});

describe('customer statement and balance', () => {
  it('shows only the wallet lines of the organization, with a running balance and string amounts', async () => {
    const ledger = app.get(LedgerPostingService);
    await ledger.post(
      recipes.creditGrant({
        orgId: orgA,
        amountMinor: 50_000,
        currency: 'SAR',
        reason: 'Welcome credit',
      }),
      'api-grant',
    );
    await ledger.post(
      recipes.walletConsume({
        orgId: orgA,
        netMinor: 12_000,
        currency: 'SAR',
        meterId: 'compute.vcpu_hours',
      }),
      'api-use-1',
    );
    await ledger.post(
      recipes.walletConsume({ orgId: orgA, netMinor: 3_000, vatMinor: 450, currency: 'SAR' }),
      'api-use-2',
    );
    await ledger.post(
      recipes.creditGrant({ orgId: orgB, amountMinor: 999, currency: 'SAR', reason: 'Other org' }),
      'api-grant-b',
    );

    const r = await customer('dave', '/v1/billing/ledger?limit=50', orgA);
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Row[];
    expect(items.map((i) => [i.kind, i.direction, i.amountMinor, i.balanceMinor])).toEqual([
      ['wallet_consume', 'debit', '3450', '34550'],
      ['wallet_consume', 'debit', '12000', '38000'],
      ['credit_grant', 'credit', '50000', '50000'],
    ]);
    for (const i of items) {
      expect(typeof i.amountMinor).toBe('string');
      expect(typeof i.balanceMinor).toBe('string');
    }
    expect(r.body).not.toContain('4100'); // no platform account codes
    expect(r.body).not.toContain('other org'.toLowerCase());
    expect(JSON.stringify(items)).not.toContain('999');
  });

  it('paginates by cursor without gaps or duplicates and filters by kind', async () => {
    const ledger = app.get(LedgerPostingService);
    for (let i = 0; i < 6; i++)
      await ledger.post(
        recipes.creditGrant({
          orgId: orgA,
          amountMinor: 10 + i,
          currency: 'SAR',
          reason: `drip ${i}`,
        }),
        `drip-${i}`,
      );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: Row = (
        await customer(
          'dave',
          `/v1/billing/ledger?limit=4${cursor ? `&cursor=${cursor}` : ''}`,
          orgA,
        )
      ).json();
      seen.push(...p.items.map((i: Row) => i.id));
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    const all = (await customer('dave', '/v1/billing/ledger?limit=200', orgA))
      .json()
      .items.map((i: Row) => i.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBeGreaterThan(2);
    const grants = (await customer('dave', '/v1/billing/ledger?kind=credit_grant', orgA)).json()
      .items as Row[];
    expect(grants.every((g) => g.kind === 'credit_grant')).toBe(true);
    expect((await customer('dave', '/v1/billing/ledger?from=yesterday', orgA)).statusCode).toBe(
      422,
    );
  });

  it('the balance comes from the projection: empty until refreshed, then equal to the last running balance', async () => {
    expect((await customer('dave', '/v1/billing/balance', orgA)).json()).toEqual({ balances: [] });
    await refresh(orgA);
    const bal = (await customer('dave', '/v1/billing/balance', orgA)).json();
    const last = (await customer('dave', '/v1/billing/ledger?limit=1', orgA)).json().items[0];
    expect(bal.balances).toEqual([{ currency: 'SAR', balanceMinor: last.balanceMinor }]);
  });

  it('requires billing:read (viewer is refused), is org-scoped, and hides another organization', async () => {
    expect((await customer('carol', '/v1/billing/ledger', orgA)).statusCode).toBe(403);
    expect((await customer('carol', '/v1/billing/balance', orgA)).statusCode).toBe(403);
    expect((await customer('bob', '/v1/billing/ledger', orgA)).statusCode).toBe(404); // not a member
    const b = (await customer('bob', '/v1/billing/ledger', orgB)).json().items as Row[];
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ amountMinor: '999', balanceMinor: '999' });
  });
});

describe('admin ledger views', () => {
  it('finance sees every account and transaction; balances are derived from postings', async () => {
    const accounts = (
      await admin('fin', 'GET', '/v1/admin/billing/ledger-accounts?limit=200')
    ).json().items as Row[];
    const codes = new Set(accounts.map((a) => a.code));
    for (const c of ['2100', '4100', '4900', '2300']) expect(codes.has(c)).toBe(true);
    const revenue = accounts.find((a) => a.code === '4100')!;
    expect(revenue).toMatchObject({ type: 'revenue', normalSide: 'credit', orgId: null });
    expect(BigInt(revenue.balanceMinor)).toBe(12_000n + 3_000n); // net consumed revenue
    const walletA = accounts.find((a) => a.code === '2100' && a.orgId === orgA)!;
    expect(typeof walletA.balanceMinor).toBe('string');
    const only = (
      await admin('fin', 'GET', `/v1/admin/billing/ledger-accounts?orgId=${orgB}`)
    ).json().items as Row[];
    expect(only.every((a) => a.orgId === orgB)).toBe(true);
    expect(
      (await admin('fin', 'GET', '/v1/admin/billing/ledger-accounts?orgId=nope')).statusCode,
    ).toBe(422);
  });

  it('transactions carry their postings (including platform accounts) and filter by org and kind', async () => {
    const txs = (
      await admin(
        'comp',
        'GET',
        `/v1/admin/billing/ledger-transactions?orgId=${orgA}&kind=wallet_consume`,
      )
    ).json().items as Row[];
    expect(txs).toHaveLength(2);
    const vat = txs.find((t) => t.postings.length === 3)!;
    expect(vat.postings.map((p: Row) => p.accountCode).sort()).toEqual(['2100', '2300', '4100']);
    expect(vat.postings.find((p: Row) => p.accountCode === '2100')).toMatchObject({
      direction: 'debit',
      amountMinor: '3450',
    });
    // balanced: debits equal credits
    const net = vat.postings.reduce(
      (s: bigint, p: Row) => s + (p.direction === 'debit' ? 1n : -1n) * BigInt(p.amountMinor),
      0n,
    );
    expect(net).toBe(0n);
  });

  it('is refused for tenants, for support (no billing permission) and the read-only role cannot write plans', async () => {
    expect((await admin('sup', 'GET', '/v1/admin/billing/ledger-accounts')).statusCode).toBe(403);
    expect((await admin('comp', 'GET', '/v1/admin/billing/plans')).statusCode).toBe(200);
    expect(
      (
        await admin('comp', 'POST', '/v1/admin/billing/plans', {
          key: 'x1',
          name: { ar: 'أ', en: 'x' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await as(web.alice!, 'GET', '/v1/admin/billing/ledger-accounts')).statusCode).toBe(401);
  });
});

describe('admin plan lifecycle', () => {
  let planId = '';
  const ent = (meterGroup: string, limit: string) => ({
    kind: 'meter_limit',
    meterGroup,
    limit,
    allowance: '10',
    mode: 'hard',
  });

  it('creates a plan with a draft v1, rejects duplicates and invalid input', async () => {
    const r = await admin('fin', 'POST', '/v1/admin/billing/plans', {
      key: 'team',
      name: { ar: 'الفريق', en: 'Team' },
      entitlements: [ent('compute', '200'), { kind: 'feature', featureKey: 'sso' }],
    });
    expect(r.statusCode).toBe(201);
    const p = r.json();
    planId = p.id;
    expect(p.versions).toHaveLength(1);
    expect(p.versions[0]).toMatchObject({ version: 1, status: 'draft' });
    expect(p.versions[0].entitlements).toHaveLength(2);
    expect(
      (
        await admin('fin', 'POST', '/v1/admin/billing/plans', {
          key: 'team',
          name: { ar: 'أ', en: 'a' },
        })
      ).statusCode,
    ).toBe(409);
    for (const bad of [
      { key: 'Bad Key', name: { ar: 'أ', en: 'a' } },
      { key: 'okay', name: { ar: '', en: 'a' } },
      { key: 'okay', name: { ar: 'أ', en: 'a' }, currency: 'sar' },
      {
        key: 'okay',
        name: { ar: 'أ', en: 'a' },
        entitlements: [{ kind: 'meter_limit', limit: '1' }],
      },
      {
        key: 'okay',
        name: { ar: 'أ', en: 'a' },
        entitlements: [{ kind: 'meter_limit', meterGroup: 'compute', limit: '-1' }],
      },
      {
        key: 'okay',
        name: { ar: 'أ', en: 'a' },
        entitlements: [{ kind: 'meter_limit', meterGroup: 'compute', limit: 1.5 }],
      },
      {
        key: 'okay',
        name: { ar: 'أ', en: 'a' },
        entitlements: [ent('compute', '1'), ent('compute', '2')],
      },
    ])
      expect(
        (await admin('fin', 'POST', '/v1/admin/billing/plans', bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(422);
  });

  it('a draft is not in the customer catalogue until published; publishing freezes the version', async () => {
    const before = (await customer('carol', '/v1/billing/plans', orgA))
      .json()
      .items.map((p: Row) => p.key);
    expect(before).not.toContain('team');
    const edit = await admin('fin', 'PATCH', `/v1/admin/billing/plans/${planId}`, {
      entitlements: [ent('compute', '250')],
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().versions[0].entitlements).toHaveLength(1);
    const pub = await admin('fin', 'PATCH', `/v1/admin/billing/plans/${planId}`, {
      action: 'publish',
    });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().versions[0]).toMatchObject({ status: 'published' });
    const after = (await customer('carol', '/v1/billing/plans', orgA))
      .json()
      .items.find((p: Row) => p.key === 'team');
    expect(after.version.version).toBe(1);
    expect(after.entitlements[0]).toMatchObject({ meterGroup: 'compute', limit: '250' });

    // immutability: the API says conflict, and the database refuses even a direct write by the table owner
    expect(
      (
        await admin('fin', 'PATCH', `/v1/admin/billing/plans/${planId}`, {
          entitlements: [ent('compute', '1')],
        })
      ).statusCode,
    ).toBe(409);
    await expect(
      h.env.sql(`UPDATE billing.plan_versions SET currency = 'USD' WHERE plan_id = $1`, [planId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(`DELETE FROM billing.plan_versions WHERE plan_id = $1`, [planId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(
        `UPDATE billing.entitlements SET limit_value = 9 WHERE plan_version_id = (SELECT id FROM billing.plan_versions WHERE plan_id = $1)`,
        [planId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.sql(
        `INSERT INTO billing.entitlements (id, scope, source, kind, plan_version_id, feature_key) VALUES (gen_random_uuid(),'plan','plan','feature',(SELECT id FROM billing.plan_versions WHERE plan_id=$1),'sneaky')`,
        [planId],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('a new draft copies the latest published version, can be edited and published; only one draft at a time', async () => {
    const nd = await admin('fin', 'PATCH', `/v1/admin/billing/plans/${planId}`, {
      action: 'new_draft',
      entitlements: [ent('compute', '300'), ent('storage', '7')],
    });
    expect(nd.statusCode).toBe(200);
    const versions = nd.json().versions as Row[];
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'published'],
      [2, 'draft'],
    ]);
    expect(versions[0]!.entitlements[0].limit).toBe('250'); // v1 untouched
    expect(versions[1]!.entitlements.map((e: Row) => e.limit).sort()).toEqual(['300', '7']);
    expect(
      (await admin('fin', 'PATCH', `/v1/admin/billing/plans/${planId}`, { action: 'new_draft' }))
        .statusCode,
    ).toBe(409);
    await admin('fin', 'PATCH', `/v1/admin/billing/plans/${planId}`, {
      action: 'publish',
      name: { ar: 'الفريق الجديد', en: 'Team Plus' },
    });
    const cat = (await customer('carol', '/v1/billing/plans', orgA))
      .json()
      .items.find((p: Row) => p.key === 'team');
    expect(cat.version.version).toBe(2);
    expect(cat.name.en).toBe('Team Plus');
    expect(
      (await admin('fin', 'PATCH', `/v1/admin/billing/plans/${planId}`, { action: 'publish' }))
        .statusCode,
    ).toBe(409); // nothing to publish
    expect((await admin('fin', 'PATCH', `/v1/admin/billing/plans/${planId}`, {})).statusCode).toBe(
      422,
    );
    expect(
      (
        await admin(
          'fin',
          'PATCH',
          '/v1/admin/billing/plans/00000000-0000-7000-8000-0000000000ff',
          { name: { ar: 'أ', en: 'a' } },
        )
      ).statusCode,
    ).toBe(404);
  });

  it('plan changes are audited with the acting finance user', async () => {
    const rows = await h.env.sql(
      `SELECT action, actor_user_id FROM audit.audit_logs WHERE action LIKE 'billing.plan%' ORDER BY occurred_at`,
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'billing.plan.created',
        'billing.plan.updated',
        'billing.plan_version.published',
      ]),
    );
    expect(
      new Set(
        rows.filter((r) => String(r.action).startsWith('billing.plan')).map((r) => r.actor_user_id),
      ),
    ).toContain(ids.fin);
    const posted = await h.env.sql(
      `SELECT 1 FROM audit.audit_logs WHERE action = 'billing.ledger.posted' AND org_id = $1`,
      [orgA],
    );
    expect(posted.length).toBeGreaterThan(3);
  });
});
