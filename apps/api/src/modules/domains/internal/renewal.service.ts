import type { Db } from '@nuzm/platform';
import { emitUsage, usageEventId } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { QuoteService } from '../../commerce';
import type { SpendService } from '../../billing';
import type { Row } from './common';
import type { DomainOrderService } from './orders.service';

export const REMINDER_DAYS = [60, 30, 7, 1] as const;
export interface JobDeps {
  db: Db;
  audit: AuditSink;
  quotes: QuoteService;
  spend: SpendService;
  orders: DomainOrderService;
  notify: (orgId: string, kind: string, params: Record<string, unknown>) => Promise<void>;
  /** Auto-renew starts this many days before expiry (proposal 30). */
  autoRenewDays?: number;
}
export interface DailyResult {
  reminders: number;
  autoRenewals: number;
  approvalsRequested: number;
  atRisk: number;
  zoneAccruals: number;
}

/**
 * Renewal and accrual jobs (M07 S31 task 2). Reminders at 60/30/7/1 days go through notifications, once per (domain, threshold, expiry). Auto-renew quotes the
 * renewal; above the spend limit it asks for a spend approval (M02) instead of ordering, otherwise it orders within the standing limit. A failed payment
 * (402) flags the domain `renewal_at_risk` and notifies with the dunning link (M03). Everything is idempotent per day: re-running changes nothing.
 */
export class DomainJobs {
  constructor(private readonly d: JobDeps) {}

