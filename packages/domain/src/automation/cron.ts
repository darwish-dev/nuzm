/**
 * M11 S51: 5-field cron (`min hour dom month dow`) evaluated in a time zone (UTC by default, or the organization's IANA zone).
 * Supports the star, lists, ranges and steps (for example every 5 minutes, or 1-10 by 2). Month/day names are NOT supported (numbers only; dow 0-6, 7 = Sunday).
 * Day-of-month and day-of-week follow the classic rule: when BOTH are restricted, a day matches if EITHER matches.
 */
export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

function field(
  src: string,
  min: number,
  max: number,
  name: string,
): { set: Set<number>; star: boolean } {
  const set = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron: invalid ${name} field '${src}'`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`cron: step must be >= 1 in ${name}`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-').map(Number) as [number, number | undefined];
      lo = a;
      hi = b ?? (m[2] === undefined ? a : max);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron: ${name} out of range in '${src}'`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, star: src === '*' };
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron: five fields are required');
  const minute = field(f[0]!, 0, 59, 'minute');
  const hour = field(f[1]!, 0, 23, 'hour');
  const dom = field(f[2]!, 1, 31, 'day-of-month');
  const month = field(f[3]!, 1, 12, 'month');
  const dow = field(f[4]!, 0, 7, 'day-of-week');
  if (dow.set.has(7)) dow.set.add(0);
  return {
    minute: minute.set,
    hour: hour.set,
    dom: dom.set,
    month: month.set,
    dow: dow.set,
    domStar: dom.star,
    dowStar: dow.star,
  };
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(d: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday!);
  return {
    minute: Number(o.minute),
    hour: Number(o.hour) % 24,
    dom: Number(o.day),
    month: Number(o.month),
    dow,
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function cronMatches(c: CronSpec, d: Date, tz = 'UTC'): boolean {
  const p = parts(d, tz);
  if (!c.minute.has(p.minute) || !c.hour.has(p.hour) || !c.month.has(p.month)) return false;
  const domOk = c.dom.has(p.dom);
  const dowOk = c.dow.has(p.dow);
  return c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : domOk || dowOk;
}

/** The first matching minute strictly after `after` (within ~5 years), or null. Minute resolution; seconds are zeroed. */
export function nextCronRun(expr: string | CronSpec, after: Date, tz = 'UTC'): Date | null {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 5 * 366 * 86_400_000;
  while (t < limit) {
    const d = new Date(t);
    const p = parts(d, tz);
    if (!c.month.has(p.month)) {
      t += 86_400_000 - (p.hour * 60 + p.minute) * 60_000; // jump to the next local day
      continue;
    }
    if (!c.hour.has(p.hour)) {
      t += (60 - p.minute) * 60_000; // jump to the next local hour
      continue;
    }
    if (cronMatches(c, d, tz)) return d;
    t += 60_000;
  }
  return null;
}
