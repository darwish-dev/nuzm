import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { EntitlementService, SubscriptionService } from '../billing';
import { MockPsp } from '../payments';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows and private wiring in tests */
type Row = Record<string, any>;

const h = new Harness();
let app: App;
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const V: Record<string, string> = {}; // plan version ids by key
let orgSeq = 0;

const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const count = async (q: string, p: unknown[] = []) => Number((await sql(q, p))[0]!.n);
const svc = () => app.get(SubscriptionService);
const mock = () => app.get(MockPsp);
const D = (s: string) => new Date(`${s}T10:00:00Z`);

const call = (
  who: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  org: string,
  body?: object,
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

/** A fresh organization owned by alice with one saved method per scenario token. */
const newOrg = async (): Promise<{ org: string; ok: string; decline: string }> => {
  const n = ++orgSeq;
  const org = (
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jars.alice!), 'x-csrf-token': jars.alice!.nuzm_csrf! },
      payload: { name: `Sub Org ${n}` },
    })
  ).json().id as string;
  const add = async (token: string, card: string) => {
    const r = await call('alice', 'POST', '/v1/billing/payment-methods', org, {
      provider: 'mock',
      setupToken: `${token}_${card}${n}`,
    });
    expect(r.statusCode, token).toBe(201);
    return r.json().id as string;
  };
  return {
    org,
    ok: await add('tok_mock_success', 'a'),
    decline: await add('tok_mock_decline', 'b'),
  };
};
const invoiceByKey = async (org: string, key: string) =>
  (
    await sql(
      `SELECT id, status, total_minor::text total, subtotal_minor::text net, period_start::text ps, period_end::text pe FROM invoicing.invoices WHERE org_id = $1 AND source_key = $2`,
      [org, key],
    )
  )[0];
const invoiceCount = (org: string) =>
  count(`SELECT count(*)::int n FROM invoicing.invoices WHERE org_id = $1`, [org]);
const subRow = async (id: string) =>
  (
    await sql(
      `SELECT *, period_start::text ps, period_end::text pe, trial_end::text te FROM billing.subscriptions WHERE id = $1`,
      [id],
    )
  )[0]!;
