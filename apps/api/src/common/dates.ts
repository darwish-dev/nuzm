/**
 * A PostgreSQL `date` column (no time, no zone) as `YYYY-MM-DD`. node-pg returns it as a Date at LOCAL midnight, so reading it with
 * `toISOString()` shows the previous day on any server ahead of UTC (Riyadh is UTC+3). Always go through this helper for date columns.
 */
export function dateOnly(v: unknown): string {
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}