  async runDaily(now = new Date()): Promise<DailyResult> {
    const out: DailyResult = {
      reminders: 0,
      autoRenewals: 0,
      approvalsRequested: 0,
      atRisk: 0,
      zoneAccruals: 0,
    };
    const doms = await this.d.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, name, expires_at, auto_renew, state, created_by FROM domains.domains WHERE state IN ('active','renewal_at_risk') AND expires_at IS NOT NULL AND expires_at < $1::timestamptz + interval '61 days' ORDER BY expires_at`,
            [now],
          )
        ).rows as Row[],
    );
    for (const dom of doms) {
      const orgId = dom.org_id as string;
      const expires = dom.expires_at as Date;
      const days = Math.ceil((expires.getTime() - now.getTime()) / 86_400_000);
      const threshold = REMINDER_DAYS.filter((t) => days <= t).sort((a, b) => a - b)[0];
      if (
        threshold !== undefined &&
        (await this.firstTime(
          orgId,
          'domain.renewal.reminder',
          dom.id as string,
          `${threshold}|${expires.toISOString()}`,
        ))
      ) {
        await this.d.notify(orgId, 'domain.renewal_reminder', {
          name: dom.name,
          days: threshold,
          expiresAt: expires.toISOString(),
        });
        await this.d.audit.record({
          action: 'domain.renewal.reminder',
          orgId,
          resource: { type: 'domain', id: dom.id as string },
          outcome: 'success',
          detail: {
            threshold,
            expiresAt: expires.toISOString(),
            key: `${threshold}|${expires.toISOString()}`,
          },
        });
        out.reminders++;
      }
      if (dom.auto_renew && days <= (this.d.autoRenewDays ?? 30))
        await this.autoRenew(dom, now, out);
    }
    out.zoneAccruals = await this.accrueZoneMonths(now);
    return out;
  }
  private get autoRenewDays() {
    return this.d.autoRenewDays ?? 30;
  }

  private async firstTime(
    orgId: string,
    action: string,
    resourceId: string,
    key: string,
  ): Promise<boolean> {
    return this.d.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM audit.audit_logs WHERE org_id=$1 AND action=$2 AND resource_id=$3 AND detail->>'key' = $4 LIMIT 1`,
            [orgId, action, resourceId, key],
          )
        ).rowCount === 0,
    );
  }

  private async autoRenew(dom: Row, now: Date, out: DailyResult) {
    const orgId = dom.org_id as string;
    const actor = dom.created_by as string | null;
    if (!actor) return;
    const expires = (dom.expires_at as Date).toISOString();
    // one renewal attempt per expiry cycle and day: an order exists, or an approval was already requested today
    const open = await this.d.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM domains.domain_orders WHERE domain_id=$1 AND type='renewal' AND state NOT IN ('failed','cancelled') AND created_at > $2::timestamptz - interval '40 days' LIMIT 1`,
            [dom.id, now],
          )
        ).rowCount,
    );
    if (open) return;
    if (
      !(await this.firstTime(
        orgId,
        'domain.renewal.auto_attempt',
        dom.id as string,
        `${expires}|${now.toISOString().slice(0, 10)}`,
      ))
    )
      return;
    await this.d.audit.record({
      action: 'domain.renewal.auto_attempt',
      orgId,
      resource: { type: 'domain', id: dom.id as string },
      outcome: 'success',
      detail: { key: `${expires}|${now.toISOString().slice(0, 10)}` },
    });
    try {
      const q = await this.d.quotes.create(
        orgId,
        actor,
        { kind: 'domain', items: [{ name: dom.name, years: 1, action: 'renew' }] },
        now,
      );
      if (q.requiresApproval) {
        await this.d.spend.request(
          orgId,
          actor,
          {
            quoteId: q.id,
            amount: q.totalMinor,
            currency: q.currency,
            reason: `Auto-renewal of ${String(dom.name)}`,
          },
          now,
        );
        await this.d.notify(orgId, 'domain.renewal_approval_needed', { name: dom.name });
        await this.d.audit.record({
          action: 'domain.renewal.approval_requested',
          orgId,
          resource: { type: 'domain', id: dom.id as string },
          outcome: 'success',
          detail: { quoteId: q.id },
        });
        out.approvalsRequested++;
        return;
      }
      await this.d.orders.createRenewal(
        orgId,
        actor,
        dom.id as string,
        { quoteId: q.id, years: 1 },
        'auto-renew',
      );
      out.autoRenewals++;
    } catch (e) {
      if (
        e instanceof ProblemException &&
        (e.code === 'payment_required' ||
          e.code === 'account_restricted' ||
          e.code === 'insufficient_funds')
      ) {
        await this.d.db.withOrg(orgId, (c) =>
          c.query(
            `UPDATE domains.domains SET state='renewal_at_risk', version=version+1, updated_at=now() WHERE id=$1 AND state='active'`,
            [dom.id],
          ),
        );
        await this.d.notify(orgId, 'domain.renewal_payment_failed', {
          name: dom.name,
          dunningLink: '/billing/overdue',
        });
        await this.d.audit.record({
          action: 'domain.renewal.payment_failed',
          orgId,
          resource: { type: 'domain', id: dom.id as string },
          outcome: 'failure',
          detail: { code: e.code },
        });
        out.atRisk++;
        return;
      }
      await this.d.audit.record({
        action: 'domain.renewal.auto_failed',
        orgId,
        resource: { type: 'domain', id: dom.id as string },
        outcome: 'failure',
        detail: { code: e instanceof ProblemException ? e.code : 'internal_error' },
      });
    }
  }

  /** `dns.zone_months`: one event per active zone per day, 1/30 of a zone-month (proposal). The event id is deterministic per (zone, day): a re-run emits nothing new. */
  async accrueZoneMonths(now: Date): Promise<number> {
    const day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    const zones = await this.d.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id FROM domains.dns_zones WHERE state IN ('active','degraded')`,
          )
        ).rows as Row[],
    );
    let n = 0;
    for (const z of zones)
      await this.d.db.withOrg(z.org_id as string, async (c) => {
        const eventId = usageEventId({
          orgId: z.org_id as string,
          meterId: 'dns.zone_months',
          resourceId: z.id as string,
          windowStart: day,
        });
        const dup = (
          await c.query(
            `SELECT 1 FROM platform.outbox WHERE topic='usage.recorded' AND payload->>'eventId' = $1 LIMIT 1`,
            [eventId],
          )
        ).rowCount;
        if (dup) return;
        await emitUsage(c, {
          eventId,
          orgId: z.org_id as string,
          meterId: 'dns.zone_months',
          quantity: '0.03333333',
          unit: 'zone_month',
          resourceId: z.id as string,
          windowStart: day,
          windowEnd: new Date(Date.parse(day) + 86_400_000).toISOString(),
          occurredAt: now.toISOString(),
          dimensions: {},
          dataRegion: 'sa-pending',
          source: 'domains@M07',
        });
        n++;
      });
    return n;
  }
}
