import type { PoolClient } from 'pg';
import { verifyChain, type ZatcaProfile } from '../../invoicing';

/**
 * The six financial reconcilers (docs/11 §9). Each one compares two independent sources for a period and returns BREAKS; none of them writes
 * anything but its own result (the run and its items). Reading is done through the platform scope (finance sees all organizations).
 *  RC-01 payments vs PSP settlement report      RC-02 ledger vs invoices and credit notes     RC-03 rated usage vs invoice lines
 *  RC-04 provider cost records vs ledger (and bills, when a bill source exists)               RC-05 e-invoices vs issued documents
 *  RC-06 wallet projection vs ledger 2100 (and credited top-ups vs ledger)
 * Amounts are integer minor units; a tolerance of 0 means exact. Money is compared as bigint, never as float.
 */
export type ReconType = 'RC-01' | 'RC-02' | 'RC-03' | 'RC-04' | 'RC-05' | 'RC-06';
export const RECON_TYPES: ReconType[] = ['RC-01', 'RC-02', 'RC-03', 'RC-04', 'RC-05', 'RC-06'];

export interface Break {
  key: string;
  kind: string;
  orgId?: string | null;
  details: Record<string, unknown>;
}
export interface Detection {
  checked: number;
  breaks: Break[];
  /** Why nothing was compared (no source available), or facts about the comparison. */
  summary: Record<string, unknown>;
}
export interface Settlement {
  ref: string;
  kind: 'charge' | 'refund';
  amountMinor: string;
  currency: string;
  settledAt: Date;
}
export interface BillLine {
  providerAccountId: string;
  lineRef: string;
  periodStart: string;
  amountMinor: string;
  currency: string;
}
export interface Sources {
  /** PSP settlement report lines for [from, to), or null when no adapter has a report. */
  settlements(from: Date, to: Date): Promise<Settlement[] | null>;
  /** Provider bills for the period (M05 adapters' `fetchBilling`); null until they exist. */
  bills(from: string, to: string): Promise<BillLine[] | null>;
}
export interface Ctx {
  c: PoolClient;
  /** Inclusive dates `YYYY-MM-DD`. */
  from: string;
  to: string;
  /** Exclusive upper bound as a date (`to` + 1 day). */
  toExclusive: string;
  tolerance: { rc03Bps: number; rc04Bps: number };
  sources: Sources;
  zatca: {
    mode: 'off' | 'sandbox' | 'simulation';
    generateFrom: Date | null;
    profile: ZatcaProfile;
  };
}
export type Reconciler = (x: Ctx) => Promise<Detection>;

const big = (v: unknown) => BigInt(String(v ?? '0'));
const overTolerance = (diff: bigint, base: bigint, bps: number) => {
  const d = diff < 0n ? -diff : diff;
  return bps === 0 ? d !== 0n : d * 10_000n > base * BigInt(bps);
};
const CAP = 5000;
const cap = (b: Break[], summary: Record<string, unknown>): Break[] => {
  if (b.length <= CAP) return b;
  summary.truncated = { shown: CAP, found: b.length };
  return b.slice(0, CAP);
};

