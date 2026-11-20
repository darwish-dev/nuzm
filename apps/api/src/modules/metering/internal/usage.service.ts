import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { UUID } from '@nuzm/domain';

type Row = Record<string, unknown>;
const METER = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_RANGE_MS = 366 * 86_400_000;

export type Granularity = 'hour' | 'day' | 'month';
export interface UsageFilter {
  meterId?: string | undefined;
  resourceId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
  cursor?: string | undefined;
}
export interface UsagePoint {
  meterId: string;
  unit: string;
  resourceId: string | null;
  granularity: Granularity;
  bucketStart: string;
  billingPeriodStart: string;
  quantity: string;
  eventCount: number;
  dataRegion: string;
}
export interface UsageEventDto {
  eventId: string;
  meterId: string;
  quantity: string;
  unit: string;
  resourceId: string | null;
  windowStart: string;
  windowEnd: string;
  occurredAt: string;
  receivedAt: string;
  source: string;
  dimensions: Record<string, unknown>;
  dataRegion: string;
  late: boolean;
  skewFlag: boolean;
  adjustsEventId: string | null;
}
export interface Pg<T> {
  items: T[];
  nextCursor: string | null;
}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = <T>(raw: string | undefined, ok: (v: unknown) => v is T): T | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    return ok(v) ? v : null;
  } catch {
    return null;
  }
};
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

function window_(f: { from?: Date | undefined; to?: Date | undefined }, now: Date) {
  const from = f.from ?? monthStart(now);
  const to = f.to ?? new Date(now.getTime() + 86_400_000);
  if (to <= from) throw new ProblemException('validation_failed', 'to must be after from');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS)
    throw new ProblemException('validation_failed', 'the time range is limited to 366 days');
  return { from, to };
}
function checkFilter(f: { meterId?: string | undefined; resourceId?: string | undefined }) {
  if (f.meterId !== undefined && !METER.test(f.meterId))
    throw new ProblemException('validation_failed', 'meter is not a valid meter id');
  if (f.resourceId !== undefined && !UUID.test(f.resourceId))
    throw new ProblemException('validation_failed', 'resource must be a uuid');
}

/**
 * Customer usage reads (docs/04 `/v1/usage*`). Everything is the caller's organization (RLS); filters are bound
 * parameters only. Aggregates are rolled up from the stored buckets: `month` follows the BILLING period (so a late event
 * counts where it is billed), `day`/`hour` follow the bucket (a meter stored per day is never split into hours).
 */
export class UsageService {
  constructor(private readonly db: Db) {}