const planOf = async (org: string) => (await app.get(EntitlementService).resolve(org)).plan.key;
const create = (org: string, plan: string, method: string, now: Date, extra: object = {}) =>
  svc().create(org, ids.alice!, { planVersionId: V[plan], paymentMethodId: method, ...extra }, now);

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  // plans: starter 30.00, pro 60.00 (flat fees in a non-placeholder price book), nofee (published, no price), draftplan (unpublished)
  const publisher = '00000000-0000-0000-0000-000000000001';
  V.starter = (
    await sql(
      `SELECT v.id FROM billing.plans p JOIN billing.plan_versions v ON v.plan_id = p.id WHERE p.key = 'starter' AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`,
    )
  )[0]!.id; // seeded (M02)
  await sql(
    `INSERT INTO metering.meters (id, unit, aggregation_window, basis) VALUES ('plan.starter_months','subscription_month','day','subscription')`,
  );
  for (const [key, fee] of [
    ['pro', 6000],
    ['nofee', null],
    ['draftplan', 1000],
  ] as const) {
    const pid = crypto.randomUUID();
    const vid = crypto.randomUUID();
    V[key] = vid;
    await sql(`INSERT INTO billing.plans (id, key, name_ar, name_en) VALUES ($1,$2,$2,$2)`, [
      pid,
      key,
    ]);
    await sql(
      `INSERT INTO billing.plan_versions (id, plan_id, version, status, currency, published_at, published_by) VALUES ($1,$2,1,$3,'SAR',$4,$5)`,
      [
        vid,
        pid,
        key === 'draftplan' ? 'draft' : 'published',
        key === 'draftplan' ? null : new Date(),
        key === 'draftplan' ? null : publisher,
      ],
    );
    if (fee !== null)
      await sql(
        `INSERT INTO metering.meters (id, unit, aggregation_window, basis) VALUES ($1,'subscription_month','day','subscription')`,
        [`plan.${key}_months`],
      );
  }
  const book = crypto.randomUUID();
  const bv = crypto.randomUUID();
  await sql(
    `INSERT INTO billing.price_books (id, name, currency, placeholder) VALUES ($1,'subs-test','SAR',false)`,
    [book],
  );
  await sql(
    `INSERT INTO billing.price_book_versions (id, price_book_id, version, status, effective_from) VALUES ($1,$2,1,'draft','2026-01-01T00:00:00Z')`,
    [bv, book],
  );
  for (const [m, price] of [
    ['plan.starter_months', '3000'],
    ['plan.pro_months', '6000'],
    ['plan.draftplan_months', '1000'],
  ])
    await sql(
      `INSERT INTO billing.price_items (id, version_id, meter_id, tier_model, unit_price_minor) VALUES (gen_random_uuid(),$1,$2,'flat',$3)`,
      [bv, m, price],
    );
  await sql(
    `UPDATE billing.price_book_versions SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`,
    [bv, publisher],
  );
  await sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), (SELECT id FROM tenancy.organizations LIMIT 1), $1, 'viewer') ON CONFLICT DO NOTHING`,
    [ids.carol],
  );
});
afterAll(() => h.close());

describe('subscribe (HTTP)', () => {
  it('subscribes: the fee is frozen from the price book, the first period is invoiced and paid, the plan is assigned', async () => {
    const { org, ok } = await newOrg();
    const r = await call('alice', 'POST', '/v1/billing/subscriptions', org, {
      planVersionId: V.starter,
      paymentMethodId: ok,
      quantity: 2,
    });
    expect(r.statusCode).toBe(201);
    expect(r.headers.etag).toBeTruthy();
    const s = r.json();
    expect(s).toMatchObject({
      planKey: 'starter',
      status: 'active',
      currency: 'SAR',
      quantity: 2,
      amountPerPeriodMinor: '6000',
      cancelAtPeriodEnd: false,
      trialEnd: null,
      pendingCreditMinor: '0',
    });
    expect(s.latestInvoiceId).toBeTruthy();
    const inv = (
      await sql(
        `SELECT status, subtotal_minor::text net, total_minor::text total, paid_minor::text paid FROM invoicing.invoices WHERE id = $1`,
        [s.latestInvoiceId],
      )
    )[0]!;
    expect(inv).toMatchObject({ status: 'paid', net: '6000' });
    expect(inv.paid).toBe(inv.total);
    expect(await planOf(org)).toBe('starter');
    // the invoice line is a subscription charge on revenue account 4200
    expect(
      (
        await sql(
          `SELECT kind, revenue_account FROM invoicing.invoice_lines WHERE invoice_id = $1`,
          [s.latestInvoiceId],
        )
      )[0],
    ).toMatchObject({ kind: 'subscription', revenue_account: '4200' });
    const row = await subRow(s.id);
    expect(row.items[0]).toMatchObject({ meterId: 'plan.starter_months', unitPriceMinor: '3000' });
    expect(row.pending_invoice).toBeNull();
    const get = await call('alice', 'GET', `/v1/billing/subscriptions/${s.id}`, org);
    expect(get.statusCode).toBe(200);
    expect(get.headers.etag).toBe(r.headers.etag);
    expect(
      (await call('alice', 'GET', '/v1/billing/subscriptions', org)).json().items,
    ).toHaveLength(1);
  });

  it('refuses: no payment method, unknown method, bad quantity, unpriced / draft plans, a second live subscription, viewers', async () => {
    const { org, ok } = await newOrg();
    const post = (b: object, who = 'alice') =>
      call(who, 'POST', '/v1/billing/subscriptions', org, b);
    expect((await post({ planVersionId: V.starter })).statusCode).toBe(422);
    expect((await post({ planVersionId: V.starter })).json().code ?? '').toMatch(
      /payment_method_required|/,
    );
    expect(
      (await post({ planVersionId: V.starter, paymentMethodId: crypto.randomUUID() })).statusCode,
    ).toBe(404);
    for (const q of [0, 1001, 1.5, '2'])
      expect(
        (await post({ planVersionId: V.starter, paymentMethodId: ok, quantity: q })).statusCode,
        String(q),
      ).toBe(422);
    expect((await post({ planVersionId: V.nofee, paymentMethodId: ok })).statusCode).toBe(422); // no price configured: never an invented price
    expect((await post({ planVersionId: V.draftplan, paymentMethodId: ok })).statusCode).toBe(409); // unpublished
    expect(
      (await post({ planVersionId: crypto.randomUUID(), paymentMethodId: ok })).statusCode,
    ).toBe(404);
    expect(
      (await post({ planVersionId: V.starter, paymentMethodId: ok }, 'carol')).statusCode,
    ).toBeGreaterThanOrEqual(403);
    expect((await post({ planVersionId: V.starter, paymentMethodId: ok })).statusCode).toBe(201);
    expect((await post({ planVersionId: V.pro, paymentMethodId: ok })).statusCode).toBe(409);
    expect(await invoiceCount(org)).toBe(1);
  });

  it('another organization cannot read or change it', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const s = (
      await call('alice', 'POST', '/v1/billing/subscriptions', a.org, {
        planVersionId: V.starter,
        paymentMethodId: a.ok,
      })
    ).json();
    expect(
      (await call('alice', 'GET', `/v1/billing/subscriptions/${s.id}`, b.org)).statusCode,
    ).toBe(404);
    expect(
      (await call('alice', 'POST', `/v1/billing/subscriptions/${s.id}/cancellation`, b.org, {}))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call('alice', 'PATCH', `/v1/billing/subscriptions/${s.id}`, b.org, {
          quantity: 2,
          preview: true,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('renewal engine', () => {
  it('renews exactly once per period: not before the end, one invoice, 5 concurrent runs still one', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    expect(s).toMatchObject({
      status: 'active',
      currentPeriodStart: '2026-11-01',
      currentPeriodEnd: '2026-12-01',
    });
    expect(await invoiceByKey(org, `subscription:${s.id}:2026-11-01`)).toMatchObject({
      status: 'paid',
      ps: '2026-11-01',
      pe: '2026-11-30',
    });
    expect(await svc().renew(org, s.id, D('2026-11-30'))).toEqual({
      periodsBilled: 0,
      cancelled: false,
    });
    const runs = await Promise.all(
      Array.from({ length: 5 }, () => svc().renew(org, s.id, D('2026-12-01'))),
    );
    expect(runs.reduce((n, r) => n + r.periodsBilled, 0)).toBe(1);
    expect(await invoiceCount(org)).toBe(2);
    expect(await invoiceByKey(org, `subscription:${s.id}:2026-12-01`)).toMatchObject({
      status: 'paid',
      ps: '2026-12-01',
      pe: '2026-12-31',
    });
    expect(await svc().get(org, s.id)).toMatchObject({
      currentPeriodStart: '2026-12-01',
      currentPeriodEnd: '2027-01-01',
      status: 'active',
    });
    expect(await svc().renew(org, s.id, D('2026-12-01'))).toEqual({
      periodsBilled: 0,
      cancelled: false,
    });
    expect(mock().duplicateCharges).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int n FROM platform.outbox WHERE org_id = $1 AND topic = 'subscription.renewed'`,
        [org],
      ),
    ).toBe(1);
  });

  it('catches up every missed period when the scheduler was down (4 invoices, in order)', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    const r = await svc().renew(org, s.id, D('2027-03-02'));
    expect(r.periodsBilled).toBe(4);
    expect(await invoiceCount(org)).toBe(5);
    expect(await svc().get(org, s.id)).toMatchObject({
      currentPeriodStart: '2027-03-01',
      currentPeriodEnd: '2027-04-01',
    });
  });

  it('keeps the anchor day across short months (31 → 28 → 31)', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-01-31'));
    expect(s.currentPeriodEnd).toBe('2026-02-28');
    await svc().renew(org, s.id, D('2026-02-28'));
    expect((await svc().get(org, s.id)).currentPeriodEnd).toBe('2026-03-31');
  });

  it('runDue renews what is due across organizations and reports failures per subscription', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const sa = await create(a.org, 'starter', a.ok, D('2026-06-01'));
    const sb = await create(b.org, 'pro', b.ok, D('2026-06-01'));
    const r = await svc().runDue(D('2026-07-01'), 500);
    expect(r.failed).toBe(0);
    expect(r.renewed).toBeGreaterThanOrEqual(2);
    expect((await svc().get(a.org, sa.id)).currentPeriodStart).toBe('2026-07-01');
    expect((await svc().get(b.org, sb.id)).currentPeriodStart).toBe('2026-07-01');
    expect((await svc().runDue(D('2026-07-01'), 500)).renewed).toBe(0);
  });

  it('a crash after advancing the period (invoice not issued) is repaired by the next run: never lost, never doubled', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    const real: any = svc();
    let boom = true;
    const flaky = new SubscriptionService(
      real.db,
      real.audit,
      real.prices,
      real.entitlements,
      {
        ...real.ports,
        invoices: {
          ...real.ports.invoices,
          issueCharge: (...a: any[]) => {
            if (boom) {
              boom = false;
              throw new Error('process died');
            }
            return real.ports.invoices.issueCharge(...a);
          },
        },
      },
      real.policy,
    );
    await expect(flaky.renew(org, s.id, D('2026-12-01'))).rejects.toThrow('process died');
    const mid = await subRow(s.id);
    expect(mid.ps).toBe('2026-12-01'); // advanced...
    expect(mid.pending_invoice).not.toBeNull(); // ...with the invoice intent recorded in the same transaction
    expect(await invoiceByKey(org, `subscription:${s.id}:2026-12-01`)).toBeUndefined();
    await svc().runDue(D('2026-12-01'), 500);
    expect(await invoiceByKey(org, `subscription:${s.id}:2026-12-01`)).toMatchObject({
      status: 'paid',
    });
    expect((await subRow(s.id)).pending_invoice).toBeNull();
    expect(await invoiceCount(org)).toBe(2);
  });

  it('a crash between issuing and paying re-finds the invoice and charges once', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    const real: any = svc();
    let boom = true;
    const flaky = new SubscriptionService(
      real.db,
      real.audit,
      real.prices,
      real.entitlements,
      {
        ...real.ports,
        payments: {
          pay: (...a: any[]) => {
            if (boom) {
              boom = false;
              throw new Error('process died');
            }
            return real.ports.payments.pay(...a);
          },
        },
      },
      real.policy,
    );
    await expect(flaky.renew(org, s.id, D('2026-12-01'))).rejects.toThrow('process died');
    const key = `subscription:${s.id}:2026-12-01`;
    expect(await invoiceByKey(org, key)).toMatchObject({ status: 'open' });
    await svc().renew(org, s.id, D('2026-12-01'));
    expect(await invoiceByKey(org, key)).toMatchObject({ status: 'paid' });
    expect(await invoiceCount(org)).toBe(2);
    expect(
      await count(
        `SELECT count(*)::int n FROM payments.payment_intents WHERE org_id = $1 AND status = 'succeeded'`,
        [org],
      ),
    ).toBe(2);
  });
});