/** RC-01 — what the platform recorded as captured/refunded vs what the PSP says it settled. */
export const rc01: Reconciler = async ({ c, from, toExclusive, sources }) => {
  const summary: Record<string, unknown> = {};
  const lines = await sources.settlements(
    new Date(`${from}T00:00:00Z`),
    new Date(`${toExclusive}T00:00:00Z`),
  );
  if (!lines)
    return {
      checked: 0,
      breaks: [],
      summary: { skipped: true, reason: 'no PSP adapter provides a settlement report' },
    };
  const byRef = new Map(lines.map((l) => [l.ref, l]));
  const used = new Set<string>();
  const breaks: Break[] = [];
  const intents = (
    await c.query(
      `SELECT id, org_id, merchant_reference, psp_payment_ref, captured_minor::text cap, currency FROM payments.payment_intents
        WHERE status IN ('succeeded','partially_refunded','refunded') AND created_at >= $1::date AND created_at < $2::date ORDER BY created_at`,
      [from, toExclusive],
    )
  ).rows;
  for (const i of intents) {
    const l = i.psp_payment_ref ? byRef.get(i.psp_payment_ref as string) : undefined;
    if (!l)
      breaks.push({
        key: `charge:${i.psp_payment_ref ?? i.merchant_reference}`,
        kind: 'missing_settlement',
        orgId: i.org_id,
        details: { paymentId: i.id, expectedMinor: i.cap },
      });
    else {
      used.add(l.ref);
      if (l.kind !== 'charge' || big(l.amountMinor) !== big(i.cap))
        breaks.push({
          key: `charge:${l.ref}`,
          kind: 'amount_mismatch',
          orgId: i.org_id,
          details: { paymentId: i.id, expectedMinor: i.cap, settledMinor: l.amountMinor },
        });
    }
  }
  const refunds = (
    await c.query(
      `SELECT r.id, r.org_id, r.intent_id, r.psp_refund_ref, r.amount_minor::text amt FROM payments.refunds r WHERE r.status = 'succeeded' AND r.created_at >= $1::date AND r.created_at < $2::date ORDER BY r.created_at`,
      [from, toExclusive],
    )
  ).rows;
  for (const r of refunds) {
    const l = r.psp_refund_ref ? byRef.get(r.psp_refund_ref as string) : undefined;
    if (!l)
      breaks.push({
        key: `refund:${r.psp_refund_ref ?? r.id}`,
        kind: 'refund_missing_settlement',
        orgId: r.org_id,
        details: { refundId: r.id, expectedMinor: r.amt },
      });
    else {
      used.add(l.ref);
      if (l.kind !== 'refund' || big(l.amountMinor) !== big(r.amt))
        breaks.push({
          key: `refund:${l.ref}`,
          kind: 'refund_amount_mismatch',
          orgId: r.org_id,
          details: { refundId: r.id, expectedMinor: r.amt, settledMinor: l.amountMinor },
        });
    }
  }
  // a settled line the platform knows nothing about (a charge made outside, or a lost record)
  const known = new Set(
    (
      await c.query(
        `SELECT psp_payment_ref ref FROM payments.payment_intents WHERE psp_payment_ref IS NOT NULL UNION SELECT psp_refund_ref FROM payments.refunds WHERE psp_refund_ref IS NOT NULL`,
      )
    ).rows.map((r) => r.ref as string),
  );
  for (const l of lines)
    if (!used.has(l.ref) && !known.has(l.ref))
      breaks.push({
        key: `${l.kind}:${l.ref}`,
        kind: 'unknown_psp_line',
        details: { amountMinor: l.amountMinor, kind: l.kind },
      });
  summary.settlementLines = lines.length;
  return { checked: intents.length + refunds.length, breaks: cap(breaks, summary), summary };
};

const docSums = `
  coalesce(sum(p.amount_minor) FILTER (WHERE a.code = '1200' AND p.direction = $3), 0)::text ar,
  coalesce(sum(p.amount_minor) FILTER (WHERE a.code = '2300' AND p.direction = $4), 0)::text vat,
  coalesce(sum(p.amount_minor) FILTER (WHERE a.code LIKE '4%' AND p.direction = $4), 0)::text rev`;

