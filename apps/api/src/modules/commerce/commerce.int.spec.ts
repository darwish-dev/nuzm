import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { EntitlementService, LedgerPostingService, SpendService, recipes } from '../billing';
import { OrderService, QuoteService } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const staff: Record<string, Record<string, string>> = {};
const uuid = () => crypto.randomUUID();

const call = (
  who: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: object,
  org = orgA,
  extra: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jars[who]!),
      'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
      'x-nuzm-org': org,
      'idempotency-key': `k-${Math.random()}`,
      ...extra,
    },
    ...(body ? { payload: body } : {}),
  });
const adminPost = (who: string, body: object, key: string | null = `a-${Math.random()}`) =>
  app.inject({
    method: 'POST',
    url: '/v1/admin/billing/adjustments',
    headers: {
      cookie: cookieHeader(staff[who]!),
      'x-csrf-token': staff[who]!.nuzm_admin_csrf!,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    payload: body as object,
  });
const quote = (credits: string, who = 'erin') =>
  call(who, 'POST', '/v1/quotes', { kind: 'ai-credit', items: [{ credits }] });
const audits = (org: string, action: string) =>
  h.env.sql(`SELECT after FROM audit.audit_logs WHERE org_id=$1 AND action=$2 ORDER BY id`, [
    org,
    action,
  ]) as Promise<Row[]>;

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  orgA = (await call('alice', 'POST', '/v1/organizations', { name: 'Commerce A' }, '')).json().id;
  orgB = (await call('bob', 'POST', '/v1/organizations', { name: 'Commerce B' }, '')).json().id;
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'billing_admin'],
    ['erin', 'developer'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgA, ids[u], role],
    );
  for (const [name, roles] of Object.entries({
    fin1: ['finance'],
    fin2: ['finance'],
    root: ['platform_admin'],
    sup: ['support'],
  })) {
    const u = await h.platformUser(app, `staff-${name}`, roles);
    ids[name] = u.id;
    staff[name] = u.jar;
  }
});
afterAll(() => h.close());

