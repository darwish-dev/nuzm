import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { MockPsp } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

/** S12d: the read-only admin APIs behind UI-M03-13/14/15 (invoices, payments + redacted PSP events, refunds). */
const RETURN = 'http://127.0.0.1:3000/en/billing/payment-return';
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const staff: Record<string, Record<string, string>> = {};
let method = '';
let invSeq = 0;
const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const mock = () => app.get(MockPsp);

const asUser = (who: string, method_: 'GET' | 'POST', url: string, body?: object, org = orgA) =>
  app.inject({
    method: method_,
    url,
    headers: {
      cookie: cookieHeader(jars[who]!),
      'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
      'x-nuzm-org': org,
      'idempotency-key': `k-${Math.random()}`,
    },
    ...(body ? { payload: body } : {}),
  });
const asStaff = (who: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: cookieHeader(staff[who]!) } });
const refund = (who: string, body: object) =>
  app.inject({
    method: 'POST',
    url: '/v1/admin/billing/refunds',
    headers: {
      cookie: cookieHeader(staff[who]!),
      'x-csrf-token': staff[who]!.nuzm_admin_csrf!,
      'idempotency-key': `r-${Math.random()}`,
    },
    payload: body,
  });
const invoice = async (org: string, total: number, status = 'open') => {
  const id = crypto.randomUUID();
  const n = ++invSeq;
  await sql(
    `INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, paid_minor, buyer, seller)
     SELECT $1, $2, id, 'AR', $3::bigint, 'AR-' || $3::text, $6::text, 'sandbox', 'SAR', '2026-11-01', '2026-11-30', now(), now(), $4, $5, 0, $5, CASE WHEN $6::text = 'paid' THEN $5::bigint ELSE 0::bigint END, '{"legalName":{"ar":"مشتري","en":"Buyer"},"vatNumber":"300000000000003","buyerType":"b2b"}', '{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"placeholder":true}' FROM invoicing.billing_entities LIMIT 1`,
    [id, org, n, `ar-fixture-${n}`, total, status],
  );
  return id;
};

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  const mk = async (who: string, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
        payload: { name },
      })
    ).json().id as string;
  orgA = await mk('alice', 'AdminRead A');
  orgB = await mk('bob', 'AdminRead B');
  for (const [name, roles] of Object.entries({
    fin1: ['finance'],
    root: ['platform_admin'],
    sup: ['support'],
    comp: ['compliance_officer'],
  })) {
    const u = await h.platformUser(app, `staff-${name}`, roles);
    ids[name] = u.id;
    staff[name] = u.jar;
  }
  const m = await asUser('alice', 'POST', '/v1/billing/payment-methods', {
    provider: 'mock',
    setupToken: 'tok_mock_success_ar1',
  });
  expect(m.statusCode).toBe(201);
  method = m.json().id;
});
afterAll(() => h.close());