/** RC-02 — every issued invoice and credit note has exactly the ledger entry its numbers call for, and every such entry has a document. */
export const rc02: Reconciler = async ({ c, from, toExclusive }) => {
  const breaks: Break[] = [];
  const summary: Record<string, unknown> = {};
  let checked = 0;
  for (const kind of ['invoice', 'credit_note'] as const) {
    const [table, txKind, arDir, otherDir] =
      kind === 'invoice'
        ? ['invoicing.invoices', 'invoice_issued', 'debit', 'credit']
        : ['invoicing.credit_notes', 'credit_note', 'credit', 'debit'];
    const rows = (
      await c.query(
        `SELECT d.id, d.org_id, d.number_text, d.total_minor::text total, d.tax_minor::text tax, d.net_total::text net, t.id AS tx_id, ${docSums}
           FROM (SELECT id, org_id, number_text, total_minor, tax_minor, ${kind === 'invoice' ? 'subtotal_minor' : 'net_minor'} AS net_total FROM ${table}
                  WHERE ${kind === 'invoice' ? "status <> 'draft' AND" : "status <> 'draft' AND"} issued_at >= $1 AND issued_at < $2) d
           LEFT JOIN billing.ledger_transactions t ON t.source_event_id = d.id::text AND t.kind = '${txKind}'
           LEFT JOIN billing.ledger_postings p ON p.transaction_id = t.id
           LEFT JOIN billing.ledger_accounts a ON a.id = p.account_id
          GROUP BY d.id, d.org_id, d.number_text, d.total_minor, d.tax_minor, d.net_total, t.id ORDER BY d.number_text`,
        [from, toExclusive, arDir, otherDir],
      )
    ).rows;
    for (const r of rows) {
      checked++;
      const key = `${kind}:${r.id}`;
      if (!r.tx_id) {
        breaks.push({
          key,
          kind: `${kind}_without_posting`,
          orgId: r.org_id,
          details: { number: r.number_text, totalMinor: r.total },
        });
        continue;
      }
      if (big(r.ar) !== big(r.total))
        breaks.push({
          key,
          kind: 'receivable_mismatch',
          orgId: r.org_id,
          details: { number: r.number_text, documentMinor: r.total, ledgerMinor: r.ar },
        });
      if (big(r.vat) !== big(r.tax))
        breaks.push({
          key,
          kind: 'vat_mismatch',
          orgId: r.org_id,
          details: { number: r.number_text, documentMinor: r.tax, ledgerMinor: r.vat },
        });
      if (big(r.rev) !== big(r.net))
        breaks.push({
          key,
          kind: 'revenue_mismatch',
          orgId: r.org_id,
          details: { number: r.number_text, documentMinor: r.net, ledgerMinor: r.rev },
        });
    }
  }
  const orphans = (
    await c.query(
      `SELECT t.id, t.kind, t.org_id, t.source_event_id FROM billing.ledger_transactions t
        WHERE t.kind IN ('invoice_issued','credit_note') AND t.occurred_at >= $1 AND t.occurred_at < $2
          AND NOT EXISTS (SELECT 1 FROM invoicing.invoices i WHERE i.id::text = t.source_event_id)
          AND NOT EXISTS (SELECT 1 FROM invoicing.credit_notes n WHERE n.id::text = t.source_event_id)`,
      [from, toExclusive],
    )
  ).rows;
  for (const o of orphans)
    breaks.push({
      key: `posting:${o.id}`,
      kind: 'posting_without_document',
      orgId: o.org_id,
      details: { transactionKind: o.kind, sourceEventId: o.source_event_id },
    });
  return { checked: checked + orphans.length, breaks: cap(breaks, summary), summary };
};

/** RC-03 — usage that was rated vs what the invoices billed, per organization, period and meter (tolerance in basis points, finance-set). */
export const rc03: Reconciler = async ({ c, from, to, tolerance }) => {
  const breaks: Break[] = [];
  const summary: Record<string, unknown> = { toleranceBps: tolerance.rc03Bps };
  const rated = (
    await c.query(
      `WITH latest AS (SELECT DISTINCT ON (org_id, period_start) org_id, period_start, rating_run_id FROM metering.rated_usage WHERE period_start BETWEEN $1::date AND $2::date ORDER BY org_id, period_start, created_at DESC, id DESC)
       SELECT r.org_id, r.period_start::text period, r.meter_id, sum(r.amount_minor)::text amt FROM metering.rated_usage r
         JOIN latest l ON l.org_id = r.org_id AND l.period_start = r.period_start AND l.rating_run_id = r.rating_run_id GROUP BY 1,2,3`,
      [from, to],
    )
  ).rows;
  const billed = (
    await c.query(
      `SELECT l.org_id, substring(l.source_id from 'usage:([0-9-]+):') period, substring(l.source_id from 'usage:[0-9-]+:(.*)$') meter_id, sum(l.net_minor)::text amt
         FROM invoicing.invoice_lines l JOIN invoicing.invoices i ON i.id = l.invoice_id
        WHERE l.kind = 'usage' AND i.status <> 'draft' AND substring(l.source_id from 'usage:([0-9-]+):') BETWEEN $1 AND $2 GROUP BY 1,2,3`,
      [from, to],
    )
  ).rows;
  const invoiced = new Set(
    (
      await c.query(
        `SELECT DISTINCT org_id::text || '|' || substring(source_key from 'period:([0-9]{4}-[0-9]{2})') k FROM invoicing.invoices WHERE source_key LIKE 'period:%'`,
      )
    ).rows.map((r) => r.k as string),
  );
  const bKey = (r: { org_id: string; period: string; meter_id: string }) =>
    `${r.org_id}|${r.period}|${r.meter_id}`;
  const bMap = new Map(billed.map((b) => [bKey(b), b]));
  const seen = new Set<string>();
  let checked = 0;
  for (const r of rated) {
    if (big(r.amt) === 0n) continue; // zero-priced usage stays off the invoice by design
    checked++;
    const k = bKey(r);
    seen.add(k);
    const b = bMap.get(k);
    const key = `usage:${r.org_id}:${r.period}:${r.meter_id}`;
    if (!b) {
      breaks.push({
        key,
        kind: invoiced.has(`${r.org_id}|${(r.period as string).slice(0, 7)}`)
          ? 'missing_invoice_line'
          : 'unbilled_usage',
        orgId: r.org_id,
        details: { period: r.period, meterId: r.meter_id, ratedMinor: r.amt },
      });
      continue;
    }
    const diff = big(b.amt) - big(r.amt);
    if (overTolerance(diff, big(r.amt), tolerance.rc03Bps))
      breaks.push({
        key,
        kind: diff > 0n ? 'over_billed' : 'under_billed',
        orgId: r.org_id,
        details: {
          period: r.period,
          meterId: r.meter_id,
          ratedMinor: r.amt,
          billedMinor: b.amt,
          differenceMinor: diff.toString(),
        },
      });
  }
  for (const b of billed)
    if (!seen.has(bKey(b))) {
      checked++;
      breaks.push({
        key: `usage:${b.org_id}:${b.period}:${b.meter_id}`,
        kind: 'line_without_usage',
        orgId: b.org_id,
        details: { period: b.period, meterId: b.meter_id, billedMinor: b.amt },
      });
    }
  return { checked, breaks: cap(breaks, summary), summary };
};

