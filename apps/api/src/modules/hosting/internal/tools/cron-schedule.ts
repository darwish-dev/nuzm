/**
 * Validation of a classic five-field cron schedule (minute hour day month weekday) BEFORE it is sent to the panel. The fields are digits and `* , / -` only (the allow-list's
 * `cronField` pattern); here they are parsed, range-checked and the firing interval is bounded: a customer cannot schedule work more often than the plan allows
 * (default every 5 minutes: PROPOSAL, config `HOSTING_TOOLS_MIN_CRON_INTERVAL_MINUTES`).
 */
export interface CronFields {
  min: string;
  hour: string;
  day: string;
  month: string;
  wday: string;
}
const RANGE: Record<keyof CronFields, [number, number]> = {
  min: [0, 59],
  hour: [0, 23],
  day: [1, 31],
  month: [1, 12],
  wday: [0, 7],
};

/** The set of values a field selects, or `null` when the field is not valid. */
export function expandField(field: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let from = lo;
    let to = hi;
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-').map(Number) as [number, number | undefined];
      from = a;
      to = b ?? (m[2] === undefined ? a : hi);
      if (b !== undefined && b < a) return null;
    }
    if (from < lo || to > hi) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out.size ? out : null;
}

export type CronProblem = 'invalid_field' | 'too_frequent';
/** `null` = acceptable. */
export function checkCronSchedule(f: CronFields, minIntervalMinutes: number): CronProblem | null {
  const sets = {} as Record<keyof CronFields, Set<number>>;
  for (const k of Object.keys(RANGE) as (keyof CronFields)[]) {
    const s = expandField(f[k], RANGE[k]);
    if (!s) return 'invalid_field';
    sets[k] = s;
  }
  const minutes = [...sets.min].sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 1; i < minutes.length; i++) gap = Math.min(gap, minutes[i]! - minutes[i - 1]!);
  // across the hour boundary only when two consecutive hours both run
  const hours = sets.hour;
  const consecutive = [...hours].some((h) => hours.has((h + 1) % 24));
  if (consecutive) gap = Math.min(gap, 60 - minutes[minutes.length - 1]! + minutes[0]!);
  if (minutes.length === 1 && consecutive) gap = Math.min(gap, 60);
  return gap < minIntervalMinutes ? 'too_frequent' : null;
}