describe('payment failures', () => {
  it('a declined first payment leaves the subscription past_due, the plan NOT assigned; paying the invoice recovers it', async () => {
    const { org, ok, decline } = await newOrg();
    const s = await create(org, 'starter', decline, D('2026-11-01'));
    expect(s.status).toBe('past_due');
    expect(await planOf(org)).toBe('free');
    const inv = await invoiceByKey(org, `subscription:${s.id}:2026-11-01`);
    expect(inv!.status).toBe('open');
    const paid = await call('alice', 'POST', '/v1/billing/payments', org, {
      invoiceId: inv!.id,
      paymentMethodId: ok,
      returnUrl: 'http://127.0.0.1:3000/en/billing/payment-return',
    });
    expect(paid.json().status).toBe('succeeded');
    expect(await svc().runDue(D('2026-11-02'), 500)).toMatchObject({ settled: 1 });
    expect((await svc().get(org, s.id)).status).toBe('active');
    expect(await planOf(org)).toBe('starter');
  });

  it('a declined renewal makes an active subscription past_due (the plan stays); a past_due one is not renewed again', async () => {
    const { org, ok, decline } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    const patch = await svc().change(
      org,
      ids.alice!,
      s.id,
      { paymentMethodId: decline },
      s.version,
      D('2026-11-02'),
    );
    expect(patch.applied).toBe(true);
    await svc().renew(org, s.id, D('2026-12-01'));
    expect(await svc().get(org, s.id)).toMatchObject({
      status: 'past_due',
      currentPeriodStart: '2026-12-01',
    });
    expect(await planOf(org)).toBe('starter');
    expect(await svc().renew(org, s.id, D('2027-02-01'))).toEqual({
      periodsBilled: 0,
      cancelled: false,
    });
    expect(await invoiceCount(org)).toBe(2);
    // past_due subscriptions cannot be changed until the invoice is settled
    expect(
      (
        await call(
          'alice',
          'PATCH',
          `/v1/billing/subscriptions/${s.id}`,
          org,
          { quantity: 2 },
          { 'if-match': `"${(await svc().get(org, s.id)).version}"` },
        )
      ).statusCode,
    ).toBe(409);
  });
});