/** RC-04 — provider cost records vs the ledger accrual (always), negative margin, and vs provider bills when a bill source exists (M05). */
export const rc04: Reconciler = async ({ c, from, to, toExclusive, tolerance, sources }) => {
  const breaks: Break[] = [];
  const summary: Record<string, unknown> = { toleranceBps: tolerance.rc04Bps };
  const costs = (
    await c.query(
      `SELECT k.id, k.provider_account_id, k.provider_line_ref, k.org_id, k.cost_minor::text cost,
              (SELECT coalesce(sum(p.amount_minor), 0)::text FROM billing.ledger_transactions t JOIN billing.ledger_postings p ON p.transaction_id = t.id JOIN billing.ledger_accounts a ON a.id = p.account_id
                WHERE t.idempotency_key = 'cost:' || k.provider_account_id || ':' || k.provider_line_ref AND a.code = '5100' AND p.direction = 'debit') AS accrued,
              EXISTS (SELECT 1 FROM billing.ledger_transactions t WHERE t.idempotency_key = 'cost:' || k.provider_account_id || ':' || k.provider_line_ref) AS has_tx
         FROM metering.provider_cost_records k WHERE k.period_start BETWEEN $1::date AND $2::date ORDER BY k.captured_at`,
      [from, to],
    )
  ).rows;
  for (const k of costs) {
    const key = `cost:${k.provider_account_id}:${k.provider_line_ref}`;
    if (k.org_id === null)
      breaks.push({
        key,
        kind: 'unattributed_cost',
        details: { providerAccountId: k.provider_account_id, costMinor: k.cost },
      });
    if (!k.has_tx)
      breaks.push({
        key,
        kind: 'cost_without_accrual',
        orgId: k.org_id,
        details: { costMinor: k.cost },
      });
    else if (big(k.accrued) !== big(k.cost))
      breaks.push({
        key,
        kind: 'accrual_mismatch',
        orgId: k.org_id,
        details: { costMinor: k.cost, ledgerMinor: k.accrued },
      });
  }
  const margin = (
    await c.query(
      `SELECT org_id, period_start::text period, revenue_minor::text revenue, cost_minor::text cost FROM metering.v_margin WHERE period_start BETWEEN $1::date AND $2::date AND cost_minor > revenue_minor AND org_id IS NOT NULL`,
      [from, to],
    )
  ).rows;
  for (const m of margin)
    breaks.push({
      key: `margin:${m.org_id}:${m.period}`,
      kind: 'negative_margin',
      orgId: m.org_id,
      details: { period: m.period, revenueMinor: m.revenue, costMinor: m.cost },
    });
  let checked = costs.length + margin.length;
  const bills = await sources.bills(from, to);
  if (!bills)
    summary.bills = {
      skipped: true,
      reason: 'no provider bill source yet (M05): bills are NOT compared; NOT VERIFIED live',
    };
  else {
    const byKey = new Map(costs.map((k) => [`${k.provider_account_id}|${k.provider_line_ref}`, k]));
    const seen = new Set<string>();
    for (const b of bills) {
      checked++;
      const k = byKey.get(`${b.providerAccountId}|${b.lineRef}`);
      seen.add(`${b.providerAccountId}|${b.lineRef}`);
      const key = `bill:${b.providerAccountId}:${b.lineRef}`;
      if (!k)
        breaks.push({
          key,
          kind: 'bill_line_without_cost',
          details: { amountMinor: b.amountMinor },
        });
      else if (
        overTolerance(big(k.cost) - big(b.amountMinor), big(b.amountMinor), tolerance.rc04Bps)
      )
        breaks.push({
          key,
          kind: 'bill_amount_mismatch',
          orgId: k.org_id,
          details: { billMinor: b.amountMinor, costMinor: k.cost },
        });
    }
    for (const [k, v] of byKey)
      if (!seen.has(k))
        breaks.push({
          key: `cost:${k.replace('|', ':')}`,
          kind: 'cost_without_bill_line',
          orgId: v.org_id,
          details: { costMinor: v.cost },
        });
    summary.bills = { lines: bills.length };
  }
  void toExclusive;
  return { checked, breaks: cap(breaks, summary), summary };
};

