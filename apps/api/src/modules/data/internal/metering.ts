import { emitUsage, usageEventId, type Db, type UsageEvent } from '@nuzm/platform';
import type { Row } from './model';

const GIB = 1024n ** 3n;
/** Exact `bytes / GiB / 30` as a decimal string with 8 decimals, half-up (the metering scale; never a float). */
export function gibMonthFraction(bytes: bigint, divisorDays = 30n): string {
  const scale = 10n ** 8n;
  const num = bytes * scale;
  const den = GIB * divisorDays;
  const q = (num * 2n + den) / (den * 2n);
  const whole = q / scale;
  const frac = (q % scale).toString().padStart(8, '0');
  return `${whole}.${frac}`;
}
export function gibMonthFractionOfGb(gb: number, divisorDays = 30n): string {
  return gibMonthFraction(BigInt(gb) * GIB, divisorDays);
}
const hourFloor = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);
const dayFloor = (d: Date) => new Date(Math.floor(d.getTime() / 86_400_000) * 86_400_000);

/**
 * Usage emitters of the data module (M08 §10). Every emit is a deterministic event id over the business key (org, meter, resource, window), written to
 * the transactional outbox, so re-running a sampler for the same window never double counts. A meter that a provider cannot report is NOT emitted
 * (`unavailable`), never estimated. Samplers read across organizations under the platform scope (read-only) and write per organization.
 */
export class DataMetering {
  constructor(private readonly db: Db) {}

  private ev(
    r: Row,
    meterId: string,
    quantity: string,
    unit: string,
    windowStart: Date,
    windowEnd: Date,
    dims: Record<string, string>,
    source: string,
  ): UsageEvent {
    const orgId = r.org_id as string;
    return {
      eventId: usageEventId({
        orgId,
        meterId,
        resourceId: String(r.id),
        windowStart: windowStart.toISOString(),
      }),
      orgId,
      meterId,
      quantity,
      unit,
      resourceId: String(r.id),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      occurredAt: windowEnd.toISOString(),
      dimensions: dims,
      dataRegion: String(r.data_region),
      source,
    };
  }
  private async running(at: Date): Promise<Row[]> {
    return this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.database_instances WHERE state = 'running' AND created_at < $1 ORDER BY id`,
            [at],
          )
        ).rows as Row[],
    );
  }

  /** `database.instance_hours` / `cache.instance_hours`: one hour per running instance for the hour that STARTS at `hourStart`. Returns the number of events written. */
  async sampleHour(hourStart: Date): Promise<number> {
    const start = hourFloor(hourStart);
    const end = new Date(start.getTime() + 3_600_000);
    let n = 0;
    for (const r of await this.running(end)) {
      const meter = r.engine === 'redis' ? 'cache.instance_hours' : 'database.instance_hours';
      const dims: Record<string, string> = {
        size: String(r.plan_ref),
        region: String(r.data_region),
      };
      if (r.engine !== 'redis') dims.engine = String(r.engine);
      await this.db.withOrg(r.org_id as string, (c) =>
        emitUsage(c, this.ev(r, meter, '1', 'instance_hour', start, end, dims, 'data@M08')),
      );
      n++;
    }
    return n;
  }
  /** Daily snapshot: provisioned storage (`database.storage_gb_months`, accrual /30) and backup storage (`database.backup_gb_months`). Redis has neither meter. */
  async sampleDay(dayStart: Date): Promise<number> {
    const start = dayFloor(dayStart);
    const end = new Date(start.getTime() + 86_400_000);
    let n = 0;
    for (const r of await this.running(end)) {
      if (r.engine === 'redis') continue;
      const dims = { engine: String(r.engine), region: String(r.data_region) };
      if (Number(r.storage_gb) > 0) {
        await this.db.withOrg(r.org_id as string, (c) =>
          emitUsage(
            c,
            this.ev(
              r,
              'database.storage_gb_months',
              gibMonthFractionOfGb(Number(r.storage_gb)),
              'gib_month',
              start,
              end,
              dims,
              'data@M08',
            ),
          ),
        );
        n++;
      }
      const bytes = await this.db.withOrg(r.org_id as string, async (c) =>
        BigInt(
          String(
            (
              await c.query(
                `SELECT coalesce(sum(size_bytes),0) AS b FROM data.database_backups WHERE instance_id = $1 AND state = 'available' AND created_at < $2 AND (expires_at IS NULL OR expires_at >= $3)`,
                [r.id, end, start],
              )
            ).rows[0]!.b,
          ),
        ),
      );
      if (bytes > 0n) {
        await this.db.withOrg(r.org_id as string, (c) =>
          emitUsage(
            c,
            this.ev(
              r,
              'database.backup_gb_months',
              gibMonthFraction(bytes),
              'gib_month',
              start,
              end,
              { engine: String(r.engine) },
              'data@M08',
            ),
          ),
        );
        n++;
      }
    }
    return n;
  }
}
