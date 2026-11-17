import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { amountOf, type SubscriptionItem } from '../../billing';

/**
 * Revenue and finance reports (docs/11 §10). Money comes from the LEDGER wherever the ledger knows it (single source); documents (invoice lines,
 * credit notes, refunds) are used only for the breakdowns the ledger does not carry (VAT rate, refund counts), and every report that has a ledger
 * counterpart says whether it ties to it (`matchesLedger`), which the tests assert. Amounts are integer minor units as strings; no floats.
 * Reads span organizations through the admin scope and are AUDITED.
 */
export const REPORTS = [
  'revenue',
  'mrr',
  'ar_aging',
  'vat',
  'margin',
  'refunds',
  'dunning',
  'wallet',
] as const;
export type ReportName = (typeof REPORTS)[number];

export interface Column {
  key: string;
  label: string;
  /** `money` and `int` are never text-escaped in CSV (a negative amount is not a formula); `text` is guarded against formula injection. */
  kind: 'text' | 'money' | 'int';
}
export interface Report {
  report: ReportName;
  from: string;
  to: string;
  generatedAt: string;
  columns: Column[];
  rows: Record<string, string | number | boolean | null>[];
  totals: Record<string, string | number | boolean | null>;
  notes: string[];
}

type Row = Record<string, unknown>;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REVENUE_ACCOUNTS = `('4100','4200','4300','4400')`;
const PRODUCT: Record<string, string> = {
  '4100': 'usage',
  '4200': 'subscription',
  '4300': 'domains',
  '4400': 'marketplace',
};
const big = (v: unknown) => BigInt(String(v ?? '0'));
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDay = (s: string, n: number) =>
  day(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000));
const start = (s: string) => `${s}T00:00:00Z`;
const signed = `CASE WHEN p.direction = 'credit' THEN p.amount_minor ELSE -p.amount_minor END`;
const month = `to_char(t.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM')`;

const col = (key: string, label: string, kind: Column['kind'] = 'text'): Column => ({
  key,
  label,
  kind,
});
const ledgerNet = async (
  c: PoolClient,
  codes: string,
  direction: 'credit' | 'debit',
  from: string,
  toEx: string,
  extra = '',
) =>
  big(
    (
      await c.query(
        `SELECT coalesce(sum(CASE WHEN p.direction = $3 THEN p.amount_minor ELSE -p.amount_minor END), 0)::text n FROM billing.ledger_postings p
           JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id
          WHERE a.code IN ${codes} AND t.occurred_at >= $1::timestamptz AND t.occurred_at < $2::timestamptz ${extra}`,
        [start(from), start(toEx), direction],
      )
    ).rows[0]!.n,
  );

