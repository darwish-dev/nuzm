import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { LedgerPostingService, recipes } from '../billing';
import { CreditNoteService, InvoiceService } from '../invoicing';
import { PaymentMethodService, RefundService } from '../payments';
import { NotificationService } from '../notifications';
import { billingManagerIds } from '../../common/billing-managers';
import { toCsv, type Report } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const RETURN = 'http://127.0.0.1:3000/en/billing/payment-return';
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
let methodA = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const staff: Record<string, Record<string, string>> = {};
let seq = 0;

// UTC day, like the report service: the database session may run in another time zone, so the helpers below bound the day in UTC explicitly
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const count = async (q: string, p: unknown[] = []) => Number((await sql(q, p))[0]!.n);
const call = (who: string, method: 'GET' | 'POST', url: string, org: string, body?: object) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jars[who]!),
      'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
      'x-nuzm-org': org,
      'idempotency-key': `k-${Math.random()}`,
    },
    ...(body ? { payload: body } : {}),
  });
const report = async (who: string, qs: string): Promise<Row> => {
  const r = await app.inject({
    method: 'GET',
    url: `/v1/admin/billing/revenue-reports?${qs}`,
    headers: { cookie: cookieHeader(staff[who]!) },
  });
  expect(r.statusCode, `${qs} → ${r.body.slice(0, 200)}`).toBe(200);
  return r.json();
};
const mkInvoice = async (org: string, net: string, now = new Date()) => {
  const n = ++seq;
  return (
    await app.get(InvoiceService).issueSubscriptionCharge(
      org,
      {
        sourceKey: `rp-${n}`,
        currency: 'SAR',
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        lines: [
          {
            description: `Fee ${n}`,
            quantity: '1',
            unit: 'subscription_period',
            netMinor: net,
            meterId: null,
            sourceId: `rp-line-${n}`,
          },
        ],
      },
      null,
      now,
    )
  ).invoice;
};
const ledgerIn = (codes: string[], from = today, to = today) =>
  sql(
    `SELECT coalesce(sum(CASE WHEN p.direction = 'credit' THEN p.amount_minor ELSE -p.amount_minor END), 0)::text n FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id
          WHERE a.code = ANY($1) AND t.occurred_at >= ($2::date)::timestamp AT TIME ZONE 'UTC' AND t.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')`,
    [codes, from, to],
  ).then((r) => BigInt(r[0]!.n));
const REVENUE = ['4100', '4200', '4300', '4400'];
const ledger = (codeLike: string, from = today, to = today) =>
  sql(
    `SELECT coalesce(sum(CASE WHEN p.direction = 'credit' THEN p.amount_minor ELSE -p.amount_minor END), 0)::text n FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id
          WHERE a.code LIKE $1 AND t.occurred_at >= ($2::date)::timestamp AT TIME ZONE 'UTC' AND t.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')`,
    [codeLike, from, to],
  ).then((r) => BigInt(r[0]!.n));

let inv: Record<string, { id: string; totalMinor: string; taxMinor: string; number: string }> = {};

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol', 'dave']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  for (const [name, roles] of Object.entries({
    fin1: ['finance'],
    root: ['platform_admin'],
    comp: ['compliance_officer'],
    sup: ['support'],
  })) {
    const u = await h.platformUser(app, `staff-${name}`, roles);
    ids[name] = u.id;
    staff[name] = u.jar;
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
  orgA = await mk('alice', 'RP A');
  orgB = await mk('bob', 'RP B');
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'billing_admin'],
  ] as const)
    await sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgA, ids[u], role],
    );
  methodA = (
    await call('alice', 'POST', '/v1/billing/payment-methods', orgA, {
      provider: 'mock',
      setupToken: 'tok_mock_success_a1',
    })
  ).json().id;
});
afterAll(() => h.close());