describe('plan and quantity changes', () => {
  const PATCH = (org: string, id: string, body: object, version?: number) =>
    call(
      'alice',
      'PATCH',
      `/v1/billing/subscriptions/${id}`,
      org,
      body,
      version === undefined ? {} : { 'if-match': `"${version}"` },
    );

  it('preview shows the proration and changes nothing; it needs no If-Match', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    const before = await subRow(s.id);
    const r = await svc().change(
      org,
      ids.alice!,
      s.id,
      { planVersionId: V.pro, preview: true },
      null,
      D('2026-11-16'),
    );
    expect(r.applied).toBe(false);
    expect(r.proration).toMatchObject({
      effect: 'charge',
      daysTotal: 30,
      daysLeft: 15,
      unusedCreditMinor: '1500',
      newChargeMinor: '3000',
      netMinor: '1500',
      oldAmountPerPeriodMinor: '3000',
      newAmountPerPeriodMinor: '6000',
    });
    const after = await subRow(s.id);
    expect(after.version).toBe(before.version);
    expect(after.plan_version_id).toBe(before.plan_version_id);
    expect(await invoiceCount(org)).toBe(1);
  });

  it('upgrade: the prorated difference is invoiced and paid at once, the plan switches, the version moves on; stale/missing ETag is refused', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    await expect(
      svc().change(org, ids.alice!, s.id, { planVersionId: V.pro }, null, D('2026-11-16')),
    ).rejects.toThrow(/If-Match header required/);
    await expect(
      svc().change(org, ids.alice!, s.id, { planVersionId: V.pro }, 999, D('2026-11-16')),
    ).rejects.toThrow(/Precondition failed/);
    const r = await svc().change(
      org,
      ids.alice!,
      s.id,
      { planVersionId: V.pro },
      s.version,
      D('2026-11-16'),
    );
    expect(r.applied).toBe(true);
    expect(r.subscription.version).toBeGreaterThan(s.version);
    expect(r.subscription).toMatchObject({
      planKey: 'pro',
      amountPerPeriodMinor: '6000',
      status: 'active',
    }); // change + entitlement bookkeeping
    const inv = await invoiceByKey(org, `subscription:${s.id}:change:${s.version}`);
    expect(inv).toMatchObject({ status: 'paid', net: '1500' });
    expect(await planOf(org)).toBe('pro');
    // retrying the same change with the old version is refused and does not charge again
    await expect(
      svc().change(org, ids.alice!, s.id, { planVersionId: V.pro }, s.version, D('2026-11-16')),
    ).rejects.toThrow(/Precondition failed/);
    expect(await invoiceCount(org)).toBe(2);
    // HTTP: 428 without If-Match
    expect((await PATCH(org, s.id, { quantity: 3 })).statusCode).toBe(428);
    expect((await PATCH(org, s.id, { quantity: 3 }, 1)).statusCode).toBe(412);
  });

  it('downgrade: the unused value becomes a credit applied to the next renewal (no negative invoice line)', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'pro', ok, D('2026-11-01'));
    const r = await svc().change(
      org,
      ids.alice!,
      s.id,
      { planVersionId: V.starter },
      s.version,
      D('2026-11-16'),
    );
    expect(r.proration).toMatchObject({ effect: 'credit', netMinor: '-1500' });
    expect(r.subscription).toMatchObject({ planKey: 'starter', pendingCreditMinor: '1500' });
    expect(await invoiceCount(org)).toBe(1); // nothing invoiced now
    await svc().renew(org, s.id, D('2026-12-01'));
    const inv = await invoiceByKey(org, `subscription:${s.id}:2026-12-01`);
    expect(inv).toMatchObject({ net: '1500' }); // 3000 fee − 1500 credit
    expect((await svc().get(org, s.id)).pendingCreditMinor).toBe('0');
    expect(
      (
        await sql(`SELECT description FROM invoicing.invoice_lines WHERE invoice_id = $1`, [
          inv!.id,
        ])
      )[0]!.description,
    ).toMatch(/after 1500 credit/);
  });

  it('a credit larger than the renewal covers it fully: no invoice for the period and the remainder is kept', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    await sql(`UPDATE billing.subscriptions SET pending_credit_minor = 4000 WHERE id = $1`, [s.id]);
    await svc().renew(org, s.id, D('2026-12-01'));
    expect(await invoiceByKey(org, `subscription:${s.id}:2026-12-01`)).toBeUndefined();
    expect(await svc().get(org, s.id)).toMatchObject({
      status: 'active',
      currentPeriodStart: '2026-12-01',
      pendingCreditMinor: '1000',
    });
  });

  it('quantity change prorates like a plan change; prorationMode none switches with no charge or credit', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    const up = await svc().change(
      org,
      ids.alice!,
      s.id,
      { quantity: 3 },
      s.version,
      D('2026-11-16'),
    );
    expect(up.proration).toMatchObject({ netMinor: '3000', newAmountPerPeriodMinor: '9000' }); // (9000 − 3000) × 15/30
    const none = await svc().change(
      org,
      ids.alice!,
      s.id,
      { quantity: 5, prorationMode: 'none' },
      up.subscription.version,
      D('2026-11-16'),
    );
    expect(none.proration).toMatchObject({ effect: 'none', netMinor: '0' });
    expect(none.subscription).toMatchObject({
      quantity: 5,
      amountPerPeriodMinor: '15000',
      pendingCreditMinor: '0',
    });
    expect(await invoiceCount(org)).toBe(2);
  });

  it('rejects empty, unknown and malformed changes (and previews over HTTP)', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, new Date()); // today: HTTP calls use the real clock
    const cases: [object, number][] = [
      [{}, 422],
      [{ foo: 1 }, 422],
      [{ quantity: 0 }, 422],
      [{ prorationMode: 'x', quantity: 2 }, 422],
      [{ planVersionId: 'nope' }, 422],
      [{ planVersionId: V.nofee }, 422],
      [{ planVersionId: V.draftplan }, 409],
      [{ paymentMethodId: crypto.randomUUID() }, 404],
      [{ quantity: 2, preview: 'yes' }, 422],
    ];
    for (const [b, status] of cases)
      expect((await PATCH(org, s.id, b, s.version)).statusCode, JSON.stringify(b)).toBe(status);
    const prev = await PATCH(org, s.id, { planVersionId: V.pro, preview: true });
    expect(prev.statusCode).toBe(200);
    expect(prev.json()).toMatchObject({ applied: false, proration: { effect: 'charge' } });
  });
});

