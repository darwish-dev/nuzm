/** Pure helpers of the admin finance screens (UI-M03-15..21). No I/O: unit-tested in `finance.spec.ts`. */

export const RC_TYPES = ['RC-01', 'RC-02', 'RC-03', 'RC-04', 'RC-05', 'RC-06'] as const;
export type RcType = (typeof RC_TYPES)[number];

export const ZATCA_STEPS = [
  'csr',
  'compliance_csid',
  'compliance_checks',
  'production_csid',
] as const;
export type ZatcaStep = (typeof ZATCA_STEPS)[number];

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

export const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());

/** A real calendar date `YYYY-MM-DD` (2026-02-30 is not one). */
export function isDateOnly(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

/** `from <= to`, both real dates, at most 400 days apart (the API's limit). */
export function validRange(from: string, to: string): boolean {
  if (!isDateOnly(from) || !isDateOnly(to) || from > to) return false;
  return (Date.parse(to) - Date.parse(from)) / 86_400_000 <= 400;
}

/**
 * Major-unit text → integer minor units, by string arithmetic only (no floating point touches money). Positive, at most two decimals.
 * "115" → "11500", "1.5" → "150", "0" and "1.234" → null.
 */
export function toMinor(input: string, digits = 2): string | null {
  const m = new RegExp(`^(\\d{1,16})(?:\\.(\\d{1,${digits}}))?$`).exec(input.trim());
  if (!m) return null;
  const minor = `${m[1]}${(m[2] ?? '').padEnd(digits, '0')}`.replace(/^0+(?=\d)/, '');
  return /^[1-9]\d*$/.test(minor) ? minor : null;
}

/** The step that may be requested next: the one after the last completed step; null when all are done. */
export function nextZatcaStep(state: string): ZatcaStep | null {
  const i = state === 'not_started' ? -1 : ZATCA_STEPS.indexOf(state as ZatcaStep);
  if (i < -1 || (i === -1 && state !== 'not_started')) return null;
  return ZATCA_STEPS[i + 1] ?? null;
}

type Tone = 'success' | 'danger' | 'warn' | undefined;
export function submissionTone(state: string, deadLetter: boolean): Tone {
  if (deadLetter || state === 'rejected' || state === 'error') return 'danger';
  if (state === 'cleared' || state === 'reported') return 'success';
  return 'warn';
}
export function runTone(status: string): Tone {
  return status === 'completed' ? 'success' : status === 'failed' ? 'danger' : 'warn';
}
export function itemTone(status: string, overSla: boolean): Tone {
  if (status === 'resolved') return 'success';
  return overSla ? 'danger' : 'warn';
}
export function stepTone(status: string): Tone {
  return status === 'completed'
    ? 'success'
    : status === 'failed' || status === 'rejected'
      ? 'danger'
      : 'warn';
}

export interface WindowRow {
  windowRemainingSeconds: number | null;
  windowAlert: boolean;
  windowBreached: boolean;
}
/**
 * The reporting-window gauge (UI-M03-19): of the open simplified invoices that have a clock, how many are still in the first half
 * of their window. The API gives remaining time and the 50 % / 100 % flags, not the window length, so the gauge is a share, not
 * a countdown.
 */
export function windowSummary(rows: WindowRow[]) {
  const clocked = rows.filter((r) => r.windowRemainingSeconds !== null);
  const breached = clocked.filter((r) => r.windowBreached).length;
  const alert = clocked.filter((r) => r.windowAlert && !r.windowBreached).length;
  const ok = clocked.length - breached - alert;
  return {
    total: clocked.length,
    ok,
    alert,
    breached,
    percentOk: clocked.length === 0 ? 100 : (ok / clocked.length) * 100,
  };
}

export function splitRemaining(seconds: number): { hours: number; minutes: number } {
  const s = Math.max(0, Math.floor(seconds));
  return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60) };
}

export type Cell =
  | { kind: 'money'; minor: string }
  | { kind: 'bps'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'text'; value: string };

/** How one report value is displayed, decided by its name and the column kind; money stays a string until `formatMinor`. */
export function reportCell(key: string, kind: string | undefined, value: unknown): Cell {
  if (typeof value === 'boolean') return { kind: 'bool', value };
  const text = value === null || value === undefined ? '—' : String(value);
  if (/^-?\d+$/.test(text) && (kind === 'money' || /Minor$/.test(key)))
    return { kind: 'money', minor: text };
  if (/^-?\d+$/.test(text) && /Bps$/.test(key)) return { kind: 'bps', value: text };
  return { kind: 'text', value: text };
}