describe('notifications', () => {
  it('an issued invoice notifies the billing managers (and only them)', async () => {
    const i = await mkInvoice(orgA, '10000', daysAgo(0));
    const rows = await sql(
      `SELECT user_id, body FROM platform.notifications WHERE org_id = $1 AND kind = 'billing.invoice_issued'`,
      [orgA],
    );
    expect(rows.map((r) => r.user_id).sort()).toEqual([ids.alice, ids.dave].sort()); // owner and billing admin, not the viewer
    expect(rows[0]!.body.params).toMatchObject({
      invoiceId: i.id,
      number: (await sql(`SELECT number_text n FROM invoicing.invoices WHERE id = $1`, [i.id]))[0]!
        .n,
      currency: 'SAR',
    });
    // an idempotent re-issue (same source key) does not notify again
    await app.get(InvoiceService).issueSubscriptionCharge(orgA, {
      sourceKey: 'rp-1',
      currency: 'SAR',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      lines: [
        {
          description: 'Fee 1',
          quantity: '1',
          unit: 'subscription_period',
          netMinor: '10000',
          meterId: null,
          sourceId: 'rp-line-1',
        },
      ],
    });
    expect(
      await count(
        `SELECT count(*)::int n FROM platform.notifications WHERE org_id = $1 AND kind = 'billing.invoice_issued'`,
        [orgA],
      ),
    ).toBe(2);
    await sql(`DELETE FROM platform.notifications WHERE kind = 'billing.invoice_issued'`);
    seq = 0;
    await sql(`UPDATE invoicing.invoices SET source_key = source_key || '-old'`).catch(
      () => undefined,
    ); // immutable: ignored, the sequence of keys continues below
    seq = 100;
  });

  it('a card that expires within 30 days (or already did) is announced once; healthy and removed cards are not', async () => {
    const psp = (await sql(`SELECT id FROM payments.psp_accounts LIMIT 1`))[0]!.id;
    const now = new Date();
    const add = (token: string, month: number, year: number, status = 'active') =>
      sql(
        `INSERT INTO payments.payment_methods (id, org_id, psp_account_id, token_ref, brand, last4, exp_month, exp_year, fingerprint, status, removed_at) VALUES (gen_random_uuid(), $1, $2, $3, 'visa', $4, $5, $6, $7, $8, ${status === 'removed' ? 'now()' : 'NULL'}) RETURNING id`,
        [
          orgA,
          psp,
          `pm_exp_${token}`,
          token.slice(-4).padStart(4, '0'),
          month,
          year,
          `fp_exp_${token}`,
          status,
        ],
      ).then((r) => r[0]!.id as string);
    const soon = await add('1111', now.getUTCMonth() + 1, now.getUTCFullYear());
    const gone = await add('2222', 1, now.getUTCFullYear() - 1);
    const fine = await add('3333', 12, now.getUTCFullYear() + 3);
    const removed = await add('4444', now.getUTCMonth() + 1, now.getUTCFullYear(), 'removed');
    const n = app.get(NotificationService);
    const notify = async (orgId: string, kind: string, params: Record<string, unknown>) => {
      for (const userId of await billingManagerIds(
        (app.get(PaymentMethodService) as any).db,
        orgId,
      ))
        await n.notify({ orgId, userId, kind, params });
    };
    const first = await app.get(PaymentMethodService).notifyExpiring(notify, now);
    expect(first).toBe(2);
    const rows = await sql(
      `SELECT body->'params' p, user_id FROM platform.notifications WHERE org_id = $1 AND kind = 'billing.card_expiring'`,
      [orgA],
    );
    expect(rows).toHaveLength(4); // two cards x two billing managers
    expect(new Set(rows.map((r) => r.p.methodId))).toEqual(new Set([soon, gone]));
    expect(rows.map((r) => r.p.last4).sort()).toEqual(['1111', '1111', '2222', '2222']);
    expect(rows.every((r) => Object.keys(r.p).sort().join() === 'last4,methodId,month,year')).toBe(
      true,
    ); // nothing but the card's last four digits and expiry
    expect(await app.get(PaymentMethodService).notifyExpiring(notify, now)).toBe(0); // once per method
    for (const id of [fine, removed])
      expect(
        (
          await sql(`SELECT expiry_notified_at FROM payments.payment_methods WHERE id = $1`, [id])
        )[0]!.expiry_notified_at,
      ).toBeNull();
    await expect(
      sql(`UPDATE payments.payment_methods SET exp_year = 2099 WHERE id = $1`, [soon]),
    ).rejects.toThrow(/immutable/); // the notice flag is the only new thing a method may change
  });
});

