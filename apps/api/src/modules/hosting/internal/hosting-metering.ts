import { emitUsage, usageEventId, type Db } from '@nuzm/platform';

const NANO = 1_000_000_000n;
const GIB = 1_073_741_824n;
const GB = 1_000_000_000n;
const DAY = 86_400_000;

/** `12345678` nanos → `0.012345678`: exact decimal strings, never floats (CLAUDE.md §4). */
export const nanosToDecimal = (n: bigint): string =>
  `${n / NANO}.${(n % NANO).toString().padStart(9, '0')}`;
export const daysInMonth = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
export const dayStart = (d: Date) => new Date(Math.floor(d.getTime() / DAY) * DAY);
/**
 * Fraction of the month that one UTC day represents, in nanos. Every day gets floor(1e9/days); the LAST day of the month gets the remainder so the days of a
 * month sum to EXACTLY one site-month (31 days: 30 x 32258064 + 32258080).
 */
export function dayFractionNanos(day: Date): bigint {
  const days = BigInt(daysInMonth(day));
  const base = NANO / days;
  const last = day.getUTCDate() === Number(days);
  return last ? NANO - base * (days - 1n) : base;
}

interface SiteRow {
  id: string;
  org_id: string;
  data_region: string;
  plan_key: string;
  created_at: Date;
}

/**
 * Metering emitters (M06 §10). Meters: `hosting.site_months`, `hosting.disk_gb_months`, `hosting.bandwidth_gb`, `hosting.backup_gb_months` (seeded by M02 0201).
 *  - daily accrual of the three monthly meters for every COMPLETE UTC day a site was live; `eventId = uuidv5(org|meter|site|day)` (docs/12 §2) = hash(site, day);
 *  - bandwidth: the hourly usage report carries the CUMULATIVE bytes of the month; the delta since the last mark is emitted, a new month restarts at the new value;
 *  - events go through the central pipeline (`emitUsage` → outbox → ingest) IN THE SAME TRANSACTION that moves the mark: a rerun or a crash never double counts,
 *    and the ingest dedupes by event id anyway.
 * Node infrastructure cost reaches the platform org through M05 `compute.*` meters (internal margin view); nothing here bills the platform org.
 */
