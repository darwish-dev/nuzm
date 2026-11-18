import { createHash } from 'node:crypto';
import type { ProviderCostRecord } from '@nuzm/adapter-contracts';

/**
 * Provider cost capture helpers (M05 S23 task 22). Pure functions: adapters' `fetchBilling` records → rows for
 * `metering.record_provider_cost(jsonb)` and → RC-04 bill lines (`Sources.bills`), plus the manual import path for providers without a billing API
 * (Contabo). Money is integer minor units in the PROVIDER's currency; the SAR conversion rate is recorded in `evidenceRef` because
 * `metering.provider_cost_records` has no FX column (open item SI-M05-8: owner PR to M02 if a column is wanted).
 */
export interface CostRow {
  providerAccountId: string;
  resourceId: string | null;
  orgId: string | null;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD, inclusive
  meterOrSku: string;
  quantity: string;
  costMinor: string;
  currency: string;
  source: 'api' | 'bill_import';
  providerLineRef: string;
  evidenceRef: string | null;
  capturedBy: string | null;
}
export interface BillLine {
  providerAccountId: string;
  lineRef: string;
  periodStart: string;
  amountMinor: string;
  currency: string;
}
export interface Attribution {
  resourceId: string;
  orgId: string;
}
export interface Fx {
  currency: string;
  /** Decimal string, SAR per 1 unit of `currency`. */
  rateToSar: string;
  date: string;
}

const day = (iso: string): string => iso.slice(0, 10);
const dayBefore = (iso: string): string =>
  new Date(Date.parse(iso) - 86_400_000).toISOString().slice(0, 10);

/** Stable per line: the same bill fetched twice yields the same references (idempotent capture); identical lines are told apart by occurrence. */
export function lineRefs(accountId: string, records: readonly ProviderCostRecord[]): string[] {
  const seen = new Map<string, number>();
  return records.map((r) => {
    const base = [
      accountId,
      r.providerRef ?? '',
      r.periodStart,
      r.periodEnd,
      r.amountMinor,
      r.currency,
      r.description,
    ].join('|');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `pc-${createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 40)}`;
  });
}

export function toCostRows(o: {
  providerAccountId: string;
  records: readonly ProviderCostRecord[];
  /** provider reference (instance id) → our resource and org; unknown ⇒ unattributed (RC-04 surfaces it as `unattributed_cost`) */
  attribute?: (providerRef: string) => Attribution | null;
  capturedBy?: string | null;
  source: 'api' | 'bill_import';
  evidenceRef?: string | null;
  fx?: Fx;
}): CostRow[] {
  const refs = lineRefs(o.providerAccountId, o.records);
  const fxNote = o.fx ? `fx:${o.fx.currency}/SAR=${o.fx.rateToSar}@${o.fx.date}` : null;
  const evidence =
    [o.evidenceRef ?? null, fxNote].filter((x): x is string => !!x).join(';') || null;
  return o.records.map((r, i) => {
    if (!/^\d+$/.test(r.amountMinor))
      throw new RangeError(`amountMinor must be an integer string, got ${r.amountMinor}`);
    const who = r.providerRef ? (o.attribute?.(r.providerRef) ?? null) : null;
    return {
      providerAccountId: o.providerAccountId,
      resourceId: who?.resourceId ?? null,
      orgId: who?.orgId ?? null,
      periodStart: day(r.periodStart),
      periodEnd:
        dayBefore(r.periodEnd) < day(r.periodStart) ? day(r.periodStart) : dayBefore(r.periodEnd),
      meterOrSku: r.description.slice(0, 200) || 'compute',
      quantity: '1',
      costMinor: r.amountMinor,
      currency: r.currency,
      source: o.source,
      providerLineRef: refs[i]!,
      evidenceRef: evidence,
      capturedBy: o.capturedBy ?? null,
    };
  });
}

export const toBillLines = (
  providerAccountId: string,
  records: readonly ProviderCostRecord[],
): BillLine[] => {
  const refs = lineRefs(providerAccountId, records);
  return records.map((r, i) => ({
    providerAccountId,
    lineRef: refs[i]!,
    periodStart: day(r.periodStart),
    amountMinor: r.amountMinor,
    currency: r.currency,
  }));
};

/**
 * Only CLOSED billing periods are captured: current-month data is "for reference only" and changes (Alibaba/Huawei docs), so capturing it would
 * create a second, different line for the same charge. Returns the window clipped to whole months before the month of `now`, or null.
 */
export function closedWindow(
  period: { from: string; to: string },
  now: Date,
): { from: string; to: string } | null {
  const firstOfThisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const to = Math.min(Date.parse(period.to), firstOfThisMonth - 1);
  const from = Date.parse(period.from);
  if (!(to > from)) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

const DEC = /^(\d{1,12})(?:\.(\d{1,2}))?$/;
export class CostImportError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'CostImportError';
  }
}
/**
 * Manual bill import (Contabo has no billing API). CSV with the header `period,reference,description,amount,currency`; `period` = YYYY-MM;
 * `amount` a non-negative decimal with at most 2 decimals (no exponent, no thousands separators) → integer minor units; `currency` ISO 4217.
 * Anything else is rejected with the offending line: an import never guesses. Rows are flagged `bill_import` by the caller.
 */
export function parseManualCosts(csv: string): ProviderCostRecord[] {
  const lines = csv
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (lines[0]?.trim() !== 'period,reference,description,amount,currency')
    throw new CostImportError(
      1,
      'header must be exactly: period,reference,description,amount,currency',
    );
  return lines.slice(1).map((l, i) => {
    const n = i + 2;
    const cols = l.split(',');
    if (cols.length !== 5)
      throw new CostImportError(n, 'expected 5 columns (commas inside fields are not supported)');
    const [period, ref, description, amount, currency] = cols.map((c) => c.trim()) as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
      throw new CostImportError(n, `period must be YYYY-MM, got "${period}"`);
    const m = DEC.exec(amount);
    if (!m)
      throw new CostImportError(
        n,
        `amount must be a decimal with at most 2 decimals, got "${amount}"`,
      );
    if (!/^[A-Z]{3}$/.test(currency))
      throw new CostImportError(n, `currency must be ISO 4217, got "${currency}"`);
    const [y, mo] = period.split('-').map(Number) as [number, number];
    return {
      providerRef: ref || null,
      periodStart: new Date(Date.UTC(y, mo - 1, 1)).toISOString(),
      periodEnd: new Date(Date.UTC(y, mo, 1)).toISOString(),
      amountMinor: (BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0')).toString(),
      currency,
      description: description || 'manual bill import',
    };
  });
}
