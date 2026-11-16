import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usageEventId } from '@nuzm/platform';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { OrderService } from '../commerce';
import { MeteringIngestService } from '../metering';
import { ChromePdfRenderer, CreditNoteService, InvoiceService, TaxProfileService } from './index';
import { computeTax } from './internal/tax-engine';
import { INVOICE_TRANSITIONS, type InvoiceStatus } from './internal/invoice-state';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;

const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
let orgC = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
const PERIOD = monthStart.toISOString().slice(0, 10);
const at = (hours: number) => new Date(monthStart.getTime() + hours * 3_600_000).toISOString();
const RES = '11111111-1111-4111-8111-111111111111';
const NOW = new Date(monthStart.getTime() + 20 * 86_400_000);

const call = (
  who: string,
  url: string,
  org = orgA,
  method: 'GET' | 'POST' = 'GET',
  body?: object,
) =>
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
const usage = async (
  org: string,
  meterId: string,
  unit: string,
  quantity: string,
  hour: number,
  dimensions: Record<string, string>,
) => {
  const windowStart = at(hour);
  const r = await app.get(MeteringIngestService).ingest(
    [
      {
        orgId: org,
        eventId: usageEventId({ orgId: org, meterId, resourceId: RES, windowStart }),
        meterId,
        quantity,
        unit,
        resourceId: RES,
        windowStart,
        windowEnd: at(hour + 1),
        occurredAt: new Date().toISOString(),
        dimensions,
        dataRegion: 'sa-pending',
      },
    ],
    { source: 'compute@M05', orgIds: null },
  );
  expect(r.summary.accepted).toBe(1);
};
const ledgerOf = (txId: string) =>
  h.env.sql(
    `SELECT a.code, p.direction, p.amount_minor::text amt FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id WHERE p.transaction_id = $1 ORDER BY a.code, p.direction`,
    [txId],
  ) as Promise<Row[]>;
const count = async (q: string, p: unknown[] = []) => Number((await h.env.sql(q, p))[0]!.n);
const audits = (org: string, action: string) =>
  h.env.sql(`SELECT after FROM audit.audit_logs WHERE org_id=$1 AND action=$2 ORDER BY id`, [
    org,
    action,
  ]) as Promise<Row[]>;
const mk = async (who: string, name: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
      payload: { name },
    })
  ).json().id as string;

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  orgA = await mk('alice', 'Invoice A');
  orgB = await mk('bob', 'Invoice B');
  orgC = await mk('frank', 'Invoice C');
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'billing_admin'],
    ['erin', 'developer'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgA, ids[u], role],
    );
  await app.get(TaxProfileService).put(
    orgA,
    ids.alice!,
    {
      buyerType: 'b2b',
      legalName: { ar: 'شركة الأفق', en: 'Horizon Co' },
      vatNumber: '300000000000003',
      crNumber: '1010000000',
      address: {
        street: 'King Fahd Road',
        buildingNumber: '1234',
        district: 'Olaya',
        city: 'Riyadh',
        postalCode: '12211',
        country: 'SA',
      },
    },
    null,
  );

  // org A: usage in three priced meters (+ one free-tier meter) and an order from an ai-credit quote
  await usage(orgA, 'compute.vcpu_hours', 'vcpu_hour', '10', 1, { region: 'x' });
  await usage(orgA, 'compute.vcpu_hours', 'vcpu_hour', '2.5', 2, { region: 'x' }); // 12.5 × 5 = 62.5 → 63
  await usage(orgA, 'storage.object_gb_months', 'gib_month', '1001', 3, { class: 'c' }); // volume: 1001 × 15 = 15015
  await usage(orgA, 'email.transactional_messages', 'message', '1500', 4, { stream: 's' }); // 1000 free, 500 × 0.1 → 50
  await usage(orgA, 'network.egress_gb', 'gb', '3', 5, { region: 'x' }); // inside the 100 GB free tier: no line
  const q = (
    await call('erin', '/v1/quotes', orgA, 'POST', {
      kind: 'ai-credit',
      items: [{ credits: '1000' }],
    })
  ).json();
  await app.get(OrderService).createFromQuote(orgA, q.id, ids.erin!);
  // org B: one small meter (used for the concurrent close)
  await usage(orgB, 'compute.vcpu_hours', 'vcpu_hour', '2', 1, { region: 'x' });
});
afterAll(() => h.close());