describe('trial and cancellation', () => {
  const trialSvc = () => {
    const real: any = svc();
    return new SubscriptionService(
      real.db,
      real.audit,
      real.prices,
      real.entitlements,
      real.ports,
      { trialDays: 14, production: () => false },
    );
  };

  it('a trial starts free with the plan assigned, converts to a paid period at its end, and is offered once', async () => {
    const { org, ok } = await newOrg();
    const s = await trialSvc().create(
      org,
      ids.alice!,
      { planVersionId: V.starter, paymentMethodId: ok },
      D('2026-11-01'),
    );
    expect(s).toMatchObject({
      status: 'trialing',
      trialEnd: '2026-11-15',
      currentPeriodEnd: '2026-11-15',
    });
    expect(await invoiceCount(org)).toBe(0);
    expect(await planOf(org)).toBe('starter');
    // a change during the trial is free
    const c = await svc().change(
      org,
      ids.alice!,
      s.id,
      { planVersionId: V.pro },
      s.version,
      D('2026-11-05'),
    );
    expect(c.proration).toMatchObject({ effect: 'none' });
    expect(await invoiceCount(org)).toBe(0);
    expect((await svc().renew(org, s.id, D('2026-11-14'))).periodsBilled).toBe(0);
    expect((await svc().renew(org, s.id, D('2026-11-15'))).periodsBilled).toBe(1);
    expect(await svc().get(org, s.id)).toMatchObject({
      status: 'active',
      trialEnd: null,
      currentPeriodStart: '2026-11-15',
      currentPeriodEnd: '2026-12-15',
    });
    expect(await invoiceByKey(org, `subscription:${s.id}:2026-11-15`)).toMatchObject({
      status: 'paid',
      net: '6000',
    });
    // once per organization: after cancelling there is no second trial
    await svc().cancel(org, ids.alice!, s.id, {});
    await svc().renew(org, s.id, D('2026-12-15'));
    const again = await trialSvc().create(
      org,
      ids.alice!,
      { planVersionId: V.starter, paymentMethodId: ok },
      D('2026-12-20'),
    );
    expect(again.status).toBe('active');
  });

  it('a trial cancelled before its end never charges', async () => {
    const { org, ok } = await newOrg();
    const s = await trialSvc().create(
      org,
      ids.alice!,
      { planVersionId: V.starter, paymentMethodId: ok },
      D('2026-11-01'),
    );
    await svc().cancel(org, ids.alice!, s.id, { reason: 'not needed' });
    expect((await svc().renew(org, s.id, D('2026-11-15'))).cancelled).toBe(true);
    expect(await invoiceCount(org)).toBe(0);
    expect(await planOf(org)).toBe('free');
  });

  it('cancel at period end keeps the plan until then, is idempotent, ends with the default plan and nothing more invoiced', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    const c1 = await call('alice', 'POST', `/v1/billing/subscriptions/${s.id}/cancellation`, org, {
      reason: 'moving on',
    });
    expect(c1.statusCode).toBe(200);
    expect(c1.json()).toMatchObject({ cancelAtPeriodEnd: true, status: 'active' });
    const c2 = await call(
      'alice',
      'POST',
      `/v1/billing/subscriptions/${s.id}/cancellation`,
      org,
      {},
    );
    expect(c2.json().version).toBe(c1.json().version); // nothing changed
    expect(await planOf(org)).toBe('starter');
    expect((await svc().renew(org, s.id, D('2026-11-20'))).cancelled).toBe(false);
    expect(await svc().renew(org, s.id, D('2026-12-01'))).toEqual({
      periodsBilled: 0,
      cancelled: true,
    });
    expect(await svc().get(org, s.id)).toMatchObject({ status: 'cancelled' });
    expect(await planOf(org)).toBe('free');
    expect(await invoiceCount(org)).toBe(1);
    expect(
      (await call('alice', 'POST', `/v1/billing/subscriptions/${s.id}/cancellation`, org, {}))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          'alice',
          'PATCH',
          `/v1/billing/subscriptions/${s.id}`,
          org,
          { quantity: 2 },
          { 'if-match': `"${(await svc().get(org, s.id)).version}"` },
        )
      ).statusCode,
    ).toBe(409);
    // the organization may subscribe again
    expect(
      (
        await call('alice', 'POST', '/v1/billing/subscriptions', org, {
          planVersionId: V.pro,
          paymentMethodId: ok,
        })
      ).statusCode,
    ).toBe(201);
  });
});