/** RC-05 — every issued invoice and credit note (from the cutover date) has an e-invoice that reached cleared/reported; the counter has no gap. */
export const rc05: Reconciler = async ({ c, from, toExclusive, zatca }) => {
  const summary: Record<string, unknown> = { notVerifiedVsZatca: zatca.profile.synthetic };
  if (zatca.mode === 'off')
    return {
      checked: 0,
      breaks: [],
      summary: { ...summary, skipped: true, reason: 'e-invoicing is off (ZATCA_MODE=off)' },
    };
  if (!zatca.generateFrom)
    return {
      checked: 0,
      breaks: [],
      summary: {
        ...summary,
        skipped: true,
        reason: 'no cutover date (ZATCA_GENERATE_FROM): nothing is expected to have an e-invoice',
      },
    };
  const breaks: Break[] = [];
  const rows = (
    await c.query(
      `SELECT s.source_type, s.id, s.org_id, s.number_text, s.issued_at, d.id AS doc_id, d.stamped_at,
              (SELECT x.state FROM invoicing.zatca_submissions x WHERE x.document_id = d.id ORDER BY x.seq DESC LIMIT 1) AS state,
              (SELECT x.dead_letter FROM invoicing.zatca_submissions x WHERE x.document_id = d.id ORDER BY x.seq DESC LIMIT 1) AS dead
         FROM (SELECT 'invoice'::text source_type, id, org_id, number_text, issued_at FROM invoicing.invoices WHERE status <> 'draft'
               UNION ALL SELECT 'credit_note', id, org_id, number_text, issued_at FROM invoicing.credit_notes WHERE status <> 'draft') s
         LEFT JOIN invoicing.zatca_documents d ON d.source_type = s.source_type AND d.source_id = s.id AND d.environment = $3
        WHERE s.issued_at >= $1 AND s.issued_at < $2 AND s.issued_at >= $4 ORDER BY s.issued_at`,
      [from, toExclusive, zatca.mode, zatca.generateFrom],
    )
  ).rows;
  for (const r of rows) {
    const key = `${r.source_type}:${r.id}`;
    const base = { number: r.number_text, state: r.state ?? null };
    if (!r.doc_id) breaks.push({ key, kind: 'no_einvoice', orgId: r.org_id, details: base });
    else if (r.state === 'rejected')
      breaks.push({ key, kind: 'rejected', orgId: r.org_id, details: base });
    else if (r.state === 'error' && r.dead)
      breaks.push({ key, kind: 'dead_letter', orgId: r.org_id, details: base });
    else if (!['cleared', 'reported'].includes(r.state as string)) {
      const age = r.stamped_at
        ? Date.now() - (r.stamped_at as Date).getTime()
        : Date.now() - (r.issued_at as Date).getTime();
      if (age > zatca.profile.reportingWindowHours * 3_600_000)
        breaks.push({ key, kind: 'not_cleared_in_window', orgId: r.org_id, details: base });
    }
  }
  const entities = (
    await c.query(
      `SELECT DISTINCT entity_id FROM invoicing.zatca_documents WHERE environment = $1`,
      [zatca.mode],
    )
  ).rows;
  for (const e of entities) {
    const chain = (
      await c.query(`SELECT icv::text, pih, invoice_hash FROM invoicing.zatca_chain($1, $2)`, [
        e.entity_id,
        zatca.mode,
      ])
    ).rows;
    for (const p of verifyChain(
      chain.map((r) => ({ icv: BigInt(r.icv), pih: r.pih, invoiceHash: r.invoice_hash })),
      zatca.profile,
    ))
      breaks.push({
        key: `chain:${e.entity_id}:${p.icv ?? 'start'}:${p.problem}`,
        kind: 'counter_gap',
        details: { problem: p.problem, detail: p.detail },
      });
  }
  return { checked: rows.length + entities.length, breaks: cap(breaks, summary), summary };
};