/** Basis points as a percentage string without floating point: "1250" → "12.5". */
export function bpsToPercent(bps: string): string {
  const neg = bps.startsWith('-');
  const digits = neg ? bps.slice(1) : bps;
  const s = digits.padStart(3, '0');
  const out = `${s.slice(0, -2)}.${s.slice(-2)}`.replace(/\.?0+$/, '');
  return `${neg ? '-' : ''}${out}`;
}

/**
 * Bars for the first money column (at most `limit` rows), scaled to the largest absolute value. BigInt arithmetic; the ratio
 * is only a drawing length, the exact figure is always printed next to the bar.
 */
export function barRows(
  columns: { key: string; kind: string }[],
  rows: Record<string, unknown>[],
  limit = 12,
): { key: string; labelKey: string; valueKey: string; minor: string; ratio: number }[] {
  const money = columns.find((c) => c.kind === 'money');
  const text = columns.find((c) => c.kind === 'text');
  if (!money) return [];
  const picked = rows
    .slice(0, limit)
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => /^-?\d+$/.test(String(r[money.key] ?? '')));
  const abs = (v: string) => (BigInt(v) < 0n ? -BigInt(v) : BigInt(v));
  const max = picked.reduce(
    (m, { r }) => (abs(String(r[money.key])) > m ? abs(String(r[money.key])) : m),
    0n,
  );
  return picked.map(({ r, i }) => ({
    key: `${i}`,
    labelKey: text ? String(r[text.key] ?? '—') : `#${i + 1}`,
    valueKey: money.key,
    minor: String(r[money.key]),
    ratio: max === 0n ? 0 : Number((abs(String(r[money.key])) * 1000n) / max) / 1000,
  }));
}

/** "days1to30Minor" → "days1to30 Minor": a readable fallback when a report key has no translation. */
export const humanize = (key: string) =>
  key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

// ---- S12d: invoice, payment, PSP-event and refund list screens (UI-M03-13/14/15) ----

/** Start / end of a calendar day (UTC) as an ISO date-time for the `from` / `to` filters, or `undefined` when the input is empty or not a date. */
export const dayStartIso = (v: string | undefined) =>
  v && isDateOnly(v) ? `${v}T00:00:00.000Z` : undefined;
export const dayEndIso = (v: string | undefined) =>
  v && isDateOnly(v) ? `${v}T23:59:59.999Z` : undefined;

/** A filter value is acceptable when empty (not set) or a valid uuid / date. Returns the problems so the page can say so instead of calling the API. */
export function filterProblems(f: {
  org?: string | undefined;
  invoiceId?: string | undefined;
  paymentId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): boolean {
  const bad = (v: string | undefined, ok: (x: string) => boolean) => !!v && !ok(v);
  return (
    bad(f.org, isUuid) ||
    bad(f.invoiceId, isUuid) ||
    bad(f.paymentId, isUuid) ||
    bad(f.from, isDateOnly) ||
    bad(f.to, isDateOnly) ||
    (!!f.from && !!f.to && isDateOnly(f.from) && isDateOnly(f.to) && f.from > f.to)
  );
}

export function invoiceTone(status: string): Tone {
  return status === 'paid'
    ? 'success'
    : status === 'void' || status === 'uncollectible'
      ? 'danger'
      : 'warn';
}
export function paymentTone(status: string): Tone {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  return 'warn';
}
export function refundTone(status: string): Tone {
  return status === 'succeeded' ? 'success' : status === 'failed' ? 'danger' : 'warn';
}
export function eventTone(status: string): Tone {
  return status === 'processed' ? 'success' : status === 'failed' ? 'danger' : 'warn';
}

/** Cursor-page link that keeps the active filters. Empty values are dropped. */
export function pageQuery(filters: Record<string, string | undefined>, cursor: string): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  p.set('cursor', cursor);
  return `?${p.toString()}`;
}

/** Show a uuid compactly (first 8 characters); the full value stays in the title attribute. */
export const shortId = (id: string) => id.slice(0, 8);

export const INVOICE_STATUSES = [
  'open',
  'partially_paid',
  'paid',
  'void',
  'uncollectible',
] as const;
export const EINVOICE_STATES = [
  'not_generated',
  'generated',
  'stamped',
  'queued',
  'submitted',
  'cleared',
  'reported',
  'rejected',
  'error',
] as const;
export const PAYMENT_STATUSES = [
  'requires_method',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'partially_refunded',
  'refunded',
] as const;
export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;