const svc = () => app.get(InvoiceService);
let first: Awaited<ReturnType<InvoiceService['periodClose']>>;

describe('period close: rating → lines → tax → number → ledger', () => {
  it('builds one invoice from rated usage and uninvoiced orders, with per-line tax and the sum rule', async () => {
    first = await svc().periodClose(orgA, PERIOD, null, NOW);
    expect(first.created).toBe(true);
    const inv = first.invoice!;
    expect(inv).toMatchObject({
      number: 'NZM-00000001',
      status: 'open',
      environment: 'sandbox',
      currency: 'SAR',
      periodStart: PERIOD,
      ledgerPosted: true,
      dataRegion: 'sa-pending',
      zatca: { state: 'not_generated' },
    });
    expect(inv.lines.map((l) => [l.kind, l.meterId, l.netMinor])).toEqual([
      ['usage', 'compute.vcpu_hours', '63'],
      ['usage', 'email.transactional_messages', '50'],
      ['usage', 'storage.object_gb_months', '15015'],
      ['order', 'ai.credits_consumed', '1000'],
    ]);
    const t = computeTax([63n, 50n, 15015n, 1000n], 1500);
    expect(inv.lines.map((l) => l.taxMinor)).toEqual(t.lines.map((l) => l.taxMinor.toString()));
    expect(inv).toMatchObject({
      subtotalMinor: '16128',
      taxMinor: t.taxMinor.toString(),
      totalMinor: t.totalMinor.toString(),
      paidMinor: '0',
    });
    expect(inv.taxBreakdown).toEqual([
      { rateCode: 'SA-VAT-STD', rateBps: 1500, netMinor: '16128', taxMinor: t.taxMinor.toString() },
    ]);
    expect(inv.buyer).toMatchObject({ buyerType: 'b2b', vatNumber: '300000000000003' });
    expect(inv.seller.placeholder).toBe(true);
    expect(first.unpriced).toEqual([]); // the free-tier egress is priced (0), not unpriced
  });

  it('rating_to_invoice_to_ledger_totals_match: the ledger holds exactly the invoice (Dr receivable, Cr revenue + VAT)', async () => {
    const inv = first.invoice!;
    const tx = (
      await h.env.sql(`SELECT ledger_transaction_id id FROM invoicing.invoices WHERE id = $1`, [
        inv.id,
      ])
    )[0]!.id as string;
    const rows = await ledgerOf(tx);
    const by = Object.fromEntries(
      rows.map((r) => [`${r.code}${r.direction === 'debit' ? 'D' : 'C'}`, r.amt]),
    );
    expect(by['1200D']).toBe(inv.totalMinor); // receivable = total
    expect(by['4100C']).toBe('16128'); // usage 63 + 50 + 15015 and the ai-credit order 1000 all book to 4100
    expect(by['2300C']).toBe(inv.taxMinor);
    const totalCredits = rows
      .filter((r) => r.direction === 'credit')
      .reduce((s, r) => s + BigInt(r.amt), 0n);
    expect(totalCredits.toString()).toBe(inv.totalMinor);
    expect(
      rows
        .filter((r) => r.direction === 'debit')
        .reduce((s, r) => s + BigInt(r.amt), 0n)
        .toString(),
    ).toBe(inv.totalMinor);
    // rated usage (latest rating per key) equals the usage lines
    const rated = (
      await h.env.sql(
        `SELECT coalesce(sum(amount_minor),0)::text s FROM (SELECT DISTINCT ON (meter_id, resource_key, segment_start) amount_minor FROM metering.rated_usage WHERE org_id = $1 AND period_start = $2 ORDER BY meter_id, resource_key, segment_start, created_at DESC, id DESC) t`,
        [orgA, PERIOD],
      )
    )[0]!.s;
    expect(rated).toBe('15128');
  });

  it('AC-M03-06: running the close again creates nothing (no invoice, line, ledger row, event or rating run)', async () => {
    const snap = async () => ({
      inv: await count(`SELECT count(*)::int n FROM invoicing.invoices WHERE org_id = $1`, [orgA]),
      lines: await count(`SELECT count(*)::int n FROM invoicing.invoice_lines WHERE org_id = $1`, [
        orgA,
      ]),
      tx: await count(`SELECT count(*)::int n FROM billing.ledger_transactions WHERE org_id = $1`, [
        orgA,
      ]),
      ev: await count(
        `SELECT count(*)::int n FROM platform.outbox WHERE org_id = $1 AND topic = 'invoice.issued'`,
        [orgA],
      ),
      rated: await count(`SELECT count(*)::int n FROM metering.rated_usage WHERE org_id = $1`, [
        orgA,
      ]),
    });
    const before = await snap();
    for (let i = 0; i < 3; i++) {
      const again = await svc().periodClose(orgA, PERIOD, null, NOW);
      expect(again.created).toBe(false);
      expect(again.invoice!.id).toBe(first.invoice!.id);
    }
    expect(await snap()).toEqual(before);
    expect(before.ev).toBe(1);
  });

  it('repairs a missing ledger link on the next call instead of double posting', async () => {
    const inv = first.invoice!;
    // simulate a crash after the invoice committed but before the ledger link was stored: the posting exists, the link does not
    await h.env.sql(
      `ALTER TABLE invoicing.invoices DISABLE TRIGGER invoice_guard; UPDATE invoicing.invoices SET ledger_transaction_id = NULL WHERE id = '${inv.id}'; ALTER TABLE invoicing.invoices ENABLE TRIGGER invoice_guard`,
    );
    expect((await svc().get(orgA, inv.id)).ledgerPosted).toBe(false);
    const before = await count(
      `SELECT count(*)::int n FROM billing.ledger_transactions WHERE idempotency_key = $1`,
      [`invoice:${inv.id}`],
    );
    const fixed = await svc().periodClose(orgA, PERIOD, null, NOW);
    expect(fixed.invoice!.ledgerPosted).toBe(true);
    expect(
      await count(
        `SELECT count(*)::int n FROM billing.ledger_transactions WHERE idempotency_key = $1`,
        [`invoice:${inv.id}`],
      ),
    ).toBe(before); // still one
  });

  it('records the issue in the audit trail and the outbox, with no usage lines billed twice', async () => {
    expect((await audits(orgA, 'invoicing.invoice.issued')).length).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int n FROM (SELECT source_id FROM invoicing.invoice_lines WHERE org_id = $1 GROUP BY source_id HAVING count(*) > 1) d`,
        [orgA],
      ),
    ).toBe(0);
    // a late order for the same period is picked up by a LATER invoice only if it is a new period key; the unique source id forbids rebilling
    await expect(
      h.env.sql(
        `INSERT INTO invoicing.invoice_lines (id, invoice_id, org_id, position, kind, description, quantity, unit, net_minor, tax_minor, rate_code, rate_bps, revenue_account, source_id) SELECT gen_random_uuid(), invoice_id, org_id, 99, kind, description, quantity, unit, net_minor, tax_minor, rate_code, rate_bps, revenue_account, source_id FROM invoicing.invoice_lines WHERE org_id = '${orgA}' LIMIT 1`,
      ),
    ).rejects.toThrow();
  });

  it('parallel closes of one period issue exactly one invoice and leave no gap in the numbering', async () => {
    const res = await Promise.all(
      Array.from({ length: 8 }, () => svc().periodClose(orgB, PERIOD, null, NOW)),
    );
    expect(res.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(res.map((r) => r.invoice!.id)).size).toBe(1);
    expect(res[0]!.invoice!.number).toBe('NZM-00000002'); // org A took 1; the 7 losers gave their numbers back
    expect(
      await count(`SELECT count(*)::int n FROM invoicing.invoices WHERE org_id = $1`, [orgB]),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int n FROM billing.ledger_transactions WHERE org_id = $1 AND kind = 'invoice_issued'`,
        [orgB],
      ),
    ).toBe(1);
  });

  it('an empty period issues nothing; a foreign buyer is flagged for tax review; the buyer snapshot survives later profile edits', async () => {
    expect((await svc().periodClose(orgC, PERIOD, null, NOW)).invoice).toBeNull();
    await usage(orgC, 'compute.vcpu_hours', 'vcpu_hour', '4', 1, { region: 'x' });
    await app.get(TaxProfileService).put(
      orgC,
      ids.frank!,
      {
        buyerType: 'b2c',
        legalName: { ar: 'عميل أجنبي', en: 'Foreign Customer' },
        address: { country: 'AE' },
      },
      null,
    );
    const c = (await svc().periodClose(orgC, PERIOD, null, NOW)).invoice!;
    expect(c.taxReview).toMatchObject({ required: true });
    expect(c.taxReview.reasons).toContain('buyer_outside_jurisdiction');
    await app.get(TaxProfileService).put(
      orgC,
      ids.frank!,
      {
        buyerType: 'b2c',
        legalName: { ar: 'اسم جديد', en: 'Renamed' },
        address: { country: 'AE' },
      },
      1,
    );
    expect((await svc().get(orgC, c.id)).buyer.legalName.en).toBe('Foreign Customer');
  });

  it('refuses a bad period and refuses to issue outside the sandbox with the placeholder entity', async () => {
    await expect(svc().periodClose(orgA, '2026-11-15', null, NOW)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    const live = new InvoiceService(
      h.env.app,
      { record: async () => undefined } as never,
      { post: async () => ({ transactionId: 'x', duplicate: false }) },
      { estimate: async () => ({}) as never },
      { rate: async () => ({ rows: [], unpriced: [] }) as never },
      app.get(InvoiceService)['sequences'],
      new ChromePdfRenderer(),
      { mode: 'live', dueDays: 14 },
    );
    await expect(live.periodClose(orgA, PERIOD, null, NOW)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });
});