describe('the data every report is built from', () => {
  it('builds a ledger with aged invoices, a payment, a credit note, a refund, usage revenue, provider cost and wallet flows', async () => {
    // four invoices at different ages: due 14 days after issue
    const a100 = await mkInvoice(orgA, '20000', daysAgo(100)); // 86 days overdue -> 61-90
    const a60 = await mkInvoice(orgB, '10000', daysAgo(60)); // 46 -> 31-60
    const a20 = await mkInvoice(orgA, '30000', daysAgo(20)); // 6 -> 1-30
    const paid = await mkInvoice(orgA, '40000', daysAgo(0)); // current, then paid in full
    inv = Object.fromEntries(
      Object.entries({ a100, a60, a20, paid }).map(([k, v]) => [
        k,
        { id: v.id, totalMinor: v.totalMinor, taxMinor: v.taxMinor, number: v.number },
      ]),
    );
    const pay = await call('alice', 'POST', '/v1/billing/payments', orgA, {
      invoiceId: paid.id,
      paymentMethodId: methodA,
      returnUrl: RETURN,
    });
    expect(pay.json().status).toBe('succeeded');
    await app.get(CreditNoteService).issue(orgA, null, {
      invoiceId: a20.id,
      reasonCode: 'billing_error',
      reason: 'partial credit',
      sourceKey: 'rp-cn-1',
      lines: [
        {
          invoiceLineId: (
            await sql(`SELECT id FROM invoicing.invoice_lines WHERE invoice_id = $1`, [a20.id])
          )[0]!.id,
          netMinor: '5000',
        },
      ],
    });
    // a partial refund of the paid invoice (finance)
    const rf = await app
      .get(RefundService)
      .request(
        ids.fin1!,
        { paymentId: pay.json().id, amount: '1000', reason: 'goodwill' },
        'rp-refund-1',
      );
    expect(rf.refund.status).toBe('succeeded');
    // provider cost and a wallet life
    await app.get(LedgerPostingService).post(
      recipes.providerCostAccrual({
        providerAccountId: 'acct1',
        amountMinor: 3000,
        currency: 'SAR',
        costRecordId: 'rp-cost-1',
      }),
      'cost:acct1:rp-cost-1',
    );
    expect(
      (
        await call('alice', 'POST', '/v1/billing/wallet-topups', orgA, {
          amount: { amount: '5000', currency: 'SAR' },
          paymentMethodId: methodA,
          returnUrl: RETURN,
        })
      ).statusCode,
    ).toBe(201);
    await app.get(LedgerPostingService).post(
      recipes.creditGrant({
        orgId: orgA,
        amountMinor: 3000,
        currency: 'SAR',
        reason: 'promo',
        grantId: 'rp-grant-1',
      }),
      'grant:rp-grant-1',
    );
    await app.get(LedgerPostingService).post(
      recipes.walletConsume({
        orgId: orgA,
        netMinor: 1000,
        currency: 'SAR',
        meterId: 'ai.credits_consumed',
        sourceEventId: 'rp-consume-1',
      }),
      'consume:rp-1',
    );
    // subscriptions (for MRR) and dunning cases (for the funnel), written directly
    const plan = (
      await sql(
        `SELECT v.id FROM billing.plans p JOIN billing.plan_versions v ON v.plan_id = p.id WHERE p.key = 'starter' AND v.status = 'published' LIMIT 1`,
      )
    )[0]!.id;
    const items = (key: string, price: string) =>
      JSON.stringify([
        {
          kind: 'plan_fee',
          planKey: key,
          meterId: `plan.${key}_months`,
          unitPriceMinor: price,
          rounding: 'half_up',
          priceBookVersionId: 'x',
        },
      ]);
    const sub = (org: string, status: string, key: string, price: string, qty: number) =>
      sql(
        `INSERT INTO billing.subscriptions (id, org_id, plan_version_id, currency, status, items, quantity, payment_method_id, anchor_day, period_start, period_end, cancelled_at) VALUES (gen_random_uuid(), $1, $2, 'SAR', $3, $4, $5, gen_random_uuid(), 1, '2026-11-01', '2026-12-01', ${status === 'cancelled' ? 'now()' : 'NULL'}) RETURNING id`,
        [org, plan, status, items(key, price), qty],
      ).then((r) => r[0]!.id as string);
    await sub(orgA, 'active', 'starter', '3000', 2); // 6000
    await sub(orgB, 'past_due', 'pro', '5000', 1); // 5000
    const c1 = await sub(orgA, 'cancelled', 'old', '1000', 1);
    const c2 = await sub(orgA, 'cancelled', 'old', '1000', 1);
    const c3 = await sub(orgA, 'cancelled', 'old', '1000', 1);
    const kase = (subId: string, stage: string, closed: string | null) =>
      sql(
        `INSERT INTO billing.dunning_cases (id, org_id, subscription_id, invoice_id, stage, policy_version, opened_at, stage_changed_at, closed_at, closed_reason) VALUES (gen_random_uuid(), $1, $2, $3, $4, 1, now(), now(), ${closed ? 'now()' : 'NULL'}, $5)`,
        [orgA, subId, a100.id, stage, closed],
      );
    await kase(c1, 'reminder_2', null);
    await kase(c2, 'restricted', null);
    await kase(c3, 'reminder_1', 'paid');
  });
});

