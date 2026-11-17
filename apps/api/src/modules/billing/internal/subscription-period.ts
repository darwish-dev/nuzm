/**
 * Billing periods of a subscription (docs/11 §2). Pure date arithmetic on `YYYY-MM-DD` strings (UTC, no time zones, no `Date` local
 * time): a period starts on the anchor day and lasts one calendar month; a month shorter than the anchor day clamps to its last day
 * (anchor 31 → Feb 28/29 → Mar 31, never drifting to 28 forever). Periods are contiguous: the end of one is the start of the next.
 */
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseYmd(s: string): { y: number; m: number; d: number } {
  const x = YMD.exec(s);
  if (!x) throw new Error(`not a date: ${s}`);
  const y = Number(x[1]);
  const m = Number(x[2]);
  const d = Number(x[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new Error(`not a date: ${s}`);
  return { y, m, d };
}
export const daysInMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();
const fmt = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The date `n` months after `start`, on the anchor day (clamped to the length of that month). */
export function addMonths(start: string, anchorDay: number, n: number): string {
  const { y, m } = parseYmd(start);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return fmt(ny, nm, Math.min(anchorDay, daysInMonth(ny, nm)));
}
export const nextPeriodEnd = (start: string, anchorDay: number): string =>
  addMonths(start, anchorDay, 1);

/** Whole days from `a` to `b` (b − a); both UTC dates. */
export function daysBetween(a: string, b: string): number {
  const pa = parseYmd(a);
  const pb = parseYmd(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}
export const addDays = (s: string, n: number): string => {
  const { y, m, d } = parseYmd(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
export const todayUtc = (now: Date): string =>
  fmt(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