describe('payment method in use', () => {
  it('a method charged by a live subscription cannot be removed (409); after cancellation it can', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    expect(
      (await call('alice', 'DELETE', `/v1/billing/payment-methods/${ok}`, org)).statusCode,
    ).toBe(409);
    await svc().cancel(org, ids.alice!, s.id, {});
    await svc().renew(org, s.id, D('2026-12-01'));
    expect(
      (await call('alice', 'DELETE', `/v1/billing/payment-methods/${ok}`, org)).statusCode,
    ).toBe(204);
  });
});

describe('subscription database guards', () => {
  it('state machine, one live subscription, forward-only periods, identity, no delete or truncate', async () => {
    const { org, ok } = await newOrg();
    const s = await create(org, 'starter', ok, D('2026-11-01'));
    await expect(
      sql(`UPDATE billing.subscriptions SET status = 'trialing' WHERE id = $1`, [s.id]),
    ).rejects.toThrow(/illegal subscription transition/);
    await expect(
      sql(
        `UPDATE billing.subscriptions SET period_start = '2026-10-01', period_end = '2026-11-01' WHERE id = $1`,
        [s.id],
      ),
    ).rejects.toThrow(/only move forward/);
    await expect(
      sql(`UPDATE billing.subscriptions SET org_id = gen_random_uuid() WHERE id = $1`, [s.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`UPDATE billing.subscriptions SET currency = 'USD' WHERE id = $1`, [s.id]),
    ).rejects.toThrow(/immutable/);
    await expect(sql(`DELETE FROM billing.subscriptions WHERE id = $1`, [s.id])).rejects.toThrow(
      /never deleted/,
    );
    await expect(sql(`TRUNCATE billing.subscriptions`)).rejects.toThrow(
      /never truncated|cannot truncate/,
    );
    await expect(
      sql(
        `INSERT INTO billing.subscriptions (id, org_id, plan_version_id, currency, status, items, payment_method_id, anchor_day, period_start, period_end) VALUES (gen_random_uuid(), $1, $2, 'SAR', 'active', '[{}]', gen_random_uuid(), 1, '2026-11-01', '2026-12-01')`,
        [org, V.starter],
      ),
    ).rejects.toThrow(/subscriptions_one_live_idx/);
    // cancelled is terminal
    await sql(
      `UPDATE billing.subscriptions SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
      [s.id],
    );
    await expect(
      sql(`UPDATE billing.subscriptions SET status = 'active', cancelled_at = NULL WHERE id = $1`, [
        s.id,
      ]),
    ).rejects.toThrow(/cancelled subscription cannot change/);
    // the version moves on with every change (ETag)
    expect((await subRow(s.id)).version).toBeGreaterThan(1);
  });
});