describe('reports tie to the ledger', () => {
  it('revenue: the report total equals an independent sum of the ledger revenue accounts', async () => {
    const r = await report('fin1', `report=revenue&from=${today}&to=${today}`);
    const expected = await ledgerIn(REVENUE);
    expect(BigInt(r.totals.revenueMinor)).toBe(expected);
    expect(r.totals.revenueMinor).toBe(r.totals.ledgerRevenueMinor);
    expect(r.rows.reduce((s: bigint, x: Row) => s + BigInt(x.revenueMinor), 0n)).toBe(expected);
    // subscription revenue = every invoice net less the credit note (the 4900 discount of the credit grant is NOT revenue)
    const sub = r.rows.find((x: Row) => x.product === 'subscription');
    expect(sub).toMatchObject({ account: '4200', currency: 'SAR' });
    expect(BigInt(sub.revenueMinor)).toBe(
      BigInt(
        (await sql(`SELECT (sum(subtotal_minor) - 5000)::text n FROM invoicing.invoices`))[0]!.n,
      ),
    );
    const usage = (rows: Row[]) =>
      rows
        .filter((x: Row) => x.product === 'usage')
        .reduce((n: bigint, x: Row) => n + BigInt(x.revenueMinor), 0n);
    expect(usage(r.rows)).toBe(1000n); // the wallet consumption
    expect(r.columns.map((c: Row) => c.key)).toEqual([
      'period',
      'product',
      'account',
      'entityId',
      'currency',
      'revenueMinor',
    ]);
    // usage revenue (4100) from an invoice posting is added to the same product
    await app.get(LedgerPostingService).post(
      recipes.invoiceIssued({
        orgId: orgB,
        documentId: crypto.randomUUID(),
        invoiceId: crypto.randomUUID(),
        entityId: crypto.randomUUID(),
        currency: 'SAR',
        number: 'U1',
        lines: [{ revenueAccount: '4100', netMinor: 7000, taxMinor: 1050 }],
      }),
      'rp-usage-revenue',
    );
    const r2 = await report('root', `report=revenue&from=${today}&to=${today}`);
    expect(usage(r2.rows)).toBe(8000n);
    expect(BigInt(r2.totals.revenueMinor)).toBe(await ledgerIn(REVENUE));
    expect(BigInt(r2.totals.revenueMinor)).toBe(expected + 7000n);
  });

  it('ar_aging: every invoice bucketed from the ledger balance as of the date, summing to the ledger receivable', async () => {
    const r = await report('fin1', `report=ar_aging&to=${today}`);
    const byNum = (n: string) => r.rows.find((x: Row) => x.invoiceNumber === n);
    expect(byNum(inv.a100!.number)).toMatchObject({
      bucket: '61-90',
      outstandingMinor: inv.a100!.totalMinor,
    });
    expect(byNum(inv.a60!.number)).toMatchObject({
      bucket: '31-60',
      outstandingMinor: inv.a60!.totalMinor,
    });
    expect(byNum(inv.a20!.number)).toMatchObject({
      bucket: '1-30',
      outstandingMinor: String(BigInt(inv.a20!.totalMinor) - 5750n),
    }); // less the credit note (5000 + 15% VAT)
    expect(byNum(inv.paid!.number)).toBeUndefined(); // paid: no balance (the partial refund is unattributed)
    expect(r.totals.over90Minor).toBe('0');
    // the refund (1000) and the usage posting of the revenue test (7000 + 1050 VAT, an entry for an invoice that does not exist) moved money on
    // receivables without an invoice: shown, never hidden
    expect(r.totals.unattributedMinor).toBe('9050');
    expect(r.totals).toMatchObject({ matchesLedger: true, asOf: today });
    expect(BigInt(r.totals.totalMinor)).toBe(BigInt(r.totals.ledgerReceivableMinor));
    // as of a date before the invoices existed: nothing outstanding
    const early = await report('fin1', `report=ar_aging&from=2025-01-01&to=2025-01-31`);
    expect(early.rows).toEqual([]);
    expect(early.totals.totalMinor).toBe('0');
  });

  it('vat: output tax from invoices less credit notes, by month and rate, equal to the ledger VAT account', async () => {
    const from = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
    // before the orphan usage posting is considered: use a window that ends before it? the ledger posting was made today, so judge the documents-only parts first
    const r = await report('fin1', `report=vat&from=${from}&to=${today}`);
    const taxInvoices = BigInt(
      (await sql(`SELECT sum(tax_minor)::text n FROM invoicing.invoices`))[0]!.n,
    ); // every invoice, including the one of the notification test
    expect(BigInt(r.totals.taxMinor)).toBe(taxInvoices - 750n); // the credit note's VAT (15% of 5000)
    expect(r.rows.every((x: Row) => x.rate === '15.00')).toBe(true);
    expect(r.rows.map((x: Row) => x.period).length).toBeGreaterThanOrEqual(3); // spread over several months
    expect(r.totals.ledgerVatMinor).toBe((await ledger('2300', from, today)).toString());
    // the orphan 4100 posting carried VAT of 1050 that no document explains: the report says it does NOT match
    expect(r.totals).toMatchObject({ matchesLedger: false, differenceMinor: '-1050' });
  });

  it('margin: revenue less provider cost, both from the ledger', async () => {
    const r = await report('fin1', `report=margin&from=${today}&to=${today}`);
    const rev = await ledgerIn(REVENUE);
    expect(r.totals).toMatchObject({
      revenueMinor: rev.toString(),
      costMinor: '3000',
      marginMinor: (rev - 3000n).toString(),
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].marginBps).toBe(Number(((rev - 3000n) * 10_000n + rev / 2n) / rev));
    // the revenue report and the margin report cannot disagree
    expect(r.totals.revenueMinor).toBe(
      (await report('fin1', `report=revenue&from=${today}&to=${today}`)).totals.revenueMinor,
    );
  });

  it('refunds: refunds and credit notes, each tied to its ledger entries', async () => {
    const r = await report('fin1', `report=refunds&from=${today}&to=${today}`);
    expect(r.totals).toMatchObject({
      refundsMinor: '1000',
      creditNotesMinor: '5750',
      ledgerRefundsMinor: '1000',
      ledgerCreditNotesMinor: '5750',
      matchesLedger: true,
    });
    expect(r.rows[0]).toMatchObject({
      refunds: 1,
      refundsMinor: '1000',
      creditNotes: 1,
      creditNotesMinor: '5750',
    });
  });

  it('wallet: opening + flows = closing (the ledger liability), by entry kind', async () => {
    const r = await report('fin1', `report=wallet&from=${today}&to=${today}`);
    expect(r.totals).toMatchObject({
      openingMinor: '0',
      closingMinor: '7000',
      flowsMinor: '7000',
      reconciles: true,
    });
    expect(Object.fromEntries(r.rows.map((x: Row) => [x.flow, x.netMinor]))).toEqual({
      credit_grant: '3000',
      wallet_consume: '-1000',
      wallet_topup: '5000',
    });
    expect(BigInt(r.totals.closingMinor)).toBe(await ledger('2100', '0001-01-01', today));
    // tomorrow's window sees today's liability as its opening balance
    const next = await report(
      'fin1',
      `report=wallet&from=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}`,
    );
    expect(next.totals).toMatchObject({
      openingMinor: '7000',
      closingMinor: '7000',
      flowsMinor: '0',
      reconciles: true,
    });
  });

  it('mrr: active and past-due subscriptions at their frozen prices; ARR is 12 x MRR; cancelled ones are not counted', async () => {
    const r = await report('fin1', `report=mrr`);
    expect(r.rows).toEqual([
      { planKey: 'pro', currency: 'SAR', subscriptions: 1, mrrMinor: '5000', arrMinor: '60000' },
      {
        planKey: 'starter',
        currency: 'SAR',
        subscriptions: 1,
        mrrMinor: '6000',
        arrMinor: '72000',
      },
    ]);
    expect(r.totals).toMatchObject({ mrrMinor: '11000', arrMinor: '132000', subscriptions: 2 });
  });

  it('dunning: the funnel of cases opened in the period and the amount still at risk', async () => {
    const r = await report('fin1', `report=dunning&from=${today}&to=${today}`);
    expect(Object.fromEntries(r.rows.map((x: Row) => [x.stage, x.cases]))).toEqual({
      opened: 3,
      reached_reminder_1: 3,
      reached_reminder_2: 2,
      reached_restricted: 1,
      reached_suspended: 0,
      reached_owner_review: 0,
      recovered_by_payment: 1,
      closed_cancelled: 0,
      still_open: 2,
    });
    expect(r.totals).toMatchObject({ opened: 3, recovered: 1, recoveryRateBps: 3333 });
    expect(r.totals.openAtRiskMinor).toBe((BigInt(inv.a100!.totalMinor) * 2n).toString()); // two open cases on the 86-days-overdue invoice
  });
});