describe('GET /v1/admin/billing/invoices', () => {
  it('finance and platform admins search across organizations; filters and the cursor work', async () => {
    const a1 = await invoice(orgA, 1000);
    const a2 = await invoice(orgA, 2000, 'paid');
    const b1 = await invoice(orgB, 3000);
    const all = await asStaff('fin1', '/v1/admin/billing/invoices?limit=200');
    expect(all.statusCode).toBe(200);
    const got = all.json().items.map((i: Row) => i.id);
    expect(got).toEqual(expect.arrayContaining([a1, a2, b1])); // both organizations in one list
    expect(got.indexOf(b1)).toBeLessThan(got.indexOf(a1)); // newest first
    const one = all.json().items.find((i: Row) => i.id === b1);
    expect(one).toMatchObject({
      orgId: orgB,
      status: 'open',
      currency: 'SAR',
      totalMinor: '3000',
      paidMinor: '0',
      buyerName: { ar: 'مشتري', en: 'Buyer' },
      buyerVatNumber: '300000000000003',
      taxReviewRequired: false,
      einvoice: { state: 'not_generated', environment: null, uuid: null },
    });
    const byOrg = (
      await asStaff('root', `/v1/admin/billing/invoices?org=${orgA}&limit=200`)
    ).json();
    expect(byOrg.items.every((i: Row) => i.orgId === orgA)).toBe(true);
    const paid = (
      await asStaff('fin1', `/v1/admin/billing/invoices?org=${orgA}&status=paid`)
    ).json();
    expect(paid.items.map((i: Row) => i.id)).toEqual([a2]);
    const byNumber = await sql(`SELECT number_text FROM invoicing.invoices WHERE id = $1`, [b1]);
    const num = (
      await asStaff('fin1', `/v1/admin/billing/invoices?number=${byNumber[0]!.number_text}`)
    ).json();
    expect(num.items.map((i: Row) => i.id)).toContain(b1);
    // LIKE metacharacters are literal
    expect(
      (await asStaff('fin1', '/v1/admin/billing/invoices?number=%25')).json().items,
    ).toHaveLength(0);
    const p1 = (await asStaff('fin1', `/v1/admin/billing/invoices?org=${orgA}&limit=1`)).json();
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (
      await asStaff(
        'fin1',
        `/v1/admin/billing/invoices?org=${orgA}&limit=1&cursor=${p1.nextCursor}`,
      )
    ).json();
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
  });

  it('filters by e-invoice state (not_generated matches an invoice with no document)', async () => {
    const inv = await invoice(orgA, 4100);
    const r = (
      await asStaff(
        'fin1',
        `/v1/admin/billing/invoices?org=${orgA}&einvoiceState=not_generated&limit=200`,
      )
    ).json();
    expect(r.items.map((i: Row) => i.id)).toContain(inv);
    const none = (
      await asStaff('fin1', `/v1/admin/billing/invoices?org=${orgA}&einvoiceState=cleared`)
    ).json();
    expect(none.items).toHaveLength(0);
  });

  it('rejects bad filters with 422 and staff without admin:billing:read (support), customers and anonymous callers are refused', async () => {
    for (const q of [
      'status=nope',
      'org=not-a-uuid',
      'einvoiceState=x',
      'from=yesterday',
      'number=' + 'x'.repeat(41),
    ])
      expect((await asStaff('fin1', `/v1/admin/billing/invoices?${q}`)).statusCode, q).toBe(422);
    expect((await asStaff('sup', '/v1/admin/billing/invoices')).statusCode).toBe(403);
    // compliance officers hold admin:billing:read (docs/04 lets them read reconciliations); they may read, nothing here writes
    expect((await asStaff('comp', '/v1/admin/billing/invoices')).statusCode).toBe(200);
    // a customer session is the wrong realm
    const cust = await app.inject({
      method: 'GET',
      url: '/v1/admin/billing/invoices',
      headers: { cookie: cookieHeader(jars.alice!) },
    });
    expect([401, 403]).toContain(cust.statusCode);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/admin/billing/invoices' })).statusCode,
    ).toBe(401);
  });

  it('every read is audited', async () => {
    const before = Number(
      (
        await sql(
          `SELECT count(*)::int n FROM audit.audit_logs WHERE action = 'billing.admin_invoices.read'`,
        )
      )[0]!.n,
    );
    await asStaff('fin1', '/v1/admin/billing/invoices');
    const after = Number(
      (
        await sql(
          `SELECT count(*)::int n FROM audit.audit_logs WHERE action = 'billing.admin_invoices.read'`,
        )
      )[0]!.n,
    );
    expect(after).toBe(before + 1);
  });
});