export class HostingMetering {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async sites(): Promise<SiteRow[]> {
    return this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.id, s.org_id, s.data_region, p.key AS plan_key, s.created_at FROM hosting.sites s JOIN hosting.plan_definitions p ON p.id = s.plan_id WHERE s.status IN ('active','suspended') OR (s.status IN ('deleting','restoring')) ORDER BY s.id`,
          )
        ).rows as SiteRow[],
    );
  }

  /** Accrue every complete day since the mark (or since creation) up to `now`. Returns the number of events emitted. */
  async accrue(now = this.clock()): Promise<{ events: number }> {
    const today = dayStart(now).getTime();
    let events = 0;
    for (const s of await this.sites()) {
      for (const meter of [
        'hosting.site_months',
        'hosting.disk_gb_months',
        'hosting.backup_gb_months',
      ] as const) {
        events += await this.db.withOrg(s.org_id, async (c) => {
          const mark = (
            await c.query(
              `SELECT emitted_until FROM hosting.metering_marks WHERE site_id = $1 AND meter_id = $2 FOR UPDATE`,
              [s.id, meter],
            )
          ).rows[0];
          let from = mark?.emitted_until
            ? (mark.emitted_until as Date).getTime()
            : dayStart(new Date(s.created_at)).getTime() + DAY; // the creation day is partial: accrued from the next full day
          if (from >= today) return 0;
          let n = 0;
          while (from < today) {
            const day = new Date(from);
            const frac = dayFractionNanos(day);
            let q: bigint | null;
            if (meter === 'hosting.site_months') q = frac;
            else {
              const u = (
                await c.query(
                  `SELECT disk_bytes, backup_bytes FROM hosting.site_usage_reports WHERE site_id = $1 AND period_start < $2 ORDER BY period_start DESC LIMIT 1`,
                  [s.id, new Date(from + DAY)],
                )
              ).rows[0];
              const bytes = u
                ? BigInt(String(meter === 'hosting.disk_gb_months' ? u.disk_bytes : u.backup_bytes))
                : 0n;
              q = bytes === 0n ? null : (bytes * frac) / GIB; // GiB x fraction of the month, in nanos
            }
            if (q !== null && q > 0n) {
              await emitUsage(c, {
                eventId: usageEventId({
                  orgId: s.org_id,
                  meterId: meter,
                  resourceId: s.id,
                  windowStart: day.toISOString(),
                }),
                orgId: s.org_id,
                meterId: meter,
                quantity: nanosToDecimal(q),
                unit: meter === 'hosting.site_months' ? 'site_month' : 'gib_month',
                resourceId: s.id,
                windowStart: day.toISOString(),
                windowEnd: new Date(from + DAY).toISOString(),
                occurredAt: new Date(Math.min(from + DAY, now.getTime())).toISOString(),
                dimensions: { plan: s.plan_key },
                dataRegion: s.data_region,
                source: 'hosting@M06',
              });
              n++;
            }
            from += DAY;
          }
          await c.query(
            `INSERT INTO hosting.metering_marks (site_id, org_id, meter_id, emitted_until) VALUES ($1,$2,$3,$4) ON CONFLICT (site_id, meter_id) DO UPDATE SET emitted_until = EXCLUDED.emitted_until, updated_at = now()`,
            [s.id, s.org_id, meter, new Date(today)],
          );
          return n;
        });
      }
    }
    return { events };
  }

  /** After a usage report: emit the bandwidth delta (GB, decimal 1e9 bytes) since the last emission. */
  async bandwidth(siteId: string): Promise<number> {
    const site = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.id, s.org_id, s.data_region, p.key AS plan_key FROM hosting.sites s JOIN hosting.plan_definitions p ON p.id = s.plan_id WHERE s.id = $1`,
            [siteId],
          )
        ).rows[0],
    );
    if (!site) return 0;
    return this.db.withOrg(site.org_id as string, async (c) => {
      const u = (
        await c.query(
          `SELECT period_start, bandwidth_bytes_month FROM hosting.site_usage_reports WHERE site_id = $1 ORDER BY period_start DESC LIMIT 1`,
          [siteId],
        )
      ).rows[0];
      if (!u) return 0;
      const period = (u.period_start as Date).toISOString().slice(0, 7);
      const cur = BigInt(String(u.bandwidth_bytes_month));
      const mark = (
        await c.query(
          `SELECT last_value, period FROM hosting.metering_marks WHERE site_id = $1 AND meter_id = 'hosting.bandwidth_gb' FOR UPDATE`,
          [siteId],
        )
      ).rows[0];
      const prev = mark && mark.period === period ? BigInt(String(mark.last_value)) : 0n;
      if (mark && mark.period === period && cur === prev) return 0;
      const delta = cur >= prev ? cur - prev : cur; // a counter that went DOWN inside the month restarted at the node: count what it shows now
      let n = 0;
      if (delta > 0n) {
        const windowStart = (u.period_start as Date).toISOString();
        await emitUsage(c, {
          eventId: usageEventId({
            orgId: site.org_id as string,
            meterId: 'hosting.bandwidth_gb',
            resourceId: siteId,
            windowStart,
          }),
          orgId: site.org_id as string,
          meterId: 'hosting.bandwidth_gb',
          quantity: nanosToDecimal((delta * NANO) / GB),
          unit: 'gb',
          resourceId: siteId,
          windowStart,
          windowEnd: new Date((u.period_start as Date).getTime() + 3_600_000).toISOString(),
          occurredAt: windowStart,
          dimensions: { plan: site.plan_key as string },
          dataRegion: site.data_region as string,
          source: 'hosting@M06',
        });
        n = 1;
      }
      await c.query(
        `INSERT INTO hosting.metering_marks (site_id, org_id, meter_id, last_value, period) VALUES ($1,$2,'hosting.bandwidth_gb',$3,$4) ON CONFLICT (site_id, meter_id) DO UPDATE SET last_value = EXCLUDED.last_value, period = EXCLUDED.period, updated_at = now()`,
        [siteId, site.org_id, cur.toString(), period],
      );
      return n;
    });
  }
}
