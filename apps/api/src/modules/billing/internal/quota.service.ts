import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';

export interface QuotaItem {
  meterGroup: string;
  /** The meter that measures the group; null = the group is not measured yet (reported, never silently "ok"). */
  meterId: string | null;
  unit: string | null;
  limit: string | null;
  used: string;
  mode: 'soft' | 'hard';
  state: 'ok' | 'soft' | 'hard';
  percent: number | null;
  measured: boolean;
}
export interface QuotaReport {
  periodStart: string;
  items: QuotaItem[];
  /** True when at least one hard quota is exhausted: NEW consumption of that group is refused, nothing is deleted. */
  restricted: boolean;
}
export interface QuotaCheck {
  allowed: boolean;
  state: 'ok' | 'soft' | 'hard';
  limit: string | null;
  used: string;
  projectedUsed: string;
  measured: boolean;
}

/** Called after a threshold is crossed (80 / 100 %); delivers the notification. Failures never fail the caller. */
export type ThresholdNotifier = (n: {
  orgId: string;
  meterGroup: string;
  threshold: 80 | 100;
  state: 'soft' | 'hard';
}) => Promise<void>;

const QTY = /^\d{1,16}(?:\.\d{1,8})?$/;
const GROUP = /^[a-z][a-z0-9_]*$/;
const num = (v: unknown) => (v === null || v === undefined ? null : String(v));

/**
 * Quota evaluation (docs/12 §7). The state lives in `billing.quotas` (a rebuildable projection of usage aggregates
 * against the effective entitlement limits). Soft quotas notify at 80/100 %; hard quotas additionally refuse NEW
 * consumption through `assertAllowed` (callers: quotes, resource creation workers). Nothing is ever deleted.
 */
export class QuotaService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly notify: ThresholdNotifier = async () => undefined,
    private readonly log: (m: string, x?: Record<string, unknown>) => void = (m, x) =>
      process.stderr.write(JSON.stringify({ quota: m, ...x }) + '\n'),
  ) {}

  /**
   * Recompute the organization's quota state for the month containing `now`, announce each newly crossed threshold
   * exactly once (audit in the same transaction, notification after commit) and return the report.
   */
  async evaluate(orgId: string, now: Date = new Date()): Promise<QuotaReport> {
    const crossings: { meterGroup: string; threshold: 80 | 100; state: 'soft' | 'hard' }[] = [];
    const report = await this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query<{
          meter_group: string;
          period_start: Date;
          meter_id: string | null;
          limit_value: string | null;
          mode: 'soft' | 'hard';
          used: string;
          state: 'ok' | 'soft' | 'hard';
          crossed: number;
          unit: string | null;
        }>(
          `SELECT q.*, m.unit FROM billing.evaluate_quotas($1, $2) q
             LEFT JOIN metering.meters m ON m.id = q.meter_id ORDER BY q.meter_group`,
          [orgId, now],
        )
      ).rows;
      for (const r of rows) {
        if (r.crossed === 80 || r.crossed === 100) {
          crossings.push({
            meterGroup: r.meter_group,
            threshold: r.crossed,
            state: r.state === 'hard' ? 'hard' : 'soft',
          });
          await this.audit.record({
            action: 'billing.quota.threshold_crossed',
            actorType: 'system',
            orgId,
            resource: { type: 'quota', id: r.meter_group },
            outcome: 'success',
            after: {
              threshold: r.crossed,
              state: r.state,
              used: String(r.used),
              limit: num(r.limit_value),
            },
          });
        }
      }
      const items: QuotaItem[] = rows.map((r) => {
        const limit = num(r.limit_value);
        const measured = r.meter_id !== null;
        return {
          meterGroup: r.meter_group,
          meterId: r.meter_id,
          unit: r.unit,
          limit,
          used: String(r.used),
          mode: r.mode,
          state: r.state,
          percent:
            !measured || limit === null
              ? null
              : Number(limit) === 0
                ? r.state === 'ok'
                  ? 0
                  : 100
                : Math.min(1000, Math.round((Number(r.used) / Number(limit)) * 100)),
          measured,
        };
      });
      return {
        // the SQL month is the UTC month of `now` (a pg date column would come back as local midnight; see common/dates.ts)
        periodStart: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`,
        items,
        restricted: items.some((i) => i.state === 'hard'),
      };
    });
    for (const x of crossings) {
      try {
        await this.notify({ orgId, ...x });
      } catch (e) {
        this.log('threshold_notification_failed', {
          orgId,
          group: x.meterGroup,
          error: (e as Error).message,
        });
      }
    }
    return report;
  }

  /**
   * Would consuming `projected` more units of the group stay within its limit? Hard quotas deny when the projected
   * total exceeds the limit or the group is already restricted; soft quotas always allow (and have notified).
   */
  async check(
    orgId: string,
    meterGroup: string,
    projected: string,
    now = new Date(),
  ): Promise<QuotaCheck> {
    if (!GROUP.test(meterGroup))
      throw new ProblemException('validation_failed', 'invalid meter group');
    if (!QTY.test(projected))
      throw new ProblemException(
        'validation_failed',
        'projected must be a non-negative decimal string',
      );
    const rep = await this.evaluate(orgId, now);
    const item = rep.items.find((i) => i.meterGroup === meterGroup);
    if (!item)
      return {
        allowed: true,
        state: 'ok',
        limit: null,
        used: '0',
        projectedUsed: projected,
        measured: false,
      };
    const projectedUsed = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query<{ v: string }>(`SELECT ($1::numeric + $2::numeric)::text AS v`, [
            item.used,
            projected,
          ])
        ).rows[0]!.v,
    );
    const over =
      item.limit !== null && item.measured && Number(projected) > 0
        ? await this.db.withOrg(
            orgId,
            async (c) =>
              (
                await c.query<{ o: boolean }>(
                  `SELECT ($1::numeric + $2::numeric) > $3::numeric AS o`,
                  [item.used, projected, item.limit],
                )
              ).rows[0]!.o,
          )
        : false;
    const blocked =
      item.mode === 'hard' && Number(projected) > 0 && (item.state === 'hard' || over);
    return {
      allowed: !blocked,
      state: item.state,
      limit: item.limit,
      used: item.used,
      projectedUsed,
      measured: item.measured,
    };
  }

  /** Throws `quota_exceeded` (422) when a hard quota forbids the new consumption. */
  async assertAllowed(
    orgId: string,
    meterGroup: string,
    projected: string,
    now = new Date(),
  ): Promise<QuotaCheck> {
    const r = await this.check(orgId, meterGroup, projected, now);
    if (!r.allowed)
      throw new ProblemException(
        'quota_exceeded',
        `the ${meterGroup} quota (${r.limit}) would be exceeded; new consumption is blocked, existing resources are untouched`,
      );
    return r;
  }
}