describe('payments, their PSP events and refunds', () => {
  const pay = async () => {
    const inv = await invoice(orgA, 6500);
    const r = await asUser('alice', 'POST', '/v1/billing/payments', {
      invoiceId: inv,
      returnUrl: RETURN,
      paymentMethodId: method,
    });
    expect(r.statusCode).toBe(201);
    return { paymentId: r.json().id as string, invoiceId: inv };
  };

  it('lists payments across organizations with provider, amounts and event count; filters by invoice and status', async () => {
    const { paymentId, invoiceId } = await pay();
    const list = (await asStaff('fin1', '/v1/admin/billing/payments?limit=200')).json();
    const p = list.items.find((x: Row) => x.id === paymentId);
    expect(p).toMatchObject({
      orgId: orgA,
      invoiceId,
      walletTopupId: null,
      provider: 'mock-sandbox',
      amountMinor: '6500',
      capturedMinor: '6500',
      refundedMinor: '0',
      currency: 'SAR',
      status: 'succeeded',
      failureCode: null,
    });
    const byInvoice = (
      await asStaff('root', `/v1/admin/billing/payments?invoiceId=${invoiceId}`)
    ).json();
    expect(byInvoice.items.map((x: Row) => x.id)).toEqual([paymentId]);
    expect(
      (await asStaff('fin1', `/v1/admin/billing/payments?org=${orgB}&limit=200`))
        .json()
        .items.every((x: Row) => x.orgId === orgB),
    ).toBe(true);
    expect(
      (await asStaff('fin1', '/v1/admin/billing/payments?status=refunded&org=' + orgA))
        .json()
        .items.every((x: Row) => x.status === 'refunded'),
    ).toBe(true);
    for (const q of ['status=nope', 'invoiceId=x', 'org=x', 'to=never'])
      expect((await asStaff('fin1', `/v1/admin/billing/payments?${q}`)).statusCode, q).toBe(422);
    expect((await asStaff('sup', '/v1/admin/billing/payments')).statusCode).toBe(403);
  });

  it('shows the stored events redacted and counts a redelivery (a resend never has a second effect)', async () => {
    const inv = await invoice(orgA, 7000);
    const threeDs = await asUser('alice', 'POST', '/v1/billing/payment-methods', {
      provider: 'mock',
      setupToken: 'tok_mock_3ds_ar2',
    });
    const p = (
      await asUser('alice', 'POST', '/v1/billing/payments', {
        invoiceId: inv,
        returnUrl: RETURN,
        paymentMethodId: threeDs.json().id,
      })
    ).json();
    expect(p.status).toBe('requires_action');
    const ref = (
      await sql(`SELECT merchant_reference mr FROM payments.payment_intents WHERE id = $1`, [p.id])
    )[0]!.mr;
    const ev = mock().complete(ref);
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/webhooks/payments/mock',
        headers: ev.headers,
        payload: ev.rawBody,
      });
    expect((await send()).json().outcome).toBe('processed');
    expect((await send()).json().outcome).toBe('duplicate');
    expect((await send()).json().outcome).toBe('duplicate');
    const r = await asStaff('fin1', `/v1/admin/billing/payments/${p.id}/events`);
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Row[];
    expect(items).toHaveLength(1); // one stored row however often it was resent
    expect(items[0]).toMatchObject({
      provider: 'mock',
      type: 'payment.succeeded',
      status: 'processed',
      error: null,
      duplicateCount: 2,
    });
    expect(items[0]!.lastDuplicateAt).toBeTruthy();
    expect(items[0]!.payload.merchantReference).toBe(ref);
    // provider reference masked, no secret-like keys, no card data
    if (items[0]!.payload.pspPaymentRef)
      expect(items[0]!.payload.pspPaymentRef).toMatch(/^….{0,4}$/);
    expect(JSON.stringify(items)).not.toMatch(/4242|signature|secret|token/i);
    const dup = (await asStaff('fin1', '/v1/admin/billing/payments?org=' + orgA + '&limit=200'))
      .json()
      .items.find((x: Row) => x.id === p.id);
    expect(dup.eventCount).toBe(1);
    // the single effect: paid once
    expect(
      (await sql(`SELECT paid_minor::text p FROM invoicing.invoices WHERE id = $1`, [inv]))[0]!.p,
    ).toBe('7000');
    expect(
      (await asStaff('fin1', `/v1/admin/billing/payments/${crypto.randomUUID()}/events`))
        .statusCode,
    ).toBe(404);
    expect((await asStaff('fin1', '/v1/admin/billing/payments/not-a-uuid/events')).statusCode).toBe(
      404,
    );
    expect((await asStaff('sup', `/v1/admin/billing/payments/${p.id}/events`)).statusCode).toBe(
      403,
    );
    expect(
      Number(
        (
          await sql(
            `SELECT count(*)::int n FROM audit.audit_logs WHERE action = 'billing.admin_payment_events.read' AND resource_id = $1`,
            [p.id],
          )
        )[0]!.n,
      ),
    ).toBe(1);
  });

  it('lists refunds with their status; creating one is still POST only and the list is read-only', async () => {
    const { paymentId } = await pay();
    const made = await refund('fin1', { paymentId, amount: '1500', reason: 'goodwill' });
    expect(made.statusCode).toBe(201);
    const list = (await asStaff('fin1', `/v1/admin/billing/refunds?paymentId=${paymentId}`)).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: made.json().id,
      orgId: orgA,
      paymentId,
      amountMinor: '1500',
      currency: 'SAR',
      status: 'succeeded',
      reason: 'goodwill',
      failureCode: null,
      creditNoteId: null,
    });
    expect(
      (await asStaff('root', '/v1/admin/billing/refunds?status=pending'))
        .json()
        .items.every((x: Row) => x.status === 'pending'),
    ).toBe(true);
    for (const q of ['status=nope', 'paymentId=x', 'org=x'])
      expect((await asStaff('fin1', `/v1/admin/billing/refunds?${q}`)).statusCode, q).toBe(422);
    expect((await asStaff('sup', '/v1/admin/billing/refunds')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/billing/refunds' })).statusCode).toBe(
      401,
    );
    expect(
      Number(
        (
          await sql(
            `SELECT count(*)::int n FROM audit.audit_logs WHERE action = 'billing.admin_refunds.read'`,
          )
        )[0]!.n,
      ),
    ).toBeGreaterThan(0);
  });

  it('a customer cannot reach any of the admin reads', async () => {
    for (const url of [
      '/v1/admin/billing/payments',
      '/v1/admin/billing/refunds',
      '/v1/admin/billing/invoices',
    ]) {
      const r = await asUser('alice', 'GET', url);
      expect([401, 403], url).toContain(r.statusCode);
    }
  });
});