  async list(
    orgId: string,
    f: UsageFilter & { granularity: Granularity },
    now = new Date(),
  ): Promise<Pg<UsagePoint>> {
    checkFilter(f);
    const { from, to } = window_(f, now);
    const cur = dec(
      f.cursor,
      (v): v is { b: string; m: string; r: string } =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as Row).b === 'string' &&
        typeof (v as Row).m === 'string' &&
        typeof (v as Row).r === 'string',
    );
    if (f.cursor && !cur) throw new ProblemException('validation_failed', 'invalid cursor');
    const bucket =
      f.granularity === 'month'
        ? `(a.billing_period_start::timestamp AT TIME ZONE 'UTC')`
        : f.granularity === 'day'
          ? `(date_trunc('day', a.bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`
          : `a.bucket_start`;
    const gran =
      f.granularity === 'month'
        ? `'month'`
        : f.granularity === 'day'
          ? `'day'`
          : `min(a.granularity)`;
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query<Row>(
          `SELECT * FROM (
             SELECT a.meter_id, m.unit, a.resource_key, ${bucket} AS bucket, ${gran} AS granularity,
                    min(a.billing_period_start)::text AS bp, sum(a.quantity)::text AS quantity,
                    sum(a.event_count)::int AS event_count, min(a.data_region) AS data_region
               FROM metering.usage_aggregates a JOIN metering.meters m ON m.id = a.meter_id
              WHERE a.org_id = $1 AND a.bucket_start >= $2 AND a.bucket_start < $3
                AND ($4::text IS NULL OR a.meter_id = $4) AND ($5::text IS NULL OR a.resource_key = $5)
              GROUP BY a.meter_id, m.unit, a.resource_key, ${bucket}${f.granularity === 'month' ? '' : ', a.billing_period_start'}
           ) t
            WHERE $6::timestamptz IS NULL OR (t.bucket, t.meter_id, t.resource_key) < ($6::timestamptz, $7::text, $8::text)
            ORDER BY t.bucket DESC, t.meter_id DESC, t.resource_key DESC LIMIT $9`,
          [
            orgId,
            from,
            to,
            f.meterId ?? null,
            f.resourceId?.toLowerCase() ?? null,
            cur?.b ?? null,
            cur?.m ?? null,
            cur?.r ?? null,
            f.limit + 1,
          ],
        )
      ).rows;
      const page = rows.slice(0, f.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r): UsagePoint => ({
          meterId: r.meter_id as string,
          unit: r.unit as string,
          resourceId: (r.resource_key as string) === '' ? null : (r.resource_key as string),
          granularity: r.granularity as Granularity,
          bucketStart: (r.bucket as Date).toISOString(),
          billingPeriodStart: r.bp as string,
          quantity: r.quantity as string,
          eventCount: r.event_count as number,
          dataRegion: r.data_region as string,
        })),
        nextCursor:
          rows.length > f.limit && last
            ? enc({
                b: (last.bucket as Date).toISOString(),
                m: last.meter_id,
                r: last.resource_key,
              })
            : null,
      };
    });
  }

  /** Per meter for one UTC month: usage, and the rated amount (latest rating per key, net of corrections) when rated. */
  async summary(orgId: string, month: Date | undefined, now = new Date()) {
    const period = monthStart(month ?? now);
    return this.db.withOrg(orgId, async (c) => {
      const usage = (
        await c.query<Row>(
          `SELECT a.meter_id, m.unit, sum(a.quantity)::text AS quantity, sum(a.event_count)::int AS event_count,
                  array_agg(DISTINCT a.data_region ORDER BY a.data_region) AS regions
             FROM metering.usage_aggregates a JOIN metering.meters m ON m.id = a.meter_id
            WHERE a.org_id = $1 AND a.billing_period_start = $2 GROUP BY a.meter_id, m.unit ORDER BY a.meter_id`,
          [orgId, period],
        )
      ).rows;
      const rated = (
        await c.query<Row>(
          `SELECT meter_id, currency, sum(amount_minor)::text AS amount, sum(allowance_applied)::text AS allowance,
                  sum(billable_quantity)::text AS billable
             FROM (SELECT DISTINCT ON (meter_id, resource_key, segment_start) *
                     FROM metering.rated_usage WHERE org_id = $1 AND period_start = $2
                    ORDER BY meter_id, resource_key, segment_start, created_at DESC, id DESC) t
            GROUP BY meter_id, currency`,
          [orgId, period],
        )
      ).rows;
      const byMeter = new Map(rated.map((r) => [r.meter_id as string, r]));
      const currencies = new Set(rated.map((r) => (r.currency as string).trim()));
      const total = rated.reduce((s, r) => s + BigInt(r.amount as string), 0n);
      return {
        periodStart: period.toISOString().slice(0, 10),
        items: usage.map((u) => {
          const r = byMeter.get(u.meter_id as string);
          return {
            meterId: u.meter_id as string,
            unit: u.unit as string,
            quantity: u.quantity as string,
            eventCount: u.event_count as number,
            dataRegions: u.regions as string[],
            rated: r !== undefined,
            allowanceApplied: r ? (r.allowance as string) : null,
            billableQuantity: r ? (r.billable as string) : null,
            amountMinor: r ? (r.amount as string) : null,
            currency: r ? (r.currency as string).trim() : null,
          };
        }),
        // a total is only meaningful in one currency; mixed currencies are reported per item, never summed
        totalMinor: currencies.size === 1 ? total.toString() : null,
        currency: currencies.size === 1 ? [...currencies][0]! : null,
      };
    });
  }

  /** Raw events of the caller's organization, newest window first. */
  async events(orgId: string, f: UsageFilter, now = new Date()): Promise<Pg<UsageEventDto>> {
    checkFilter(f);
    const { from, to } = window_(f, now);
    const cur = dec(
      f.cursor,
      (v): v is { w: string; e: string } =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as Row).w === 'string' &&
        typeof (v as Row).e === 'string' &&
        UUID.test((v as Row).e as string),
    );
    if (f.cursor && !cur) throw new ProblemException('validation_failed', 'invalid cursor');
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query<Row>(
          `SELECT * FROM metering.usage_events
            WHERE org_id = $1 AND window_start >= $2 AND window_start < $3
              AND ($4::text IS NULL OR meter_id = $4) AND ($5::uuid IS NULL OR resource_id = $5::uuid)
              AND ($6::timestamptz IS NULL OR (window_start, event_id) < ($6::timestamptz, $7::uuid))
            ORDER BY window_start DESC, event_id DESC LIMIT $8`,
          [
            orgId,
            from,
            to,
            f.meterId ?? null,
            f.resourceId?.toLowerCase() ?? null,
            cur?.w ?? null,
            cur?.e ?? null,
            f.limit + 1,
          ],
        )
      ).rows;
      const page = rows.slice(0, f.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r): UsageEventDto => ({
          eventId: r.event_id as string,
          meterId: r.meter_id as string,
          quantity: String(r.quantity),
          unit: r.unit as string,
          resourceId: (r.resource_id as string | null) ?? null,
          windowStart: (r.window_start as Date).toISOString(),
          windowEnd: (r.window_end as Date).toISOString(),
          occurredAt: (r.occurred_at as Date).toISOString(),
          receivedAt: (r.received_at as Date).toISOString(),
          source: r.source as string,
          dimensions: r.dimensions as Record<string, unknown>,
          dataRegion: r.data_region as string,
          late: r.late as boolean,
          skewFlag: r.skew_flag as boolean,
          adjustsEventId: (r.adjusts_event_id as string | null) ?? null,
        })),
        nextCursor:
          rows.length > f.limit && last
            ? enc({ w: (last.window_start as Date).toISOString(), e: last.event_id })
            : null,
      };
    });
  }
}