describe('immutability and state machine at the database', () => {
  const FAKE_ORG = crypto.randomUUID(); // synthetic rows for the state-machine checks: never visible to a real organization
  const invId = () => first.invoice!.id;
  it('no role can edit an issued invoice, its lines, or delete/truncate them', async () => {
    for (const sql of [
      `UPDATE invoicing.invoices SET total_minor = 1, subtotal_minor = 1, tax_minor = 0 WHERE id = '${invId()}'`,
      `UPDATE invoicing.invoices SET buyer = '{}'::jsonb WHERE id = '${invId()}'`,
      `UPDATE invoicing.invoices SET number = 99 WHERE id = '${invId()}'`,
      `UPDATE invoicing.invoice_lines SET net_minor = 1 WHERE invoice_id = '${invId()}'`,
      `DELETE FROM invoicing.invoice_lines WHERE invoice_id = '${invId()}'`,
      `DELETE FROM invoicing.invoices WHERE id = '${invId()}'`,
      `TRUNCATE invoicing.invoices CASCADE`,
      `TRUNCATE invoicing.invoice_lines`,
    ])
      await expect(h.env.sql(sql), sql).rejects.toThrow(
        /immutable|never|violates|cannot truncate/i,
      );
    for (const role of ['app', 'worker'] as const) {
      await expect(
        h.env[role].withOrg(orgA, (c) => c.query(`UPDATE invoicing.invoices SET total_minor = 1`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        h.env[role].withOrg(orgA, (c) => c.query(`DELETE FROM invoicing.invoices`)),
      ).rejects.toThrow(/permission denied/);
    }
  });
  it('lines cannot be added to an invoice after the transaction that created it', async () => {
    await expect(
      h.env.sql(
        `INSERT INTO invoicing.invoice_lines (id, invoice_id, org_id, position, kind, description, quantity, unit, net_minor, tax_minor, rate_code, rate_bps, revenue_account, source_id) VALUES (gen_random_uuid(), '${invId()}', '${orgA}', 50, 'usage', 'late', 1, 'u', 1, 0, 'X', 0, '4100', 'late-1')`,
      ),
    ).rejects.toThrow(/transaction that creates/);
  });
  it('the database state machine equals the code table for every (from, to) pair', async () => {
    const all: InvoiceStatus[] = [
      'draft',
      'open',
      'partially_paid',
      'paid',
      'void',
      'uncollectible',
    ];
    let n = 0;
    for (const from of all)
      for (const to of all) {
        if (from === to) continue;
        const id = crypto.randomUUID();
        const total = 100;
        const paid = from === 'paid' ? total : from === 'partially_paid' ? 40 : 0;
        await h.env.sql(
          `INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, paid_minor, buyer, seller)
         SELECT $1, $2, id, 'SM', $3::bigint, 'SM-' || $3::text, $4, 'sandbox', 'SAR', '2020-01-01', '2020-01-31', now(), now(), $5, 87, 13, $6, $7, '{}', '{}' FROM invoicing.billing_entities LIMIT 1`,
          [id, FAKE_ORG, ++n, from, `sm-${n}`, total, paid],
        );
        const toPaid = to === 'paid' ? total : paid;
        const attempt = h.env.sql(
          `UPDATE invoicing.invoices SET status = $2, paid_minor = $3, updated_at = now() WHERE id = $1`,
          [id, to, toPaid],
        );
        if (INVOICE_TRANSITIONS[from].includes(to))
          await expect(attempt, `${from}→${to}`).resolves.toBeDefined();
        else await expect(attempt, `${from}→${to}`).rejects.toThrow();
      }
  });
  it('paid_minor never decreases and the ledger link is set once', async () => {
    const id = crypto.randomUUID();
    await h.env
      .sql(`INSERT INTO invoicing.invoices (id, org_id, entity_id, series, number, number_text, status, environment, currency, period_start, period_end, issued_at, due_at, source_key, subtotal_minor, tax_minor, total_minor, paid_minor, buyer, seller)
      SELECT '${id}', '${FAKE_ORG}', id, 'PM', 1, 'PM-1', 'partially_paid', 'sandbox', 'SAR', '2020-01-01', '2020-01-31', now(), now(), 'pm-1', 87, 13, 100, 40, '{}', '{}' FROM invoicing.billing_entities LIMIT 1`);
    await expect(
      h.env.sql(`UPDATE invoicing.invoices SET paid_minor = 10 WHERE id = '${id}'`),
    ).rejects.toThrow(/only grow/);
    await h.env.sql(
      `UPDATE invoicing.invoices SET ledger_transaction_id = gen_random_uuid() WHERE id = '${id}'`,
    );
    await expect(
      h.env.sql(
        `UPDATE invoicing.invoices SET ledger_transaction_id = gen_random_uuid() WHERE id = '${id}'`,
      ),
    ).rejects.toThrow(/set once/);
  });
});

describe('credit notes', () => {
  const notes = () => app.get(CreditNoteService);
  const sumLedger = async (orgId: string) => {
    const rows = (await h.env.sql(
      `SELECT a.code, p.direction, sum(p.amount_minor)::text amt FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE t.org_id = $1 AND t.kind IN ('invoice_issued','credit_note') GROUP BY a.code, p.direction`,
      [orgId],
    )) as Row[];
    const net = new Map<string, bigint>();
    for (const r of rows)
      net.set(
        r.code,
        (net.get(r.code) ?? 0n) + (r.direction === 'debit' ? 1n : -1n) * BigInt(r.amt),
      );
    return net;
  };

  it('a partial credit takes the line rate; crediting a line completely takes its exact remaining tax', async () => {
    const inv = first.invoice!;
    const storage = inv.lines.find((l) => l.meterId === 'storage.object_gb_months')!;
    const lineId = (
      await h.env.sql(
        `SELECT id FROM invoicing.invoice_lines WHERE invoice_id = $1 AND position = $2`,
        [inv.id, storage.position],
      )
    )[0]!.id as string;
    const part = await notes().issue(
      orgA,
      ids.alice!,
      {
        invoiceId: inv.id,
        reasonCode: 'service_issue',
        reason: 'half month outage',
        sourceKey: 'cn-part-1',
        lines: [{ invoiceLineId: lineId, netMinor: '5000' }],
      },
      NOW,
    );
    expect(part).toMatchObject({
      number: 'NZMC-00000001',
      status: 'issued',
      netMinor: '5000',
      taxMinor: '750',
      totalMinor: '5750',
      invoiceNumber: 'NZM-00000001',
      ledgerPosted: true,
    });
    const rest = await notes().issue(
      orgA,
      ids.alice!,
      {
        invoiceId: inv.id,
        reasonCode: 'service_issue',
        reason: 'the rest of the line',
        sourceKey: 'cn-part-2',
        lines: [{ invoiceLineId: lineId, netMinor: '10015' }],
      },
      NOW,
    );
    expect(rest.netMinor).toBe('10015');
    expect(BigInt(part.taxMinor) + BigInt(rest.taxMinor)).toBe(BigInt(storage.taxMinor)); // exact: 750 + 1502 = 2252, no rounding drift
    await expect(
      notes().issue(
        orgA,
        ids.alice!,
        {
          invoiceId: inv.id,
          reasonCode: 'service_issue',
          reason: 'too much',
          sourceKey: 'cn-part-3',
          lines: [{ invoiceLineId: lineId, netMinor: '1' }],
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('is idempotent per source key and numbers credit notes without gaps', async () => {
    const inv = first.invoice!;
    const again = await notes().issue(
      orgA,
      ids.alice!,
      {
        invoiceId: inv.id,
        reasonCode: 'service_issue',
        reason: 'half month outage',
        sourceKey: 'cn-part-1',
      },
      NOW,
    );
    expect(again.number).toBe('NZMC-00000001');
    expect(
      await count(`SELECT count(*)::int n FROM invoicing.credit_notes WHERE org_id = $1`, [orgA]),
    ).toBe(2);
    expect(
      await count(
        `SELECT count(*)::int n FROM billing.ledger_transactions WHERE kind = 'credit_note' AND org_id = $1`,
        [orgA],
      ),
    ).toBe(2);
  });

  it('a full credit of what is left cancels the invoice in the ledger; nothing is left afterwards', async () => {
    const inv = first.invoice!;
    const full = await notes().issue(
      orgA,
      ids.alice!,
      {
        invoiceId: inv.id,
        reasonCode: 'cancelled',
        reason: 'customer cancelled',
        sourceKey: 'cn-full',
      },
      NOW,
    );
    expect(full.number).toBe('NZMC-00000003');
    const t = (await svc().get(orgA, inv.id)).totalMinor;
    const all = await app.get(CreditNoteService).list(orgA, { limit: 50 });
    expect(all.items.reduce((s, n) => s + BigInt(n.totalMinor), 0n).toString()).toBe(t); // credit notes sum to exactly the invoice
    for (const v of (await sumLedger(orgA)).values()) expect(v).toBe(0n); // invoice + credit notes net to zero on every account
    await expect(
      notes().issue(
        orgA,
        ids.alice!,
        { invoiceId: inv.id, reasonCode: 'cancelled', reason: 'again', sourceKey: 'cn-full-2' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('credit notes never exceed the invoice (trigger backstop), are immutable, and refuse void invoices', async () => {
    const inv = first.invoice!;
    await expect(
      h.env.sql(
        `INSERT INTO invoicing.credit_notes (id, org_id, invoice_id, entity_id, series, number, number_text, environment, currency, reason_code, reason, lines, net_minor, tax_minor, total_minor, issued_at, source_key) SELECT gen_random_uuid(), org_id, id, entity_id, 'NZMC', 900, 'NZMC-900', 'sandbox', currency, 'extra', 'x', '[]', 1, 0, 1, now(), 'over-1' FROM invoicing.invoices WHERE id = '${inv.id}'`,
      ),
    ).rejects.toThrow(/exceed the invoice/);
    await expect(
      h.env.sql(
        `UPDATE invoicing.credit_notes SET total_minor = 1, net_minor = 1, tax_minor = 0 WHERE org_id = '${orgA}'`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(h.env.sql(`DELETE FROM invoicing.credit_notes`)).rejects.toThrow(/never deleted/);
    await expect(h.env.sql(`TRUNCATE invoicing.credit_notes`)).rejects.toThrow();
    const b = (await svc().periodClose(orgB, PERIOD, null, NOW)).invoice!;
    await h.env.sql(`UPDATE invoicing.invoices SET status = 'void' WHERE id = '${b.id}'`);
    await expect(
      notes().issue(
        orgB,
        ids.bob!,
        { invoiceId: b.id, reasonCode: 'oops', reason: 'void invoice', sourceKey: 'cn-void' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('parallel partial credits can never exceed an invoice', async () => {
    const c = (await svc().periodClose(orgC, PERIOD, null, NOW)).invoice!; // org C: one line, net 20 (4 vcpu × 5)
    const lineId = (
      await h.env.sql(`SELECT id FROM invoicing.invoice_lines WHERE invoice_id = $1`, [c.id])
    )[0]!.id as string;
    const res = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        notes().issue(
          orgC,
          ids.frank!,
          {
            invoiceId: c.id,
            reasonCode: 'goodwill',
            reason: 'race',
            sourceKey: `race-${i}`,
            lines: [{ invoiceLineId: lineId, netMinor: '5' }],
          },
          NOW,
        ),
      ),
    );
    const ok = res.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(4); // 20 / 5
    expect(
      (
        await h.env.sql(
          `SELECT coalesce(sum(net_minor),0)::text s FROM invoicing.credit_notes WHERE invoice_id = $1`,
          [c.id],
        )
      )[0]!.s,
    ).toBe('20');
  });
});

describe('invoice API', () => {
  it('only billing readers read invoices; viewers and developers are refused', async () => {
    expect((await call('dave', '/v1/billing/invoices')).statusCode).toBe(200);
    expect((await call('alice', '/v1/billing/invoices')).statusCode).toBe(200);
    expect((await call('carol', '/v1/billing/invoices')).statusCode).toBe(403);
    expect((await call('erin', `/v1/billing/invoices/${first.invoice!.id}`)).statusCode).toBe(403);
  });
  it('lists newest first with filters and a cursor, and shows one invoice with lines and breakdown', async () => {
    const list = (await call('dave', '/v1/billing/invoices?limit=1')).json();
    expect(list.items).toHaveLength(1);
    expect((await call('dave', '/v1/billing/invoices?status=paid')).json().items).toEqual([]);
    expect((await call('dave', '/v1/billing/invoices?status=bogus')).statusCode).toBe(422);
    expect((await call('dave', '/v1/billing/invoices?from=junk')).statusCode).toBe(422);
    const one = (await call('dave', `/v1/billing/invoices/${first.invoice!.id}`)).json();
    expect(one).toMatchObject({ number: 'NZM-00000001', totalMinor: first.invoice!.totalMinor });
    expect(one.lines).toHaveLength(4);
    expect((await call('dave', '/v1/billing/invoices/not-a-uuid')).statusCode).toBe(404);
  });
  it('is tenant isolated: another organization sees none of it, by list or by id', async () => {
    expect(
      (await call('bob', '/v1/billing/invoices', orgB)).json().items.map((i: Row) => i.id),
    ).not.toContain(first.invoice!.id);
    expect((await call('bob', `/v1/billing/invoices/${first.invoice!.id}`, orgB)).statusCode).toBe(
      404,
    );
    expect(
      (await call('bob', `/v1/billing/invoices/${first.invoice!.id}/pdf`, orgB)).statusCode,
    ).toBe(404);
    expect(
      (
        await h.env.app.withOrg(orgB, (c) =>
          c.query(`SELECT count(*)::int n FROM invoicing.invoices WHERE org_id = $1`, [orgA]),
        )
      ).rows[0]!.n,
    ).toBe(0);
  });
  it('the e-invoice XML is 409 until the ZATCA module generates it', async () => {
    const r = await call('dave', `/v1/billing/invoices/${first.invoice!.id}/xml`);
    expect(r.statusCode).toBe(409);
    expect(
      (await call('bob', `/v1/billing/invoices/${first.invoice!.id}/xml`, orgB)).statusCode,
    ).toBe(404);
  });
  it('lists credit notes with the original invoice and shows one', async () => {
    const list = (
      await call('dave', `/v1/billing/credit-notes?invoice=${first.invoice!.id}`)
    ).json();
    expect(list.items.length).toBe(3);
    expect(list.items[0].invoiceNumber).toBe('NZM-00000001');
    const one = (await call('dave', `/v1/billing/credit-notes/${list.items[0].id}`)).json();
    expect(one.lines.length).toBeGreaterThan(0);
    expect((await call('carol', '/v1/billing/credit-notes')).statusCode).toBe(403);
    expect(
      (await call('bob', `/v1/billing/credit-notes/${list.items[0].id}`, orgB)).statusCode,
    ).toBe(404);
  });
  it('AC-M03-05 at invoice level: for every invoice, Σ line net = subtotal and Σ line tax = tax', async () => {
    const bad = await h.env.sql(
      `SELECT i.id FROM invoicing.invoices i JOIN invoicing.invoice_lines l ON l.invoice_id = i.id GROUP BY i.id HAVING sum(l.net_minor) <> max(i.subtotal_minor) OR sum(l.tax_minor) <> max(i.tax_minor)`,
    );
    expect(bad).toEqual([]);
  });
});

describe('PDF (Arabic and English)', async () => {
  const chrome = new ChromePdfRenderer();
  const have = await chrome.available();
  it.skipIf(!have)(
    'renders a real PDF in both languages from the immutable snapshot',
    async () => {
      for (const lang of ['ar', 'en'] as const) {
        const r = await call('dave', `/v1/billing/invoices/${first.invoice!.id}/pdf?lang=${lang}`);
        expect(r.statusCode, lang).toBe(200);
        expect(r.headers['content-type']).toBe('application/pdf');
        expect(r.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(r.rawPayload.length).toBeGreaterThan(5_000);
        expect(String(r.headers['content-disposition'])).toContain('NZM-00000001.pdf');
      }
      expect(
        (await call('dave', `/v1/billing/invoices/${first.invoice!.id}/pdf?lang=fr`)).statusCode,
      ).toBe(422);
    },
    120_000,
  );
  it.skipIf(!have)(
    'renders a credit note PDF',
    async () => {
      const list = (
        await call('dave', `/v1/billing/credit-notes?invoice=${first.invoice!.id}`)
      ).json();
      const pdf = await app.get(CreditNoteService).pdf(orgA, list.items[0].id, 'ar');
      expect(pdf.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.filename).toMatch(/^NZMC-/);
    },
    120_000,
  );
});
