import { usageForInterval, type UsageWindow } from '@nuzm/domain';
import { emitUsage, usageEventId, type Db } from '@nuzm/platform';
import type { Clock } from '@nuzm/adapter-runtime';
import type { Row } from './common';

const UNIT: Record<UsageWindow['meterId'], string> = {
  'compute.vcpu_hours': 'vcpu_hour',
  'compute.memory_gb_hours': 'gib_hour',
  'compute.disk_gb_months': 'gib_month',
};
const HOUR = 3_600_000;

/**
 * Hourly sampler (M05 §10): turns running intervals into usage events through the central pipeline (outbox → ingest). It emits only COMPLETE hours
 * for open intervals and the remaining (possibly partial) hours when an interval has ended. Event ids are deterministic per (org, meter, resource, hour,
 * interval) and the `emitted_until` mark moves in the SAME transaction as the outbox rows, so reruns and crashes never double count.
 * Egress is NOT metered here: it needs per-resource traffic from a provider probe (none exists) — that meter is NOT VERIFIED.
 */
export class ComputeMeteringSampler {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<{ intervals: number; events: number }> {
    const now = this.clock.now();
    const hourFloor = Math.floor(now / HOUR) * HOUR;
    const due = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id FROM compute.instance_intervals WHERE (ended_at IS NULL AND (emitted_until IS NULL OR emitted_until < $1)) OR (ended_at IS NOT NULL AND (emitted_until IS NULL OR emitted_until < ended_at)) ORDER BY started_at LIMIT 500`,
            [new Date(hourFloor)],
          )
        ).rows as Row[],
    );
    let events = 0;
    for (const d of due) {
      events += await this.db.withOrg(d.org_id as string, async (c) => {
        const iv = (
          await c.query(`SELECT * FROM compute.instance_intervals WHERE id = $1 FOR UPDATE`, [d.id])
        ).rows[0] as Row | undefined;
        if (!iv) return 0;
        const startMs = new Date(iv.started_at as Date).getTime();
        const endMs = iv.ended_at ? new Date(iv.ended_at as Date).getTime() : null;
        const fromMs = iv.emitted_until ? new Date(iv.emitted_until as Date).getTime() : startMs;
        const toMs = endMs ?? hourFloor; // open interval: complete hours only
        if (toMs <= fromMs) return 0;
        const windows = usageForInterval(
          {
            startMs,
            endMs,
            vcpu: iv.vcpu as number,
            memoryMb: iv.memory_mb as number,
            diskGb: iv.disk_gb as number,
          },
          fromMs,
          toMs,
        );
        for (const w of windows) {
          await emitUsage(c, {
            eventId: usageEventId({
              orgId: iv.org_id as string,
              meterId: w.meterId,
              resourceId: iv.resource_id as string,
              windowStart: new Date(w.windowStartMs).toISOString(),
              sourceSeq: iv.id as string,
            }),
            orgId: iv.org_id as string,
            meterId: w.meterId,
            quantity: w.quantity,
            unit: UNIT[w.meterId],
            resourceId: iv.resource_id as string,
            windowStart: new Date(w.windowStartMs).toISOString(),
            windowEnd: new Date(w.windowEndMs).toISOString(),
            occurredAt: new Date(Math.min(w.windowEndMs, now)).toISOString(),
            dimensions: { region: iv.data_region as string },
            dataRegion: iv.data_region as string,
            source: 'compute@M05',
          });
        }
        await c.query(`UPDATE compute.instance_intervals SET emitted_until = $2 WHERE id = $1`, [
          iv.id,
          new Date(toMs),
        ]);
        return windows.length;
      });
    }
    return { intervals: due.length, events };
  }
}