describe('quotes', () => {
  it('prices an ai-credit quote from the price book, with a provisional tax estimate and a not-evaluated residency block', async () => {
    const r = await quote('1000');
    expect(r.statusCode).toBe(201);
    const q = r.json();
    expect(q).toMatchObject({
      kind: 'ai-credit',
      status: 'issued',
      currency: 'SAR',
      subtotalMinor: '1000', // placeholder book: 1 minor unit per credit
      totalMinor: '1150',
      requiresApproval: false,
      residency: { status: 'not_evaluated' },
      taxEstimate: {
        status: 'computed',
        rateCode: 'SA-VAT-STD',
        rateBps: 1500,
        taxMinor: '150',
        source: 'tax_rates',
      },
    });
    expect(q.items).toEqual([
      expect.objectContaining({
        position: 1,
        meterId: 'ai.credits_consumed',
        quantity: '1000.00000000',
        unit: 'credit',
        amountMinor: '1000',
      }),
    ]);
    expect(q.priceBookVersionId).toMatch(/^[0-9a-f-]{36}$/);
    const ttl = Date.parse(q.expiresAt) - Date.parse(q.createdAt);
    expect(ttl).toBe(15 * 60_000);
    expect((await audits(orgA, 'commerce.quote.issued')).length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent per key, needs an Idempotency-Key, and is readable by quote readers only', async () => {
    const body = { kind: 'ai-credit', items: [{ credits: '10' }] };
    const key = { 'idempotency-key': 'quote-key-1' };
    const a = await call('erin', 'POST', '/v1/quotes', body, orgA, key);
    const b = await call('erin', 'POST', '/v1/quotes', body, orgA, key);
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const noKey = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      headers: {
        cookie: cookieHeader(jars.erin!),
        'x-csrf-token': jars.erin!.nuzm_csrf!,
        'x-nuzm-org': orgA,
      },
      payload: body,
    });
    expect(noKey.statusCode).toBe(400);
    const id = a.json().id;
    expect((await call('dave', 'GET', `/v1/quotes/${id}`)).json().id).toBe(id);
    expect((await call('carol', 'GET', `/v1/quotes/${id}`)).statusCode).toBe(403);
    expect((await quote('10', 'carol')).statusCode).toBe(403);
    expect((await call('erin', 'GET', '/v1/quotes/not-a-uuid')).statusCode).toBe(404);
  });

  it('kinds without a registered pricer answer kind_not_available (no invented prices); plan is refused honestly', async () => {
    // `compute` is not in this list since M05 S17 registers its pricer (see the compute integration specs)
    // `database`, `storage` and `email` are priced by M08, `hosting` by M06
    for (const kind of ['domain', 'marketplace']) {
      const r = await call('erin', 'POST', '/v1/quotes', { kind, items: [{ x: 1 }] });
      expect(r.statusCode, kind).toBe(422);
      expect(r.json().code, kind).toBe('kind_not_available');
    }
    const plan = await call('erin', 'POST', '/v1/quotes', {
      kind: 'plan',
      items: [{ plan: 'starter' }],
    });
    expect(plan.json()).toMatchObject({ code: 'kind_not_available' });
    expect(plan.json().detail).toMatch(/M03/);
    expect(
      (await call('erin', 'POST', '/v1/quotes', { kind: 'bogus', items: [{}] })).json().code,
    ).toBe('validation_failed');
  });

  it('validates input', async () => {
    const bad: object[] = [
      { kind: 'ai-credit', items: [] },
      { kind: 'ai-credit', items: [{ credits: '0' }] },
      { kind: 'ai-credit', items: [{ credits: '1.5' }] },
      { kind: 'ai-credit', items: [{ credits: 100 }] },
      { kind: 'ai-credit', items: [{ credits: '1e3' }] },
      { kind: 'ai-credit', items: [{ credits: '1' }, { credits: '2' }] },
      { kind: 'ai-credit', items: [{ credits: '10' }], currency: 'sar' },
      { kind: 'ai-credit', items: [{ credits: '10' }], projectId: 'nope' },
      { kind: 'ai-credit', items: [{ credits: '10' }], preferences: ['x'] },
      { kind: 'ai-credit', items: new Array(51).fill({ credits: '1' }) },
    ];
    for (const b of bad)
      expect(
        (await call('erin', 'POST', '/v1/quotes', b)).statusCode,
        JSON.stringify(b).slice(0, 80),
      ).toBe(422);
    expect(
      (
        await call('erin', 'POST', '/v1/quotes', {
          kind: 'ai-credit',
          items: [{ credits: '10' }],
          projectId: uuid(),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('is immutable: no role can change, delete or truncate a quote', async () => {
    const q = (await quote('5')).json();
    for (const sql of [
      `UPDATE commerce.quotes SET total_minor = 1, subtotal_minor = 1, tax_minor = 0 WHERE id = '${q.id}'`,
      `DELETE FROM commerce.quotes WHERE id = '${q.id}'`,
      `UPDATE commerce.quote_items SET amount_minor = 0 WHERE quote_id = '${q.id}'`,
      `DELETE FROM commerce.quote_items WHERE quote_id = '${q.id}'`,
      `TRUNCATE commerce.quotes CASCADE`,
    ])
      await expect(h.env.sql(sql), sql).rejects.toThrow(/immutable|violates|cannot truncate/i);
    await expect(
      h.env.app.withOrg(orgA, (c) => c.query(`UPDATE commerce.quotes SET kind = 'plan'`)),
    ).rejects.toThrow();
    expect((await call('erin', 'GET', `/v1/quotes/${q.id}`)).json().totalMinor).toBe(q.totalMinor);
  });

  it('expires: the stored quote never changes, it is reported expired after its TTL', async () => {
    const q = (await quote('5')).json();
    const later = new Date(Date.parse(q.expiresAt) + 1000);
    expect((await app.get(QuoteService).get(orgA, q.id, later)).status).toBe('expired');
    expect((await app.get(QuoteService).get(orgA, q.id)).status).toBe('issued');
  });

  it('a hard quota the quote would exceed refuses it (quota_exceeded); a quote that fits is allowed', async () => {
    await app
      .get(EntitlementService)
      .setOverride(orgA, { kind: 'meter_limit', key: 'ai', limit: '500', mode: 'hard' });
    const over = await quote('501');
    expect(over.statusCode).toBe(422);
    expect(over.json().code).toBe('quota_exceeded');
    expect((await quote('500')).statusCode).toBe(201);
    await app
      .get(EntitlementService)
      .setOverride(orgA, { kind: 'meter_limit', key: 'ai', limit: '1000000', mode: 'soft' });
  });

  it('says requiresApproval when the spend cap would be exceeded', async () => {
    await app
      .get(SpendService)
      .putLimit(orgA, { scope: 'org', monthlyCapMinor: '1000', currency: 'SAR' }, null, ids.alice!);
    const small = (await quote('100')).json(); // total 115
    expect(small.requiresApproval).toBe(false);
    const big = (await quote('1000')).json(); // total 1150 > cap 1000
    expect(big.requiresApproval).toBe(true);
    expect(big.approvalDetail[0]).toMatchObject({ scope: 'org', capMinor: '1000' });
  });

  it('is tenant isolated', async () => {
    const q = (await quote('5')).json();
    expect((await call('bob', 'GET', `/v1/quotes/${q.id}`, undefined, orgB)).statusCode).toBe(404);
    expect(
      (await h.env.app.withOrg(orgB, (c) => c.query(`SELECT count(*)::int n FROM commerce.quotes`)))
        .rows[0]!.n,
    ).toBe(0);
    expect((await call('carol', 'GET', `/v1/quotes/${q.id}`, undefined, orgB)).statusCode).toBe(
      404,
    ); // not a member of B
  });
});

describe('orders (quote → order path)', () => {
  const orders = () => app.get(OrderService);
  const requestApproval = (quoteId: string, amount: string) =>
    call('erin', 'POST', '/v1/billing/spend-approvals', {
      quoteId,
      amount,
      currency: 'SAR',
      reason: 'need credits',
    });
  const decide = (id: string, decision = 'approve') =>
    call('dave', 'POST', `/v1/billing/spend-approvals/${id}/decision`, { decision });

  it('an order within the cap proceeds and copies the quote; a quote becomes at most one order', async () => {
    const q = (await quote('100')).json();
    const o = await orders().createFromQuote(orgA, q.id, ids.erin!);
    expect(o).toMatchObject({
      quoteId: q.id,
      kind: 'ai-credit',
      status: 'created',
      totalMinor: '115',
      authorizationId: null,
    });
    const items = await h.env.sql(
      `SELECT description, amount_minor::text a FROM commerce.order_items WHERE order_id = $1`,
      [o.id],
    );
    expect(items).toHaveLength(1);
    await expect(orders().createFromQuote(orgA, q.id, ids.erin!)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await audits(orgA, 'commerce.order.created')).length).toBe(1);
  });

  it('over the cap, an order is refused until a second person approves exactly that quote; the approval is used once', async () => {
    const q = (await quote('1000')).json();
    expect(q.requiresApproval).toBe(true);
    await expect(orders().createFromQuote(orgA, q.id, ids.erin!)).rejects.toMatchObject({
      code: 'spend_approval_required',
    });
    const a = (await requestApproval(q.id, '1150')).json();
    await expect(orders().createFromQuote(orgA, q.id, ids.erin!)).rejects.toMatchObject({
      code: 'spend_approval_required',
    }); // pending is not approved
    expect((await decide(a.id)).statusCode).toBe(200);
    const o = await orders().createFromQuote(orgA, q.id, ids.erin!);
    expect(o.spendApprovalId).toBe(a.id);
    const auth = (
      await h.env.sql(
        `SELECT kind, spend_approval_id, amount_minor::text amt FROM commerce.authorizations WHERE order_id = $1`,
        [o.id],
      )
    )[0]!;
    expect(auth).toMatchObject({ kind: 'spend_approval', spend_approval_id: a.id, amt: '1150' });
    // another quote cannot ride on the same approval, in the service or in the database
    const q2 = (await quote('1000')).json();
    await expect(orders().createFromQuote(orgA, q2.id, ids.erin!)).rejects.toMatchObject({
      code: 'spend_approval_required',
    });
    await expect(
      h.env.sql(
        `INSERT INTO commerce.authorizations (id, org_id, kind, order_id, spend_approval_id, amount_minor, currency) VALUES (gen_random_uuid(), '${orgA}', 'spend_approval', '${o.id}', '${a.id}', 1, 'SAR')`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('an approval that does not cover the amount, or was denied, does not authorize the order', async () => {
    const q = (await quote('1000')).json();
    const low = (await requestApproval(q.id, '1000')).json(); // quote total is 1150
    await decide(low.id);
    await expect(orders().createFromQuote(orgA, q.id, ids.erin!)).rejects.toMatchObject({
      code: 'spend_approval_required',
    });
    const q2 = (await quote('1000')).json();
    const denied = (await requestApproval(q2.id, '1150')).json();
    await decide(denied.id, 'deny');
    await expect(orders().createFromQuote(orgA, q2.id, ids.erin!)).rejects.toMatchObject({
      code: 'spend_approval_required',
    });
  });

  it('an expired quote is refused (410); an unknown or foreign quote is 404', async () => {
    const q = (await quote('10')).json();
    await expect(
      orders().createFromQuote(orgA, q.id, ids.erin!, new Date(Date.parse(q.expiresAt) + 1)),
    ).rejects.toMatchObject({ code: 'gone' });
    await expect(orders().createFromQuote(orgA, uuid(), ids.erin!)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(orders().createFromQuote(orgB, q.id, ids.bob!)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a hard quota is re-checked when the order is placed', async () => {
    // earlier approvals already count as committed spend: raise the cap so only the quota is under test
    await app
      .get(SpendService)
      .putLimit(
        orgA,
        { scope: 'org', monthlyCapMinor: '100000000', currency: 'SAR' },
        1,
        ids.alice!,
      );
    const q = (await quote('50')).json();
    await app
      .get(EntitlementService)
      .setOverride(orgA, { kind: 'meter_limit', key: 'ai', limit: '10', mode: 'hard' });
    await expect(orders().createFromQuote(orgA, q.id, ids.erin!)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    await app
      .get(EntitlementService)
      .setOverride(orgA, { kind: 'meter_limit', key: 'ai', limit: '1000000', mode: 'soft' });
    expect((await orders().createFromQuote(orgA, q.id, ids.erin!)).status).toBe('created');
  });

  it('parallel orders for one quote create exactly one order', async () => {
    const q = (await quote('20')).json();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => orders().createFromQuote(orgA, q.id, ids.erin!)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results)
      if (r.status === 'rejected') expect((r.reason as { code: string }).code).toBe('conflict');
    expect(
      (
        await h.env.sql(`SELECT count(*)::int n FROM commerce.orders WHERE quote_id = $1`, [q.id])
      )[0]!.n,
    ).toBe(1);
  });

  it('order terms are frozen; only the status may move, and nothing is deleted', async () => {
    const o = (
      await h.env.sql(`SELECT id FROM commerce.orders WHERE org_id = $1 LIMIT 1`, [orgA])
    )[0]!;
    await expect(
      h.env.app.withOrg(orgA, (c) =>
        c.query(`UPDATE commerce.orders SET total_minor = 1 WHERE id = $1`, [o.id]),
      ),
    ).rejects.toThrow();
    await expect(
      h.env.sql(`UPDATE commerce.orders SET total_minor = 1 WHERE id = '${o.id}'`),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.env.app.withOrg(orgA, (c) =>
        c.query(`UPDATE commerce.orders SET status = 'fulfilled' WHERE id = $1`, [o.id]),
      ),
    ).resolves.toBeDefined();
    await expect(h.env.sql(`DELETE FROM commerce.orders WHERE id = '${o.id}'`)).rejects.toThrow();
    await expect(h.env.sql(`DELETE FROM commerce.authorizations`)).rejects.toThrow();
  });
});

describe('manual ledger adjustments (two-person approval)', () => {
  let grantTx = '';
  const wallet = async () =>
    (
      await h.env.sql(
        `SELECT balance_minor::text b FROM billing.wallet_balances WHERE org_id=$1 AND currency='SAR'`,
        [orgA],
      )
    )[0]?.b;
  const refresh = () =>
    h.env.app.withOrg(orgA, (c) => c.query('SELECT billing.refresh_wallet($1)', [orgA]));

  beforeAll(async () => {
    const r = await app.get(LedgerPostingService).post(
      recipes.creditGrant({
        orgId: orgA,
        amountMinor: 1000,
        currency: 'SAR',
        reason: 'welcome credit',
      }),
      'welcome-1',
    );
    grantTx = r.transactionId;
    await refresh();
  });

  it('finance files a request; a replay with the same key is the same request; a different body under the same key is refused', async () => {
    const body = { orgId: orgA, reverses: grantTx, reason: 'granted by mistake' };
    const r = await adminPost('fin1', body, 'adj-key-1');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      status: 'pending',
      orgId: orgA,
      reversesTransactionId: grantTx,
      requestedBy: ids.fin1,
      transactionId: null,
    });
    const again = await adminPost('fin1', body, 'adj-key-1');
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(r.json().id);
    expect(
      (await adminPost('fin1', { ...body, reason: 'different' }, 'adj-key-1')).json().code,
    ).toBe('idempotency_key_reuse');
    expect((await adminPost('fin1', body, null)).statusCode).toBe(400);
    expect(await wallet()).toBe('1000'); // nothing posted yet
    expect(
      (
        await h.env.sql(
          `SELECT count(*)::int n FROM billing.ledger_transactions WHERE reverses_id = $1`,
          [grantTx],
        )
      )[0]!.n,
    ).toBe(0);
  });

  it('only finance requests; support and platform_admin cannot; customers cannot reach the route', async () => {
    const body = { orgId: orgA, reverses: grantTx, reason: 'x' };
    expect((await adminPost('sup', body)).statusCode).toBe(403);
    expect((await adminPost('root', body)).statusCode).toBe(403); // platform_admin approves but does not request
    const asCustomer = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/adjustments',
      headers: {
        cookie: cookieHeader(jars.alice!),
        'x-csrf-token': jars.alice!.nuzm_csrf!,
        'idempotency-key': 'x',
      },
      payload: body,
    });
    expect([401, 403, 404]).toContain(asCustomer.statusCode);
    const none = (
      await h.env.app.withOrg(orgA, (c) =>
        c.query(`SELECT count(*)::int n FROM billing.adjustment_requests`),
      )
    ).rows[0]!.n;
    expect(none).toBe(0); // an organization-scoped session sees no adjustment requests
  });

  it('the requester cannot approve; a second person approves and the reversal is posted exactly once', async () => {
    const id = (
      await h.env.sql(
        `SELECT id FROM billing.adjustment_requests WHERE reverses_transaction_id = $1`,
        [grantTx],
      )
    )[0]!.id;
    expect((await adminPost('fin1', { adjustmentId: id, decision: 'approve' })).statusCode).toBe(
      403,
    );
    expect((await adminPost('sup', { adjustmentId: id, decision: 'approve' })).statusCode).toBe(
      403,
    );
    const ok = await adminPost('fin2', {
      adjustmentId: id,
      decision: 'approve',
      note: 'confirmed',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      status: 'approved',
      decidedBy: ids.fin2,
      decisionNote: 'confirmed',
    });
    const rev = (
      await h.env.sql(
        `SELECT id, kind, created_by FROM billing.ledger_transactions WHERE reverses_id = $1`,
        [grantTx],
      )
    )[0]!;
    expect(rev).toMatchObject({ kind: 'reversal', created_by: ids.fin2 });
    expect(ok.json().transactionId).toBe(rev.id);
    await refresh();
    expect(await wallet()).toBe('0');
    expect((await adminPost('fin2', { adjustmentId: id, decision: 'approve' })).statusCode).toBe(
      409,
    );
    expect((await adminPost('root', { adjustmentId: id, decision: 'reject' })).statusCode).toBe(
      409,
    );
    expect((await audits(orgA, 'billing.adjustment.approved')).length).toBe(1);
  });

  it('a transaction can be reversed only once; the request must name a transaction of that organization', async () => {
    expect(
      (await adminPost('fin1', { orgId: orgA, reverses: grantTx, reason: 'again' })).statusCode,
    ).toBe(409);
    expect(
      (await adminPost('fin1', { orgId: orgB, reverses: grantTx, reason: 'wrong org' })).statusCode,
    ).toBe(404);
    expect(
      (await adminPost('fin1', { orgId: uuid(), reverses: grantTx, reason: 'no org' })).statusCode,
    ).toBe(404);
  });

  it('explicit balanced lines are posted on approval; unbalanced or ambiguous requests are refused up front', async () => {
    const lines = [
      {
        account: { code: '4900', org: false },
        direction: 'debit',
        amountMinor: '500',
        currency: 'SAR',
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: '500',
        currency: 'SAR',
      },
    ];
    const bad: object[] = [
      { orgId: orgA, reason: 'r', lines: [lines[0]] },
      { orgId: orgA, reason: 'r', lines: [lines[0], { ...lines[1], amountMinor: '499' }] },
      { orgId: orgA, reason: 'r', lines: [lines[0], { ...lines[1], amountMinor: '5.0' }] },
      { orgId: orgA, reason: 'r', lines, reverses: grantTx },
      { orgId: orgA, reason: 'r' },
      { orgId: orgA, reason: '', lines },
      { orgId: 'nope', reason: 'r', lines },
    ];
    for (const b of bad)
      expect((await adminPost('fin1', b)).statusCode, JSON.stringify(b).slice(0, 90)).toBe(422);
    const r = (await adminPost('fin1', { orgId: orgA, reason: 'goodwill credit', lines })).json();
    expect(r.status).toBe('pending');
    const done = await adminPost('root', { adjustmentId: r.id, decision: 'approve' }); // platform_admin may approve
    expect(done.statusCode).toBe(200);
    const tx = (
      await h.env.sql(`SELECT kind, created_by FROM billing.ledger_transactions WHERE id = $1`, [
        done.json().transactionId,
      ])
    )[0]!;
    expect(tx).toMatchObject({ kind: 'adjustment', created_by: ids.root });
    await refresh();
    expect(await wallet()).toBe('500');
  });

  it('a rejection posts nothing and is final', async () => {
    const lines = [
      {
        account: { code: '4900', org: false },
        direction: 'debit',
        amountMinor: '70',
        currency: 'SAR',
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: '70',
        currency: 'SAR',
      },
    ];
    const r = (await adminPost('fin1', { orgId: orgA, reason: 'maybe', lines })).json();
    const before = (await h.env.sql(`SELECT count(*)::int n FROM billing.ledger_transactions`))[0]!
      .n;
    const rej = await adminPost('fin2', { adjustmentId: r.id, decision: 'reject', note: 'no' });
    expect(rej.json()).toMatchObject({ status: 'rejected', transactionId: null });
    expect((await h.env.sql(`SELECT count(*)::int n FROM billing.ledger_transactions`))[0]!.n).toBe(
      before,
    );
    expect((await adminPost('root', { adjustmentId: r.id, decision: 'approve' })).statusCode).toBe(
      409,
    );
    expect((await adminPost('fin2', { adjustmentId: r.id, decision: 'maybe' })).statusCode).toBe(
      422,
    );
    expect(
      (await adminPost('fin2', { adjustmentId: uuid(), decision: 'approve' })).statusCode,
    ).toBe(404);
    expect((await audits(orgA, 'billing.adjustment.rejected')).length).toBe(1);
  });

  it('a retry after an uncertain result reconciles instead of double posting', async () => {
    const lines = [
      {
        account: { code: '4900', org: false },
        direction: 'debit',
        amountMinor: '30',
        currency: 'SAR',
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: '30',
        currency: 'SAR',
      },
    ];
    const r = (await adminPost('fin1', { orgId: orgA, reason: 'crash test', lines })).json();
    // simulate: the first attempt posted to the ledger and died before updating the request
    const first = await app.get(LedgerPostingService).post(
      recipes.adjustment({
        orgId: orgA,
        lines: lines as recipes.PostingLine[],
        reason: 'crash test',
      }),
      `adjustment:${r.id}`,
      ids.fin2,
    );
    const ok = await adminPost('fin2', { adjustmentId: r.id, decision: 'approve' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().transactionId).toBe(first.transactionId);
    expect(
      (
        await h.env.sql(
          `SELECT count(*)::int n FROM billing.ledger_transactions WHERE idempotency_key = $1`,
          [`adjustment:${r.id}`],
        )
      )[0]!.n,
    ).toBe(1);
  });

  it('decided requests are final at the database level and cannot be deleted', async () => {
    const id = (
      await h.env.sql(
        `SELECT id FROM billing.adjustment_requests WHERE status = 'approved' LIMIT 1`,
      )
    )[0]!.id;
    for (const sql of [
      `UPDATE billing.adjustment_requests SET status = 'rejected' WHERE id = '${id}'`,
      `UPDATE billing.adjustment_requests SET reason = 'edited' WHERE id = '${id}'`,
      `DELETE FROM billing.adjustment_requests WHERE id = '${id}'`,
      `TRUNCATE billing.adjustment_requests`,
    ])
      await expect(h.env.sql(sql), sql).rejects.toThrow();
    // the approver can never be the requester: a table constraint, not only service logic
    const lines = [
      {
        account: { code: '4900', org: false },
        direction: 'debit',
        amountMinor: '9',
        currency: 'SAR',
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: '9',
        currency: 'SAR',
      },
    ];
    const pending = (
      await adminPost('fin1', { orgId: orgA, reason: 'constraint test', lines })
    ).json();
    await expect(
      h.env.sql(
        `UPDATE billing.adjustment_requests SET status='approved', decided_by = requested_by, decided_at = now() WHERE id = '${pending.id}'`,
      ),
    ).rejects.toThrow(/check/i);
  });
});