export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  static parseRange(
    from: string | undefined,
    to: string | undefined,
    now = new Date(),
  ): { from: string; to: string } {
    const t = to ?? day(now);
    const f = from ?? `${t.slice(0, 7)}-01`;
    for (const [k, v] of [
      ['from', f],
      ['to', t],
    ] as const)
      if (
        !DATE.test(v) ||
        Number.isNaN(Date.parse(v)) ||
        new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v
      )
        throw new ProblemException('validation_failed', `${k} must be a date (YYYY-MM-DD)`);
    if (t < f) throw new ProblemException('validation_failed', 'to must not be before from');
    if ((Date.parse(t) - Date.parse(f)) / 86_400_000 > 400)
      throw new ProblemException('validation_failed', 'a report covers at most 400 days');
    if (Date.parse(t) > now.getTime() + 86_400_000)
      throw new ProblemException('validation_failed', 'to is in the future');
    return { from: f, to: t };
  }

  async generate(
    actorUserId: string,
    name: string,
    input: { from?: string | undefined; to?: string | undefined; format: 'json' | 'csv' },
    now = new Date(),
  ): Promise<Report> {
    if (!(REPORTS as readonly string[]).includes(name))
      throw new ProblemException(
        'validation_failed',
        `report must be one of ${REPORTS.join(', ')}`,
      );
    const { from, to } = ReportService.parseRange(input.from, input.to, now);
    const report = await this.db.withPlatformScope((c) =>
      this.build(c, name as ReportName, from, to, now),
    );
    await this.audit.record({
      action: 'finrec.report.read',
      actorUserId,
      resource: { type: 'revenue_report', id: name },
      outcome: 'success',
      detail: { report: name, from, to, format: input.format, rows: report.rows.length },
    });
    return report;
  }

  private base(
    report: ReportName,
    from: string,
    to: string,
    now: Date,
    columns: Column[],
    rows: Report['rows'],
    totals: Report['totals'],
    notes: string[] = [],
  ): Report {
    return { report, from, to, generatedAt: now.toISOString(), columns, rows, totals, notes };
  }

  private async build(
    c: PoolClient,
    name: ReportName,
    from: string,
    to: string,
    now: Date,
  ): Promise<Report> {
    const toEx = addDay(to, 1);
    switch (name) {
      case 'revenue': {
        const rows = (
          await c.query(
            `SELECT ${month} period, a.code, p.currency::text cur, coalesce(p.dimensions->>'billing_entity_id', '') entity, sum(${signed})::text amt
               FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id
              WHERE a.code IN ${REVENUE_ACCOUNTS} AND t.occurred_at >= $1::timestamptz AND t.occurred_at < $2::timestamptz GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,
            [start(from), start(toEx)],
          )
        ).rows as Row[];
        const total = rows.reduce((s, r) => s + big(r.amt), 0n);
        return this.base(
          'revenue',
          from,
          to,
          now,
          [
            col('period', 'Period'),
            col('product', 'Product'),
            col('account', 'Account'),
            col('entityId', 'Billing entity'),
            col('currency', 'Currency'),
            col('revenueMinor', 'Revenue (minor units)', 'money'),
          ],
          rows.map((r) => ({
            period: r.period as string,
            product: PRODUCT[r.code as string]!,
            account: r.code as string,
            entityId: (r.entity as string) || null,
            currency: r.cur as string,
            revenueMinor: String(r.amt),
          })),
          {
            revenueMinor: total.toString(),
            ledgerRevenueMinor: (
              await ledgerNet(c, REVENUE_ACCOUNTS, 'credit', from, toEx)
            ).toString(),
          },
          [
            'Revenue is ledger revenue (accounts 4100-4400, net of credit notes); discounts (4900) are not netted here.',
            'A breakdown by meter group is not available: invoice revenue postings carry no meter dimension (spec gap).',
          ],
        );
      }
      case 'mrr': {
        const rows = (
          await c.query(
            `SELECT currency::text cur, items, quantity, status FROM billing.subscriptions WHERE status IN ('active','past_due')`,
          )
        ).rows as Row[];
        const by = new Map<string, { plan: string; cur: string; n: number; mrr: bigint }>();
        for (const r of rows) {
          const items = r.items as SubscriptionItem[];
          const k = `${items[0]!.planKey}|${r.cur as string}`;
          const e = by.get(k) ?? { plan: items[0]!.planKey, cur: r.cur as string, n: 0, mrr: 0n };
          e.n++;
          e.mrr += amountOf(items, r.quantity as number);
          by.set(k, e);
        }
        const out = [...by.values()].sort(
          (a, b) => a.plan.localeCompare(b.plan) || a.cur.localeCompare(b.cur),
        );
        const sum = (cur: string) =>
          out.filter((x) => x.cur === cur).reduce((s, x) => s + x.mrr, 0n);
        const cur = out[0]?.cur ?? 'SAR';
        return this.base(
          'mrr',
          from,
          to,
          now,
          [
            col('planKey', 'Plan'),
            col('currency', 'Currency'),
            col('subscriptions', 'Subscriptions', 'int'),
            col('mrrMinor', 'MRR (minor units)', 'money'),
            col('arrMinor', 'ARR (minor units)', 'money'),
          ],
          out.map((x) => ({
            planKey: x.plan,
            currency: x.cur,
            subscriptions: x.n,
            mrrMinor: x.mrr.toString(),
            arrMinor: (x.mrr * 12n).toString(),
          })),
          {
            currency: cur,
            mrrMinor: sum(cur).toString(),
            arrMinor: (sum(cur) * 12n).toString(),
            subscriptions: out.reduce((s, x) => s + x.n, 0),
          },
          [
            'As of now (the current state of active and past-due subscriptions; the from/to range is not used). Trialing, unpaid and cancelled subscriptions are not counted. Contract prices are the frozen snapshots, before VAT.',
          ],
        );
      }
      case 'ar_aging': {
        const rows = (
          await c.query(
            `WITH bal AS (
               SELECT p.dimensions->>'invoice_id' inv, p.currency::text cur, sum(CASE WHEN p.direction = 'debit' THEN p.amount_minor ELSE -p.amount_minor END) amt
                 FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id
                WHERE a.code = '1200' AND t.occurred_at < $1::timestamptz GROUP BY 1,2)
             SELECT b.inv, b.cur, b.amt::text amt, i.org_id, i.number_text, i.due_at FROM bal b LEFT JOIN invoicing.invoices i ON i.id::text = b.inv WHERE b.amt <> 0 ORDER BY i.due_at NULLS LAST, b.inv LIMIT 5001`,
            [start(toEx)],
          )
        ).rows as Row[];
        const asOf = Date.parse(start(toEx));
        const bucket = (due: Date | null) => {
          if (!due) return 'unattributed';
          const d = Math.floor((asOf - due.getTime()) / 86_400_000);
          return d <= 0
            ? 'current'
            : d <= 30
              ? '1-30'
              : d <= 60
                ? '31-60'
                : d <= 90
                  ? '61-90'
                  : '90+';
        };
        const buckets: Record<string, bigint> = {
          current: 0n,
          '1-30': 0n,
          '31-60': 0n,
          '61-90': 0n,
          '90+': 0n,
          unattributed: 0n,
        };
        const out = rows.slice(0, 5000).map((r) => {
          const b = bucket(r.due_at as Date | null);
          buckets[b] = buckets[b]! + big(r.amt);
          return {
            invoiceNumber: (r.number_text as string | null) ?? null,
            orgId: (r.org_id as string | null) ?? null,
            dueDate: r.due_at ? day(r.due_at as Date) : null,
            currency: r.cur as string,
            outstandingMinor: String(r.amt),
            bucket: b,
          };
        });
        const total = Object.values(buckets).reduce((s, v) => s + v, 0n);
        const ledgerAr = big(
          (
            await c.query(
              `SELECT coalesce(sum(CASE WHEN p.direction = 'debit' THEN p.amount_minor ELSE -p.amount_minor END), 0)::text n FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE a.code = '1200' AND t.occurred_at < $1::timestamptz`,
              [start(toEx)],
            )
          ).rows[0]!.n,
        );
        return this.base(
          'ar_aging',
          from,
          to,
          now,
          [
            col('invoiceNumber', 'Invoice'),
            col('orgId', 'Organization'),
            col('dueDate', 'Due date'),
            col('currency', 'Currency'),
            col('outstandingMinor', 'Outstanding (minor units)', 'money'),
            col('bucket', 'Bucket'),
          ],
          out,
          {
            asOf: to,
            currentMinor: buckets.current!.toString(),
            days1to30Minor: buckets['1-30']!.toString(),
            days31to60Minor: buckets['31-60']!.toString(),
            days61to90Minor: buckets['61-90']!.toString(),
            over90Minor: buckets['90+']!.toString(),
            unattributedMinor: buckets.unattributed!.toString(),
            totalMinor: total.toString(),
            ledgerReceivableMinor: ledgerAr.toString(),
            matchesLedger: total === ledgerAr && rows.length <= 5000,
          },
          [
            'Outstanding per invoice is the ledger balance of account 1200 for that invoice (issue, payments, credit notes). Unattributed is money moved on receivables without an invoice (refunds): it is shown, never hidden.',
          ],
        );
      }
      case 'vat': {
        const docs = (
          await c.query(
            `SELECT period, rate_bps, sum(net)::text net, sum(tax)::text tax FROM (
               SELECT to_char(i.issued_at AT TIME ZONE 'UTC', 'YYYY-MM') period, l.rate_bps, l.net_minor net, l.tax_minor tax FROM invoicing.invoice_lines l JOIN invoicing.invoices i ON i.id = l.invoice_id
                WHERE i.status <> 'draft' AND i.issued_at >= $1::timestamptz AND i.issued_at < $2::timestamptz
               UNION ALL
               SELECT to_char(n.issued_at AT TIME ZONE 'UTC', 'YYYY-MM'), il.rate_bps, -(e->>'netMinor')::bigint, -(e->>'taxMinor')::bigint FROM invoicing.credit_notes n
                 CROSS JOIN LATERAL jsonb_array_elements(n.lines) e JOIN invoicing.invoice_lines il ON il.id = (e->>'invoiceLineId')::uuid
                WHERE n.status <> 'draft' AND n.issued_at >= $1::timestamptz AND n.issued_at < $2::timestamptz) x GROUP BY 1,2 ORDER BY 1,2`,
            [start(from), start(toEx)],
          )
        ).rows as Row[];
        const net = docs.reduce((s, r) => s + big(r.net), 0n);
        const tax = docs.reduce((s, r) => s + big(r.tax), 0n);
        const ledger = await ledgerNet(c, `('2300')`, 'credit', from, toEx);
        return this.base(
          'vat',
          from,
          to,
          now,
          [
            col('period', 'Period'),
            col('rate', 'Rate (%)'),
            col('taxableMinor', 'Taxable amount (minor units)', 'money'),
            col('taxMinor', 'Output tax (minor units)', 'money'),
          ],
          docs.map((r) => ({
            period: r.period as string,
            rate: `${Math.floor((r.rate_bps as number) / 100)}.${String((r.rate_bps as number) % 100).padStart(2, '0')}`,
            taxableMinor: String(r.net),
            taxMinor: String(r.tax),
          })),
          {
            taxableMinor: net.toString(),
            taxMinor: tax.toString(),
            ledgerVatMinor: ledger.toString(),
            differenceMinor: (tax - ledger).toString(),
            matchesLedger: tax === ledger,
          },
          [
            'Output tax from issued invoices less credit notes, by month and rate; compared with the ledger VAT account (2300).',
            'The rate scope (exemptions, zero rating) is a tax-advisor decision (HG-03-04); unknown cases use the standard rate and are flagged on the invoice.',
          ],
        );
      }
      case 'margin': {
        const rev = (
          await c.query(
            `SELECT ${month} period, p.currency::text cur, sum(${signed})::text amt FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE a.code IN ${REVENUE_ACCOUNTS} AND t.occurred_at >= $1::timestamptz AND t.occurred_at < $2::timestamptz GROUP BY 1,2`,
            [start(from), start(toEx)],
          )
        ).rows as Row[];
        const cost = (
          await c.query(
            `SELECT ${month} period, p.currency::text cur, sum(-(${signed}))::text amt FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE a.code = '5100' AND t.occurred_at >= $1::timestamptz AND t.occurred_at < $2::timestamptz GROUP BY 1,2`,
            [start(from), start(toEx)],
          )
        ).rows as Row[];
        const keys = new Set(
          [...rev, ...cost].map((r) => `${r.period as string}|${r.cur as string}`),
        );
        const rows = [...keys].sort().map((k) => {
          const [period, cur] = k.split('|') as [string, string];
          const r = big(rev.find((x) => x.period === period && x.cur === cur)?.amt);
          const co = big(cost.find((x) => x.period === period && x.cur === cur)?.amt);
          const m = r - co;
          return {
            period,
            currency: cur,
            revenueMinor: r.toString(),
            costMinor: co.toString(),
            marginMinor: m.toString(),
            marginBps: r === 0n ? null : Number((m * 10_000n + (m < 0n ? -r / 2n : r / 2n)) / r),
          };
        });
        const R = rows.reduce((s, r) => s + big(r.revenueMinor), 0n);
        const C = rows.reduce((s, r) => s + big(r.costMinor), 0n);
        return this.base(
          'margin',
          from,
          to,
          now,
          [
            col('period', 'Period'),
            col('currency', 'Currency'),
            col('revenueMinor', 'Revenue (minor units)', 'money'),
            col('costMinor', 'Provider cost (minor units)', 'money'),
            col('marginMinor', 'Gross margin (minor units)', 'money'),
            col('marginBps', 'Margin (basis points)', 'int'),
          ],
          rows,
          { revenueMinor: R.toString(), costMinor: C.toString(), marginMinor: (R - C).toString() },
          ['Revenue (4100-4400) against provider cost accruals (5100), both from the ledger.'],
        );
      }
      case 'refunds': {
        const refunds = (
          await c.query(
            `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') period, count(*)::int n, sum(amount_minor)::text amt FROM payments.refunds WHERE status = 'succeeded' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY 1`,
            [start(from), start(toEx)],
          )
        ).rows as Row[];
        const notes = (
          await c.query(
            `SELECT to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM') period, count(*)::int n, sum(total_minor)::text amt FROM invoicing.credit_notes WHERE status <> 'draft' AND issued_at >= $1::timestamptz AND issued_at < $2::timestamptz GROUP BY 1`,
            [start(from), start(toEx)],
          )
        ).rows as Row[];
        const periods = [...new Set([...refunds, ...notes].map((r) => r.period as string))].sort();
        const rows = periods.map((p) => ({
          period: p,
          refunds: (refunds.find((r) => r.period === p)?.n as number) ?? 0,
          refundsMinor: String(refunds.find((r) => r.period === p)?.amt ?? '0'),
          creditNotes: (notes.find((r) => r.period === p)?.n as number) ?? 0,
          creditNotesMinor: String(notes.find((r) => r.period === p)?.amt ?? '0'),
        }));
        const rf = rows.reduce((s, r) => s + big(r.refundsMinor), 0n);
        const cn = rows.reduce((s, r) => s + big(r.creditNotesMinor), 0n);
        const ledgerRefunds = await ledgerNet(
          c,
          `('1100')`,
          'credit',
          from,
          toEx,
          `AND t.kind = 'refund'`,
        );
        const ledgerNotes = await ledgerNet(
          c,
          `('1200')`,
          'credit',
          from,
          toEx,
          `AND t.kind = 'credit_note'`,
        );
        return this.base(
          'refunds',
          from,
          to,
          now,
          [
            col('period', 'Period'),
            col('refunds', 'Refunds', 'int'),
            col('refundsMinor', 'Refunded (minor units)', 'money'),
            col('creditNotes', 'Credit notes', 'int'),
            col('creditNotesMinor', 'Credited (minor units)', 'money'),
          ],
          rows,
          {
            refundsMinor: rf.toString(),
            creditNotesMinor: cn.toString(),
            ledgerRefundsMinor: ledgerRefunds.toString(),
            ledgerCreditNotesMinor: ledgerNotes.toString(),
            matchesLedger: rf === ledgerRefunds && cn === ledgerNotes,
          },
          [
            'Refunds move money (ledger 1100); credit notes correct invoices (ledger 1200). A refund of a credited invoice appears in both.',
          ],
        );
      }
      case 'dunning': {
        const r = (
          await c.query(
            `SELECT count(*)::int opened,
                    count(*) FILTER (WHERE array_position(ARRAY['overdue','reminder_1','reminder_2','restricted','suspended','terminated_pending'], stage) >= 2)::int reminder_1,
                    count(*) FILTER (WHERE array_position(ARRAY['overdue','reminder_1','reminder_2','restricted','suspended','terminated_pending'], stage) >= 3)::int reminder_2,
                    count(*) FILTER (WHERE array_position(ARRAY['overdue','reminder_1','reminder_2','restricted','suspended','terminated_pending'], stage) >= 4)::int restricted,
                    count(*) FILTER (WHERE array_position(ARRAY['overdue','reminder_1','reminder_2','restricted','suspended','terminated_pending'], stage) >= 5)::int suspended,
                    count(*) FILTER (WHERE stage = 'terminated_pending')::int review,
                    count(*) FILTER (WHERE closed_reason = 'paid')::int recovered,
                    count(*) FILTER (WHERE closed_reason = 'subscription_cancelled')::int cancelled,
                    count(*) FILTER (WHERE closed_at IS NULL)::int still_open
               FROM billing.dunning_cases WHERE opened_at >= $1::timestamptz AND opened_at < $2::timestamptz`,
            [start(from), start(toEx)],
          )
        ).rows[0] as Row;
        const risk = big(
          (
            await c.query(
              `SELECT coalesce(sum(i.total_minor - i.paid_minor), 0)::text n FROM billing.dunning_cases d JOIN invoicing.invoices i ON i.id = d.invoice_id WHERE d.closed_at IS NULL`,
            )
          ).rows[0]!.n,
        );
        const rows = [
          ['opened', r.opened],
          ['reached_reminder_1', r.reminder_1],
          ['reached_reminder_2', r.reminder_2],
          ['reached_restricted', r.restricted],
          ['reached_suspended', r.suspended],
          ['reached_owner_review', r.review],
          ['recovered_by_payment', r.recovered],
          ['closed_cancelled', r.cancelled],
          ['still_open', r.still_open],
        ].map(([stage, n]) => ({ stage: stage as string, cases: n as number }));
        return this.base(
          'dunning',
          from,
          to,
          now,
          [col('stage', 'Funnel step'), col('cases', 'Cases', 'int')],
          rows,
          {
            opened: r.opened as number,
            recovered: r.recovered as number,
            recoveryRateBps:
              (r.opened as number) === 0
                ? null
                : Math.round(((r.recovered as number) * 10_000) / (r.opened as number)),
            openAtRiskMinor: risk.toString(),
          },
          [
            'Cases opened in the period and how far they got; the amount at risk is what is still unpaid on invoices of cases that are open now.',
          ],
        );
      }
      case 'wallet': {
        const closing = await ledgerNet(c, `('2100')`, 'credit', '0001-01-01', toEx);
        const opening = await ledgerNet(c, `('2100')`, 'credit', '0001-01-01', from);
        const flows = (
          await c.query(
            `SELECT t.kind, sum(${signed})::text amt FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id JOIN billing.ledger_transactions t ON t.id = p.transaction_id WHERE a.code = '2100' AND t.occurred_at >= $1::timestamptz AND t.occurred_at < $2::timestamptz GROUP BY 1 ORDER BY 1`,
            [start(from), start(toEx)],
          )
        ).rows as Row[];
        const net = flows.reduce((s, r) => s + big(r.amt), 0n);
        return this.base(
          'wallet',
          from,
          to,
          now,
          [col('flow', 'Flow'), col('netMinor', 'Net change (minor units)', 'money')],
          flows.map((r) => ({ flow: r.kind as string, netMinor: String(r.amt) })),
          {
            openingMinor: opening.toString(),
            flowsMinor: net.toString(),
            closingMinor: closing.toString(),
            reconciles: opening + net === closing,
          },
          [
            'Prepaid wallet liability (ledger account 2100) at the start and end of the period and the flows between, by ledger entry kind.',
          ],
        );
      }
    }
  }
}

/** CSV with RFC 4180 quoting. Text cells that could be read as a spreadsheet formula are prefixed with an apostrophe (CSV injection); money and integers are not. */
export function toCsv(r: Report): string {
  const esc = (v: unknown, kind: Column['kind']): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (kind === 'text' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [r.columns.map((c) => esc(c.label, 'money')).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => esc(row[c.key], c.kind)).join(','));
  return lines.join('\r\n') + '\r\n';
}