describe('access, validation, CSV and audit', () => {
  it('finance and platform admins read; compliance officers and support do not; every read is audited', async () => {
    const before = await count(
      `SELECT count(*)::int n FROM audit.audit_logs WHERE action = 'finrec.report.read'`,
    );
    for (const who of ['fin1', 'root'])
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/admin/billing/revenue-reports?report=wallet`,
            headers: { cookie: cookieHeader(staff[who]!) },
          })
        ).statusCode,
      ).toBe(200);
    for (const who of ['comp', 'sup'])
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/admin/billing/revenue-reports?report=wallet`,
            headers: { cookie: cookieHeader(staff[who]!) },
          })
        ).statusCode,
        who,
      ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/admin/billing/revenue-reports?report=wallet`,
          headers: { cookie: cookieHeader(jars.alice!), 'x-nuzm-org': orgA },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(401);
    expect(
      await count(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE action = 'finrec.report.read'`,
      ),
    ).toBe(before + 2);
    const a = (
      await sql(
        `SELECT detail FROM audit.audit_logs WHERE action = 'finrec.report.read' ORDER BY id DESC LIMIT 1`,
      )
    )[0]!.detail;
    expect(a).toMatchObject({ report: 'wallet', format: 'json' });
  });

  it('validates the report, the format and the range', async () => {
    const bad = [
      '',
      'report=nope',
      'report=revenue&format=xml',
      'report=revenue&from=x',
      'report=revenue&from=2026-02-30',
      'report=revenue&from=2026-05-02&to=2026-05-01',
      'report=revenue&from=2024-01-01&to=2026-01-01',
      `report=revenue&to=${new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)}`,
    ];
    for (const qs of bad)
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/admin/billing/revenue-reports?${qs}`,
            headers: { cookie: cookieHeader(staff.fin1!) },
          })
        ).statusCode,
        qs,
      ).toBe(422);
  });

  it('format=csv downloads a CSV whose rows are the JSON rows', async () => {
    const json = await report('fin1', `report=revenue&from=${today}&to=${today}`);
    const r = await app.inject({
      method: 'GET',
      url: `/v1/admin/billing/revenue-reports?report=revenue&from=${today}&to=${today}&format=csv`,
      headers: { cookie: cookieHeader(staff.fin1!) },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toBe(
      `attachment; filename="revenue-${today}-${today}.csv"`,
    );
    const lines = r.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Period,Product,Account,Billing entity,Currency,Revenue (minor units)');
    expect(lines).toHaveLength(json.rows.length + 1);
    expect(lines.slice(1).reduce((s, l) => s + BigInt(l.split(',').at(-1)!), 0n)).toBe(
      BigInt(json.totals.revenueMinor),
    );
  });

  it('CSV quoting and formula-injection protection: text cells that look like formulas are neutralised, negative amounts are not', () => {
    const r: Report = {
      report: 'ar_aging',
      from: '2026-01-01',
      to: '2026-01-31',
      generatedAt: '',
      notes: [],
      totals: {},
      columns: [
        { key: 'name', label: 'Name, with comma', kind: 'text' },
        { key: 'amt', label: 'Amount', kind: 'money' },
        { key: 'n', label: 'N', kind: 'int' },
      ],
      rows: [
        { name: '=HYPERLINK("http://evil")', amt: '-500', n: -1 },
        { name: '+1', amt: '10', n: 2 },
        { name: '@SUM(A1)', amt: '0', n: 0 },
        { name: 'a "quoted", cell\nwith a line break', amt: '1', n: 1 },
        { name: '-cmd', amt: '2', n: 1 },
        { name: null as never, amt: '3', n: 3 },
        { name: 'نظم', amt: '4', n: 4 },
      ],
    };
    const lines = toCsv(r).split('\r\n');
    expect(lines[0]).toBe('"Name, with comma",Amount,N');
    expect(lines[1]).toBe(`'=HYPERLINK(""http://evil"")`.replace(/^/, '"') + '",-500,-1');
    expect(lines[2]).toBe("'+1,10,2");
    expect(lines[3]).toBe("'@SUM(A1),0,0");
    expect(toCsv(r)).toContain('"a ""quoted"", cell\nwith a line break",1,1');
    expect(toCsv(r)).toContain("'-cmd,2,1");
    expect(toCsv(r)).toContain(',3,3');
    expect(toCsv(r)).toContain('نظم,4,4');
  });
});
