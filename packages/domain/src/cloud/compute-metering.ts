/**
 * Compute usage from running intervals (M05 §10). Pure and exact: integer arithmetic scaled to the metering scale (8 decimals, half-up).
 * Meters: compute.vcpu_hours, compute.memory_gb_hours (GiB hours), compute.disk_gb_months (GiB-month accrued per hour fraction of the
 * UTC month). Each (meter, hourly window) of a resource is ONE event id upstream, so replays and duplicates never double count.
 */
export interface RunInterval {
  startMs: number;
  /** null = still running. */
  endMs: number | null;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
}
export interface UsageWindow {
  meterId: 'compute.vcpu_hours' | 'compute.memory_gb_hours' | 'compute.disk_gb_months';
  windowStartMs: number;
  windowEndMs: number;
  /** Exact decimal string, 8 fractional digits. */
  quantity: string;
}
const HOUR = 3_600_000;
const SCALE = 100_000_000n;

/** round_half_up(num / den) at 8 decimals, as a decimal string. */
export function scaledDecimal(num: bigint, den: bigint): string {
  const scaled = (num * SCALE * 2n + den) / (den * 2n);
  const whole = scaled / SCALE;
  const frac = (scaled % SCALE).toString().padStart(8, '0');
  return `${whole}.${frac}`;
}
const monthMs = (t: number): number => {
  const d = new Date(t);
  return (
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) -
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  );
};

/** Usage of one interval inside [fromMs, toMs) (an open interval counts up to `toMs`). Hourly windows aligned to UTC hours. */
export function usageForInterval(i: RunInterval, fromMs: number, toMs: number): UsageWindow[] {
  const end = Math.min(i.endMs ?? toMs, toMs);
  const start = Math.max(i.startMs, fromMs);
  if (end <= start) return [];
  const out: UsageWindow[] = [];
  for (let w = Math.floor(start / HOUR) * HOUR; w < end; w += HOUR) {
    const overlap = Math.min(end, w + HOUR) - Math.max(start, w);
    if (overlap <= 0) continue;
    const o = BigInt(overlap);
    out.push({
      meterId: 'compute.vcpu_hours',
      windowStartMs: w,
      windowEndMs: w + HOUR,
      quantity: scaledDecimal(BigInt(i.vcpu) * o, BigInt(HOUR)),
    });
    out.push({
      meterId: 'compute.memory_gb_hours',
      windowStartMs: w,
      windowEndMs: w + HOUR,
      quantity: scaledDecimal(BigInt(i.memoryMb) * o, BigInt(HOUR) * 1024n),
    });
    out.push({
      meterId: 'compute.disk_gb_months',
      windowStartMs: w,
      windowEndMs: w + HOUR,
      quantity: scaledDecimal(BigInt(i.diskGb) * o, BigInt(monthMs(w))),
    });
  }
  return out;
}

/** Replay a timeline: one entry per (meter, window) with quantities of overlapping intervals summed. Order-independent. */
export function replayUsage(
  intervals: readonly RunInterval[],
  fromMs: number,
  toMs: number,
): Map<string, bigint> {
  const total = new Map<string, bigint>();
  for (const i of intervals)
    for (const u of usageForInterval(i, fromMs, toMs)) {
      const key = `${u.meterId}|${u.windowStartMs}`;
      total.set(key, (total.get(key) ?? 0n) + BigInt(u.quantity.replace('.', '')));
    }
  return total;
}
export const sumMeter = (m: Map<string, bigint>, meterId: UsageWindow['meterId']): string => {
  let s = 0n;
  for (const [k, v] of m) if (k.startsWith(`${meterId}|`)) s += v;
  const whole = s / SCALE;
  return `${whole}.${(s % SCALE).toString().padStart(8, '0')}`;
};