/** RC-06 — the wallet projection vs the sum of ledger 2100 postings per organization and currency; credited top-ups vs their ledger entries. */
export const rc06: Reconciler = async ({ c, from, toExclusive }) => {
  const breaks: Break[] = [];
  const summary: Record<string, unknown> = {};
  const ledger = (
    await c.query(`SELECT a.org_id, a.currency::text cur, sum(CASE WHEN p.direction = 'credit' THEN p.amount_minor ELSE -p.amount_minor END)::text bal
                     FROM billing.ledger_postings p JOIN billing.ledger_accounts a ON a.id = p.account_id WHERE a.code = '2100' AND a.org_id IS NOT NULL GROUP BY 1,2`)
  ).rows;
  const proj = (
    await c.query(
      `SELECT org_id, currency::text cur, balance_minor::text bal FROM billing.wallet_balances`,
    )
  ).rows;
  const pMap = new Map(proj.map((p) => [`${p.org_id}|${p.cur}`, p]));
  const seen = new Set<string>();
  for (const l of ledger) {
    const k = `${l.org_id}|${l.cur}`;
    seen.add(k);
    const p = pMap.get(k);
    if (!p)
      breaks.push({
        key: `wallet:${l.org_id}:${l.cur}`,
        kind: 'projection_missing',
        orgId: l.org_id,
        details: { ledgerMinor: l.bal },
      });
    else if (big(p.bal) !== big(l.bal))
      breaks.push({
        key: `wallet:${l.org_id}:${l.cur}`,
        kind: 'projection_drift',
        orgId: l.org_id,
        details: {
          projectionMinor: p.bal,
          ledgerMinor: l.bal,
          differenceMinor: (big(p.bal) - big(l.bal)).toString(),
        },
      });
  }
  for (const p of proj)
    if (!seen.has(`${p.org_id}|${p.cur}`) && big(p.bal) !== 0n)
      breaks.push({
        key: `wallet:${p.org_id}:${p.cur}`,
        kind: 'projection_orphan',
        orgId: p.org_id,
        details: { projectionMinor: p.bal },
      });
  const topups = (
    await c.query(
      `SELECT w.org_id, sum(w.amount_minor)::text credited,
              (SELECT coalesce(sum(p.amount_minor), 0)::text FROM billing.ledger_transactions t JOIN billing.ledger_postings p ON p.transaction_id = t.id JOIN billing.ledger_accounts a ON a.id = p.account_id
                WHERE t.org_id = w.org_id AND t.kind = 'wallet_topup' AND a.code = '2100' AND p.direction = 'credit' AND t.occurred_at >= $1 AND t.occurred_at < $2) AS posted
         FROM billing.wallet_topups w WHERE w.status = 'credited' AND w.credited_at >= $1 AND w.credited_at < $2 GROUP BY w.org_id`,
      [from, toExclusive],
    )
  ).rows;
  for (const t of topups)
    if (big(t.credited) !== big(t.posted))
      breaks.push({
        key: `topups:${t.org_id}`,
        kind: 'topup_mismatch',
        orgId: t.org_id,
        details: { creditedMinor: t.credited, ledgerMinor: t.posted },
      });
  summary.note =
    'run when the outbox is drained: a projection refresh in flight shows as a transient drift';
  return {
    checked: ledger.length + proj.length + topups.length,
    breaks: cap(breaks, summary),
    summary,
  };
};

export const RECONCILERS: Record<ReconType, Reconciler> = {
  'RC-01': rc01,
  'RC-02': rc02,
  'RC-03': rc03,
  'RC-04': rc04,
  'RC-05': rc05,
  'RC-06': rc06,
};
