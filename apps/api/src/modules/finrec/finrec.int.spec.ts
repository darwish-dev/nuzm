import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { LedgerPostingService, recipes } from '../billing';
import { CreditNoteService, InvoiceService } from '../invoicing';
import { MockPsp } from '../payments';
import { DB } from '../../common/tokens';
import { FinrecService, type FinrecOptions, type Sources } from './index';

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

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const FROM = day(-1);
const TO = day(1);
const sql = (q: string, p: unknown[] = []) => h.env.sql(q, p) as Promise<Row[]>;
const count = async (q: string, p: unknown[] = []) => Number((await sql(q, p))[0]!.n);
const fin = () => app.get(FinrecService);
const mock = () => app.get(MockPsp);
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
const admin = (who: string, method: 'GET' | 'POST', url: string, body?: object, key?: string) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(staff[who]!),
      'x-csrf-token': staff[who]!.nuzm_admin_csrf!,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body ? { payload: body } : {}),
  });

const mkInvoice = async (org: string, net = '10000') => {
  const n = ++seq;
  return (
    await app.get(InvoiceService).issueSubscriptionCharge(org, {
      sourceKey: `fr-${n}`,
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
          sourceId: `fr-line-${n}`,
        },
      ],
    })
  ).invoice;
};
const payInvoice = async (invoiceId: string) => {
  const r = await call('alice', 'POST', '/v1/billing/payments', orgA, {
    invoiceId,
    paymentMethodId: methodA,
    returnUrl: RETURN,
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};
/** Run one type over the test period synchronously and return its run and breaks. */
const reconcile = async (type: string, svc: FinrecService = fin(), from = FROM, to = TO) => {
  const [run] = await svc.request(ids.fin1!, { types: [type], periodFrom: from, periodTo: to });
  await svc.process(run!.id);
  return svc.get(run!.id);
};
const withKey = (d: { items: Row[] }, needle: string) =>
  d.items.filter((i) => String(i.matchKey).includes(needle));

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  for (const [name, roles] of Object.entries({
    fin1: ['finance'],
    fin2: ['finance'],
    root: ['platform_admin'],
    sup: ['support'],
    comp: ['compliance_officer'],
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
  orgA = await mk('alice', 'FR A');
  orgB = await mk('bob', 'FR B');
  methodA = (
    await call('alice', 'POST', '/v1/billing/payment-methods', orgA, {
      provider: 'mock',
      setupToken: 'tok_mock_success_a1',
    })
  ).json().id;
});
afterAll(() => h.close());

describe('a consistent platform reconciles clean (all six types)', () => {
  it('payments, invoices, credit notes and a wallet top-up produce no breaks', async () => {
    const inv = await mkInvoice(orgA, '25000');
    await payInvoice(inv.id);
    await app.get(CreditNoteService).issue(orgA, null, {
      invoiceId: inv.id,
      reasonCode: 'billing_error',
      reason: 'goodwill',
      sourceKey: 'fr-cn-1',
      lines: [
        {
          invoiceLineId: (
            await sql(`SELECT id FROM invoicing.invoice_lines WHERE invoice_id = $1`, [inv.id])
          )[0]!.id,
          netMinor: '1000',
        },
      ],
    });
    const top = await call('alice', 'POST', '/v1/billing/wallet-topups', orgA, {
      amount: { amount: '5000', currency: 'SAR' },
      paymentMethodId: methodA,
      returnUrl: RETURN,
    });
    expect(top.statusCode).toBe(201);
    await app
      .get(DB)
      .withPlatformScope((c: any) => c.query('SELECT billing.refresh_wallet($1)', [orgA])); // the worker's projector (not running in this test)
    for (const type of ['RC-01', 'RC-02', 'RC-03', 'RC-04', 'RC-05', 'RC-06']) {
      const d = await reconcile(type);
      expect(d.run, type).toMatchObject({
        status: 'completed',
        trigger: 'manual',
        breaksCount: 0,
        openBreaks: 0,
      });
      expect(d.items, type).toEqual([]);
    }
    const rc01 = (await reconcile('RC-01')).run;
    expect(rc01.itemsChecked).toBeGreaterThanOrEqual(2); // the invoice payment and the top-up
    expect((await reconcile('RC-05')).run.summary).toMatchObject({ skipped: true });
    expect((await reconcile('RC-04')).run.summary).toMatchObject({ bills: { skipped: true } });
  });
});

describe('RC-01 payments vs PSP settlements', () => {
  it('finds a missing settlement, an amount mismatch, a refund the PSP never settled and a line nobody knows', async () => {
    const i1 = await mkInvoice(orgA, '11100');
    const i2 = await mkInvoice(orgA, '22200');
    const i3 = await mkInvoice(orgA, '33300');
    const [p1, p2, p3] = [
      await payInvoice(i1.id),
      await payInvoice(i2.id),
      await payInvoice(i3.id),
    ];
    const ref = async (p: string) =>
      (await sql(`SELECT psp_payment_ref r FROM payments.payment_intents WHERE id = $1`, [p]))[0]!
        .r as string;
    mock().dropSettlement(await ref(p1));
    mock().alterSettlement(await ref(p2), '22201');
    mock().addSettlement({
      ref: 'pay_mock_phantom1',
      kind: 'charge',
      amountMinor: '999',
      currency: 'SAR',
      settledAt: new Date(),
    });
    const d = await reconcile('RC-01');
    expect(withKey(d, await ref(p1)).map((i) => i.kind)).toEqual(['missing_settlement']);
    const mm = withKey(d, await ref(p2))[0]!;
    expect(mm).toMatchObject({ kind: 'amount_mismatch', relatedOrg: orgA });
    expect(mm.details).toMatchObject({
      expectedMinor: '25530', // 222.00 + 15% VAT
      settledMinor: '22201',
    });
    expect(withKey(d, await ref(p3))).toEqual([]);
    expect(withKey(d, 'phantom1').map((i) => i.kind)).toEqual(['unknown_psp_line']);
    expect(d.run.breaksCount).toBe(d.items.length);
    expect(d.run.openBreaks).toBe(d.items.length);
  });
});

describe('RC-02 ledger vs invoices and credit notes', () => {
  it('finds an invoice without a ledger entry, wrong VAT and receivable, and a ledger entry without a document', async () => {
    const entity = (await sql(`SELECT id FROM invoicing.billing_entities LIMIT 1`))[0]!.id;
    const fixture = async (net: number, tax: number) => {
      const id = crypto.randomUUID();
      const n = ++seq;
      await sql(
        `INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, buyer, seller)
         VALUES ($1,$2,$3,'RC',$4,$5,'open','sandbox','SAR','2026-11-01','2026-11-30',now(),now(),$6,$7,$8,$9,'{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"buyerType":"b2c"}','{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"placeholder":true}')`,
        [id, orgA, entity, n, `RC-${n}`, `rc-fixture-${n}`, net, tax, net + tax],
      );
      return { id, entity };
    };
    const post = (invoiceId: string, entityId: string, net: number, tax: number) =>
      app.get(LedgerPostingService).post(
        recipes.invoiceIssued({
          orgId: orgA,
          documentId: invoiceId,
          invoiceId,
          entityId,
          currency: 'SAR',
          number: 'X',
          lines: [{ revenueAccount: '4200', netMinor: net, taxMinor: tax }],
        }),
        `invoice:${invoiceId}`,
      );
    const none = await fixture(1000, 150); // never posted
    const badVat = await fixture(2000, 300);
    await post(badVat.id, badVat.entity, 2000, 299); // ledger VAT differs
    const badAr = await fixture(3000, 450);
    await post(badAr.id, badAr.entity, 3100, 465); // ledger revenue and receivable differ
    const orphanId = crypto.randomUUID();
    await post(orphanId, entity, 500, 75); // a ledger entry for an invoice that does not exist
    const d = await reconcile('RC-02');
    expect(withKey(d, none.id).map((i) => i.kind)).toEqual(['invoice_without_posting']);
    expect(
      withKey(d, badVat.id)
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['receivable_mismatch', 'vat_mismatch'].sort());
    expect(withKey(d, badVat.id).find((i) => i.kind === 'vat_mismatch')!.details).toMatchObject({
      documentMinor: '300',
      ledgerMinor: '299',
    });
    expect(
      withKey(d, badAr.id)
        .map((i) => i.kind)
        .sort(),
    ).toEqual(['receivable_mismatch', 'revenue_mismatch', 'vat_mismatch']);
    expect(
      d.items.filter(
        (i) => i.kind === 'posting_without_document' && i.details.sourceEventId === orphanId,
      ),
    ).toHaveLength(1);
    // the clean invoices of the baseline are not in it
    expect(d.items.every((i) => !String(i.matchKey).includes('fr-'))).toBe(true);
  });
});

describe('RC-03 rated usage vs invoice lines', () => {
  const entity = async () =>
    (await sql(`SELECT id FROM invoicing.billing_entities LIMIT 1`))[0]!.id;
  const rated = (
    org: string,
    period: string,
    meter: string,
    amount: number,
    run = crypto.randomUUID(),
  ) =>
    sql(
      `INSERT INTO metering.rated_usage (id, org_id, rating_run_id, meter_id, resource_key, period_start, segment_start, price_book_version_id, price_item_id, tier_model, quantity, billable_quantity, amount_minor, currency)
         VALUES (gen_random_uuid(), $1, $2, $3, 'r', $4::date, $4::date::timestamptz, gen_random_uuid(), gen_random_uuid(), 'flat', 1, 1, $5, 'SAR')`,
      [org, run, meter, period, amount],
    );
  /** One statement = one transaction: the invoice and its lines are created together (the lines trigger requires it). */
  const usageInvoice = async (org: string, period: string, lines: [string, number][]) => {
    const id = crypto.randomUUID();
    const n = ++seq;
    const net = lines.reduce((s, [, a]) => s + a, 0);
    const values = lines
      .map(
        ([meter, amount], i) =>
          `(gen_random_uuid(), (SELECT id FROM inv), $2::uuid, ${i + 1}, 'usage', 'u', '${meter}', 1, 'unit', ${amount}, 0, 'VAT', 0, '4100', 'usage:${period}:${meter}')`,
      )
      .join(',');
    await sql(
      `WITH inv AS (
         INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, buyer, seller)
         VALUES ($1,$2,$3,'RU',$4,$5,'open','sandbox','SAR',$6::date,$6::date,now(),now(),$7,$8,0,$8,'{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"buyerType":"b2c"}','{"legalName":{"ar":"x","en":"x"},"vatNumber":null,"placeholder":true}') RETURNING id)
       INSERT INTO invoicing.invoice_lines (id, invoice_id, org_id, position, kind, description, meter_id, quantity, unit, net_minor, tax_minor, rate_code, rate_bps, revenue_account, source_id) VALUES ${values}`,
      [id, org, await entity(), n, `RU-${n}`, period, `period:${period.slice(0, 7)}:SAR`, net],
    );
    return id;
  };
  it('finds unbilled usage, a missing line, over and under billing and a line without usage', async () => {
    const P1 = '2026-09-01';
    const P2 = '2026-08-01';
    const run1 = crypto.randomUUID(); // one rating run rates every meter of a period
    await rated(orgB, P1, 'compute.vcpu_hours', 5000, run1); // billed correctly
    await rated(orgB, P1, 'network.egress_gb', 700, run1); // an invoice exists but has no line for it
    await rated(orgB, P1, 'storage.object_gb_months', 1000, run1); // over billed
    await rated(orgB, P1, 'ai.credits_consumed', 1000, run1); // under billed
    await rated(orgB, P1, 'hosting.site_months', 0, run1); // zero priced: never expected on an invoice
    await usageInvoice(orgB, P1, [
      ['compute.vcpu_hours', 5000],
      ['storage.object_gb_months', 1010],
      ['ai.credits_consumed', 990],
      ['email.transactional_messages', 40],
    ]);
    await rated(orgA, P2, 'compute.vcpu_hours', 800); // no invoice for the period at all
    const d = await reconcile('RC-03', fin(), '2026-08-01', '2026-09-30');
    const k = (needle: string) => withKey(d, needle).map((i) => i.kind);
    expect(k(`${orgB}:${P1}:compute.vcpu_hours`)).toEqual([]);
    expect(k('network.egress_gb')).toEqual(['missing_invoice_line']);
    expect(k('storage.object_gb_months')).toEqual(['over_billed']);
    expect(withKey(d, 'storage.object_gb_months')[0]!.details).toMatchObject({
      ratedMinor: '1000',
      billedMinor: '1010',
      differenceMinor: '10',
    });
    expect(k('ai.credits_consumed')).toEqual(['under_billed']);
    expect(k('email.transactional_messages')).toEqual(['line_without_usage']);
    expect(k(`${orgA}:${P2}`)).toEqual(['unbilled_usage']);
    expect(k('hosting.site_months')).toEqual([]);
  });
  it('honours the finance-set tolerance in basis points', async () => {
    const real: any = fin();
    const lax = new FinrecService(real.db, real.audit, real.sources, real.zatca, {
      ...real.opts,
      rc03Bps: 150,
    } as FinrecOptions); // 1.5%
    const d = await reconcile('RC-03', lax, '2026-08-01', '2026-09-30');
    expect(withKey(d, 'storage.object_gb_months')).toEqual([]); // 1% over: within tolerance
    expect(withKey(d, 'ai.credits_consumed')).toEqual([]); // 1% under
    expect(withKey(d, 'network.egress_gb').map((i) => i.kind)).toEqual(['missing_invoice_line']); // never within tolerance
    expect(d.run.summary).toMatchObject({ toleranceBps: 150 });
  });
});

describe('RC-04 provider cost', () => {
  const cost = (
    acct: string,
    ref: string,
    org: string | null,
    amount: number,
    period = '2026-07-01',
  ) =>
    sql(
      `INSERT INTO metering.provider_cost_records (id, provider_account_id, org_id, period_start, period_end, meter_or_sku, quantity, cost_minor, currency, source, provider_line_ref) VALUES (gen_random_uuid(), $1, $2, $3, $3, 'sku', 1, $4, 'SAR', 'api', $5)`,
      [acct, org, period, amount, ref],
    );
  const accrue = (acct: string, ref: string, amount: number) =>
    app.get(LedgerPostingService).post(
      recipes.providerCostAccrual({
        providerAccountId: acct,
        amountMinor: amount,
        currency: 'SAR',
        costRecordId: ref,
      }),
      `cost:${acct}:${ref}`,
    );
  it('finds cost without an accrual, a wrong accrual, unattributed cost and a negative margin', async () => {
    await cost('acct1', 'ok-1', orgA, 500);
    await accrue('acct1', 'ok-1', 500);
    await cost('acct1', 'no-accrual', orgA, 700);
    await cost('acct1', 'wrong-accrual', orgA, 900);
    await accrue('acct1', 'wrong-accrual', 899);
    await cost('acct1', 'orphan', null, 300);
    await accrue('acct1', 'orphan', 300);
    await sql(
      `INSERT INTO metering.rated_usage (id, org_id, rating_run_id, meter_id, resource_key, period_start, segment_start, price_book_version_id, price_item_id, tier_model, quantity, billable_quantity, amount_minor, currency)
               VALUES (gen_random_uuid(), $1, gen_random_uuid(), 'compute.vcpu_hours', 'r', '2026-07-01', '2026-07-01', gen_random_uuid(), gen_random_uuid(), 'flat', 1, 1, 100, 'SAR')`,
      [orgA],
    );
    const d = await reconcile('RC-04', fin(), '2026-07-01', '2026-07-31');
    expect(withKey(d, 'ok-1')).toEqual([]);
    expect(withKey(d, 'no-accrual').map((i) => i.kind)).toEqual(['cost_without_accrual']);
    expect(withKey(d, 'wrong-accrual').map((i) => i.kind)).toEqual(['accrual_mismatch']);
    expect(withKey(d, 'wrong-accrual')[0]!.details).toMatchObject({
      costMinor: '900',
      ledgerMinor: '899',
    });
    expect(withKey(d, 'orphan').map((i) => i.kind)).toEqual(['unattributed_cost']);
    expect(d.items.some((i) => i.kind === 'negative_margin' && i.relatedOrg === orgA)).toBe(true);
  });
  it('compares provider bills when a bill source exists (a fixture here; the real adapters arrive in M05)', async () => {
    const real: any = fin();
    const sources: Sources = {
      ...real.sources,
      bills: async () => [
        {
          providerAccountId: 'acct1',
          lineRef: 'ok-1',
          periodStart: '2026-07-01',
          amountMinor: '500',
          currency: 'SAR',
        },
        {
          providerAccountId: 'acct1',
          lineRef: 'wrong-accrual',
          periodStart: '2026-07-01',
          amountMinor: '950',
          currency: 'SAR',
        },
        {
          providerAccountId: 'acct1',
          lineRef: 'only-on-bill',
          periodStart: '2026-07-01',
          amountMinor: '100',
          currency: 'SAR',
        },
      ],
    };
    const d = await reconcile(
      'RC-04',
      new FinrecService(real.db, real.audit, sources, real.zatca, real.opts),
      '2026-07-01',
      '2026-07-31',
    );
    expect(withKey(d, 'bill:acct1:only-on-bill').map((i) => i.kind)).toEqual([
      'bill_line_without_cost',
    ]);
    expect(withKey(d, 'bill:acct1:wrong-accrual').map((i) => i.kind)).toEqual([
      'bill_amount_mismatch',
    ]);
    expect(withKey(d, 'bill:acct1:ok-1')).toEqual([]);
    expect(
      d.items.some(
        (i) => i.kind === 'cost_without_bill_line' && String(i.matchKey).includes('no-accrual'),
      ),
    ).toBe(true);
    expect(d.run.summary).toMatchObject({ bills: { lines: 3 } });
  });
});

describe('RC-06 wallet', () => {
  it('finds a projection that drifted, is missing, or has no ledger behind it, and a credited top-up without its ledger entry', async () => {
    const wb = (org: string) =>
      `UPDATE billing.wallet_balances SET balance_minor = balance_minor + 5 WHERE org_id = '${org}'`;
    await sql(wb(orgA));
    let d = await reconcile('RC-06');
    expect(withKey(d, `wallet:${orgA}:SAR`)[0]).toMatchObject({
      kind: 'projection_drift',
      details: { differenceMinor: '5' },
    });
    await sql(`DELETE FROM billing.wallet_balances WHERE org_id = $1`, [orgA]);
    d = await reconcile('RC-06');
    expect(withKey(d, `wallet:${orgA}:SAR`)[0]!.kind).toBe('projection_missing');
    await app
      .get(DB)
      .withPlatformScope((c: any) => c.query('SELECT billing.refresh_wallet($1)', [orgA])); // repaired: back to clean
    expect(withKey(await reconcile('RC-06'), `wallet:${orgA}`)).toEqual([]);
    await sql(
      `INSERT INTO billing.wallet_balances (org_id, currency, balance_minor) VALUES ($1, 'SAR', 777)`,
      [orgB],
    );
    expect(withKey(await reconcile('RC-06'), `wallet:${orgB}:SAR`)[0]!.kind).toBe(
      'projection_orphan',
    );
    await sql(
      `INSERT INTO billing.wallet_topups (id, org_id, amount_minor, currency, status, ledger_transaction_id, credited_at) VALUES (gen_random_uuid(), $1, 1234, 'SAR', 'credited', gen_random_uuid(), now())`,
      [orgB],
    );
    expect(withKey(await reconcile('RC-06'), `topups:${orgB}`)[0]).toMatchObject({
      kind: 'topup_mismatch',
      details: { creditedMinor: '1234', ledgerMinor: '0' },
    });
  });
});

describe('runs, workflow and scheduling', () => {
  it('validates requests, answers 202 over HTTP, refuses a duplicate in-progress run, and enforces the roles', async () => {
    const body = { types: ['RC-02'], periodFrom: FROM, periodTo: TO };
    for (const bad of [
      {},
      { ...body, types: [] },
      { ...body, types: ['RC-02', 'RC-02'] },
      { ...body, types: ['RC-09'] },
      { ...body, periodFrom: 'x' },
      { ...body, periodFrom: TO, periodTo: FROM },
      { ...body, periodFrom: '2024-01-01' },
      { ...body, periodTo: day(10) },
      { ...body, extra: 1 },
    ])
      expect(
        (await admin('fin1', 'POST', '/v1/admin/billing/reconciliations', bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(422);
    expect(
      (await admin('comp', 'POST', '/v1/admin/billing/reconciliations', body)).statusCode,
    ).toBe(403); // compliance officers read only
    expect((await admin('sup', 'GET', '/v1/admin/billing/reconciliations')).statusCode).toBe(403);
    const r = await admin('fin1', 'POST', '/v1/admin/billing/reconciliations', {
      types: ['RC-06', 'RC-03'],
      periodFrom: day(-3),
      periodTo: day(-2),
    });
    expect(r.statusCode).toBe(202);
    expect(r.headers.location).toMatch(/\/v1\/admin\/billing\/reconciliations\//);
    expect(r.json().runs.map((x: Row) => x.type)).toEqual(['RC-06', 'RC-03']);
    expect(r.json().runs.every((x: Row) => x.status === 'queued')).toBe(true);
    for (const run of r.json().runs) {
      for (let i = 0; i < 60; i++) {
        const g = await admin('comp', 'GET', `/v1/admin/billing/reconciliations/${run.id}`);
        if (g.json().run.status === 'completed') break;
        await new Promise((x) => setTimeout(x, 50));
      }
      expect(
        (await admin('comp', 'GET', `/v1/admin/billing/reconciliations/${run.id}`)).json().run
          .status,
      ).toBe('completed'); // the kick ran it
    }
    // a duplicate while one is in progress: queue one without processing it
    const [q] = await fin().request(ids.fin1!, {
      types: ['RC-01'],
      periodFrom: day(-6),
      periodTo: day(-5),
    });
    const dup = await admin('fin1', 'POST', '/v1/admin/billing/reconciliations', {
      types: ['RC-01'],
      periodFrom: day(-6),
      periodTo: day(-5),
    });
    expect(dup.statusCode).toBe(409);
    await fin().process(q!.id);
    expect(
      (
        await admin('fin1', 'POST', '/v1/admin/billing/reconciliations', {
          types: ['RC-01'],
          periodFrom: day(-6),
          periodTo: day(-5),
        })
      ).statusCode,
    ).toBe(202); // finished: a new run is fine
    const list = await admin('comp', 'GET', '/v1/admin/billing/reconciliations?type=RC-01&limit=1');
    expect(list.json().items).toHaveLength(1);
    expect(
      (await admin('comp', 'GET', '/v1/admin/billing/reconciliations?type=nope')).statusCode,
    ).toBe(422);
    expect(
      (await admin('comp', 'GET', '/v1/admin/billing/reconciliations/not-a-uuid')).statusCode,
    ).toBe(404);
  });

  it('a failing source fails the run (recorded, immutable) and does not block a new run', async () => {
    const real: any = fin();
    const bad: Sources = {
      settlements: async () => {
        throw new Error('PSP report unavailable');
      },
      bills: async () => null,
    };
    const svc = new FinrecService(real.db, real.audit, bad, real.zatca, real.opts);
    const d = await reconcile('RC-01', svc, day(-9), day(-8));
    expect(d.run).toMatchObject({ status: 'failed', error: 'PSP report unavailable' });
    await expect(
      sql(`UPDATE finrec.reconciliation_runs SET status = 'completed' WHERE id = $1`, [d.run.id]),
    ).rejects.toThrow(/immutable/);
    expect((await reconcile('RC-01', fin(), day(-9), day(-8))).run.status).toBe('completed');
  });

  it('the daily schedule creates one run per type for yesterday, once, and processes them', async () => {
    const real: any = fin();
    const now = new Date('2026-03-10T02:00:00Z');
    expect(await fin().scheduleDaily(now)).toBe(6);
    expect(await fin().scheduleDaily(now)).toBe(0); // already scheduled for that day
    const runs = await sql(
      `SELECT type, trigger, status, period_from::text pf FROM finrec.reconciliation_runs WHERE trigger = 'scheduled' ORDER BY type`,
    );
    expect(runs.map((r) => r.type)).toEqual(['RC-01', 'RC-02', 'RC-03', 'RC-04', 'RC-05', 'RC-06']);
    expect(new Set(runs.map((r) => r.pf))).toEqual(new Set(['2026-03-09']));
    expect(await fin().processQueued(10, now)).toBeGreaterThanOrEqual(6);
    expect(
      (
        await sql(
          `SELECT count(*)::int n FROM finrec.reconciliation_runs WHERE trigger = 'scheduled' AND status = 'completed'`,
        )
      )[0]!.n,
    ).toBe(6);
    void real;
  });

  it('break workflow: assign (idempotent), accept needs a note, an adjustment must be APPROVED, for the same organization; resolved is final', async () => {
    const d = await reconcile('RC-02', fin(), FROM, TO);
    const item = d.items.find((i) => i.kind === 'vat_mismatch')!;
    const runId = d.run.id as string;
    const post = (body: object, who = 'fin1') =>
      admin(who, 'POST', `/v1/admin/billing/reconciliations/${runId}/resolutions`, body);
    expect((await post({ itemId: item.id, action: 'nope' })).statusCode).toBe(422);
    expect((await post({ itemId: item.id, action: 'accept' })).statusCode).toBe(422); // a note is required
    expect((await post({ itemId: item.id, action: 'adjustment' })).statusCode).toBe(422);
    expect(
      (await post({ itemId: item.id, action: 'assign', adjustmentId: crypto.randomUUID() }))
        .statusCode,
    ).toBe(422);
    expect((await post({ itemId: crypto.randomUUID(), action: 'assign' })).statusCode).toBe(404);
    expect((await post({ itemId: item.id, action: 'assign' }, 'comp')).statusCode).toBe(403);
    const a1 = await post({ itemId: item.id, action: 'assign' });
    expect(a1.statusCode).toBe(201);
    expect(a1.json()).toMatchObject({ status: 'assigned', assignedTo: ids.fin1 });
    const a2 = await post({ itemId: item.id, action: 'assign' }); // the same person again: nothing changes
    expect(a2.json().resolutions).toHaveLength(1);
    // adjustments: pending is refused, approved for another organization is refused, approved for the right one resolves
    const adj = (org: string, key: string) =>
      admin(
        'fin1',
        'POST',
        '/v1/admin/billing/adjustments',
        {
          orgId: org,
          reason: 'fix vat',
          lines: [
            {
              account: { code: '4900', org: false },
              direction: 'debit',
              amountMinor: '100',
              currency: 'SAR',
            },
            {
              account: { code: '2100', org: true },
              direction: 'credit',
              amountMinor: '100',
              currency: 'SAR',
            },
          ],
        },
        key,
      );
    const pending = (await adj(item.relatedOrg!, 'adj-pending')).json().id;
    expect(
      (await post({ itemId: item.id, action: 'adjustment', adjustmentId: pending })).statusCode,
    ).toBe(409);
    const other = (await adj(orgB, 'adj-other')).json().id;
    await admin('root', 'POST', '/v1/admin/billing/adjustments', {
      adjustmentId: other,
      decision: 'approve',
    });
    expect(
      (await post({ itemId: item.id, action: 'adjustment', adjustmentId: other })).statusCode,
    ).toBe(422);
    await admin('root', 'POST', '/v1/admin/billing/adjustments', {
      adjustmentId: pending,
      decision: 'approve',
    });
    const done = await post({
      itemId: item.id,
      action: 'adjustment',
      adjustmentId: pending,
      note: 'vat corrected',
    });
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({ status: 'resolved' });
    expect(done.json().resolutions.map((r: Row) => r.action)).toEqual(['assign', 'adjustment']);
    expect(done.json().resolutions[1]).toMatchObject({
      adjustmentId: pending,
      note: 'vat corrected',
    });
    expect((await post({ itemId: item.id, action: 'assign' })).statusCode).toBe(409); // resolved is final
    // accepting a variance with a note resolves directly
    const other2 = d.items.find((i) => i.id !== item.id && i.status === 'open')!;
    const acc = await post({
      itemId: other2.id,
      action: 'accept',
      note: 'known rounding difference, approved by finance lead',
    });
    expect(acc.json()).toMatchObject({ status: 'resolved' });
    expect(
      (await admin('comp', 'GET', `/v1/admin/billing/reconciliations/${runId}?status=resolved`))
        .json()
        .items.map((i: Row) => i.id)
        .sort(),
    ).toEqual([item.id, other2.id].sort());
    expect(
      (await admin('comp', 'GET', `/v1/admin/billing/reconciliations/${runId}`)).json().run
        .openBreaks,
    ).toBe(d.items.length - 2);
    expect(
      await count(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE action IN ('finrec.break.assigned','finrec.break.resolved_with_adjustment','finrec.break.variance_accepted')`,
      ),
    ).toBeGreaterThanOrEqual(3);
  });

  it('unresolved breaks past the SLA raise an alert once and are flagged overSla', async () => {
    const d = await reconcile('RC-06', fin(), FROM, TO);
    expect(d.items.length).toBeGreaterThan(0);
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect((await fin().get(d.run.id, { now: later })).items.every((i) => i.overSla)).toBe(true);
    expect((await fin().get(d.run.id)).items.some((i) => i.overSla)).toBe(false);
    const n = await fin().slaSweep(later);
    expect(n).toBeGreaterThan(0);
    expect(await fin().slaSweep(later)).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int n FROM audit.audit_logs WHERE action = 'finrec.break.sla_breached'`,
      ),
    ).toBe(n);
  });
});

describe('finrec database guards', () => {
  it('runs and items keep their facts; the workflow only moves forward; resolutions are append-only; nothing is deleted or truncated', async () => {
    const run = (
      await sql(
        `SELECT id FROM finrec.reconciliation_runs WHERE status = 'completed' ORDER BY created_at LIMIT 1`,
      )
    )[0]!.id;
    const item = (
      await sql(`SELECT id, status FROM finrec.reconciliation_items WHERE status = 'open' LIMIT 1`)
    )[0]!;
    const resolved = (
      await sql(`SELECT id FROM finrec.reconciliation_items WHERE status = 'resolved' LIMIT 1`)
    )[0]!;
    await expect(
      sql(`UPDATE finrec.reconciliation_runs SET breaks_count = 0 WHERE id = $1`, [run]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`DELETE FROM finrec.reconciliation_runs WHERE id = $1`, [run]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      sql(`UPDATE finrec.reconciliation_items SET kind = 'other_kind' WHERE id = $1`, [item.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql(`UPDATE finrec.reconciliation_items SET status = 'open' WHERE id = $1`, [resolved.id]),
    ).rejects.toThrow(/cannot change/);
    await expect(
      sql(`DELETE FROM finrec.reconciliation_items WHERE id = $1`, [item.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(sql(`UPDATE finrec.reconciliation_resolutions SET note = 'x'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql(`DELETE FROM finrec.reconciliation_resolutions`)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql(`TRUNCATE finrec.reconciliation_runs`)).rejects.toThrow(
      /append-only|cannot truncate/,
    );
    await expect(
      sql(
        `INSERT INTO finrec.reconciliation_resolutions (id, item_id, action, created_by) VALUES (gen_random_uuid(), $1, 'adjustment', gen_random_uuid())`,
        [item.id],
      ),
    ).rejects.toThrow(/check/);
    await expect(
      sql(
        `INSERT INTO finrec.reconciliation_resolutions (id, item_id, action, created_by) VALUES (gen_random_uuid(), $1, 'accept', gen_random_uuid())`,
        [item.id],
      ),
    ).rejects.toThrow(/check/);
  });
});
