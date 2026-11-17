import { v7 as uuidv7 } from 'uuid';
import { enqueue, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { dateOnly } from '../../../common/dates';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import { STAGES, stageIndex, type DunningPolicy, type DunningStage } from './dunning-policy';
import type { SubscriptionService } from './subscription.service';
import { daysBetween, todayUtc } from './subscription-period';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DunningDto {
  id: string;
  orgId: string;
  subscriptionId: string;
  invoiceId: string;
  stage: DunningStage;
  openedAt: string;
  daysOverdue: number;
  retriesDone: number;
  nextRetryInDays: number | null;
  hold: boolean;
  holdReason: string | null;
  closedAt: string | null;
  closedReason: 'paid' | 'subscription_cancelled' | null;
  policyVersion: number;
  version: number;
}
const daysSince = (r: Row, now: Date) =>
  Math.max(0, daysBetween(dateOnly(r.opened_at), todayUtc(now)));
const toDto = (r: Row, policy: DunningPolicy, now: Date): DunningDto => {
  const days = daysSince(r, now);
  const next = policy.retryAfterDays.find((d) => d > days);
  const closed = r.closed_at !== null;
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    subscriptionId: r.subscription_id as string,
    invoiceId: r.invoice_id as string,
    stage: r.stage as DunningStage,
    openedAt: (r.opened_at as Date).toISOString(),
    daysOverdue: days,
    retriesDone: r.retries_done as number,
    nextRetryInDays: closed || next === undefined ? null : next - days,
    hold: r.hold as boolean,
    holdReason: (r.hold_reason as string | null) ?? null,
    closedAt: r.closed_at ? (r.closed_at as Date).toISOString() : null,
    closedReason: (r.closed_reason as DunningDto['closedReason']) ?? null,
    policyVersion: r.policy_version as number,
    version: r.version as number,
  };
};

/** What a stage does. Notices go to the billing managers; the requests are OUTBOX EVENTS for the owning modules (M05+): billing deletes nothing. */
const STAGE_EFFECT: Record<
  Exclude<DunningStage, 'overdue'>,
  { notice: string; request: string | null }
> = {
  reminder_1: { notice: 'billing.dunning_reminder', request: null },
  reminder_2: { notice: 'billing.dunning_reminder', request: null },
  restricted: { notice: 'billing.dunning_restricted', request: 'dunning.restrict_requested' },
  suspended: { notice: 'billing.dunning_suspended', request: 'dunning.suspend_requested' },
  terminated_pending: { notice: 'billing.dunning_review', request: 'dunning.review_requested' },
};

export interface DunningRunResult {
  opened: number;
  retries: number;
  advanced: number;
  closed: number;
  failed: number;
}

/**
 * Dunning (docs/11 §2, §8; policy in spec/billing/dunning-policy.yaml). The rules that matter:
 *  - **A case per overdue subscription**, opened by the first run after a charge failed (one open case per subscription, enforced by the database).
 *  - **Retries are reconcile-before-retry** (the payment service's rule) and follow the policy's days; a missed day is consumed, not queued up.
 *  - **Stages move forward one at a time**, each atomically with its outbox request, so a scheduler that was down for weeks still produces every
 *    notice and request in order. Restriction makes the subscription `unpaid` and blocks NEW purchases only.
 *  - **Nothing is deleted, ever.** The last stage asks a human (owner review); billing never terminates anything.
 *  - **Any payment ends it:** a paid invoice closes the case and returns the subscription to `active`, audited.
 */
export class DunningService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly subs: Pick<
      SubscriptionService,
      'delinquent' | 'retryPayment' | 'settle' | 'markUnpaid' | 'cancelNow'
    >,
    readonly policy: DunningPolicy,
    private readonly notify: (
      orgId: string,
      kind: string,
      params: Record<string, unknown>,
    ) => Promise<void>,
  ) {}

  async run(now = new Date(), limit = 500): Promise<DunningRunResult> {
    const out: DunningRunResult = { opened: 0, retries: 0, advanced: 0, closed: 0, failed: 0 };
    const delinquent = await this.subs.delinquent(limit);
    for (const d of delinquent) {
      try {
        await this.handle(d, now, out);
      } catch {
        out.failed++;
      }
    }
    // cases whose subscription is no longer overdue (paid by the customer or the PSP webhook, or cancelled) are closed
    const open = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ id: string; org_id: string; status: string }>(
            `SELECT d.id, d.org_id, s.status FROM billing.dunning_cases d JOIN billing.subscriptions s ON s.id = d.subscription_id
              WHERE d.closed_at IS NULL AND s.status NOT IN ('past_due','unpaid') LIMIT $1`,
            [limit],
          )
        ).rows,
    );
    for (const o of open) {
      try {
        if (
          await this.close(
            o.org_id,
            o.id,
            o.status === 'cancelled' ? 'subscription_cancelled' : 'paid',
            now,
          )
        )
          out.closed++;
      } catch {
        out.failed++;
      }
    }
    return out;
  }

  private async openCase(orgId: string, subscriptionId: string): Promise<Row | undefined> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM billing.dunning_cases WHERE subscription_id = $1 AND closed_at IS NULL`,
            [subscriptionId],
          )
        ).rows[0],
    );
  }

  private async handle(
    d: {
      id: string;
      orgId: string;
      status: string;
      invoiceId: string | null;
      cancelRequested: boolean;
    },
    now: Date,
    out: DunningRunResult,
  ): Promise<void> {
    let kase = await this.openCase(d.orgId, d.id);
    if (!kase) {
      if (!d.invoiceId) return;
      const id = uuidv7();
      const inserted = await this.db.withOrg(d.orgId, async (c) => {
        const r = await c.query(
          `INSERT INTO billing.dunning_cases (id, org_id, subscription_id, invoice_id, policy_version, opened_at, stage_changed_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$6,$6) ON CONFLICT (subscription_id) WHERE closed_at IS NULL DO NOTHING`,
          [id, d.orgId, d.id, d.invoiceId, this.policy.version, now],
        );
        if (r.rowCount) {
          await enqueue(c, d.orgId, 'dunning.opened', {
            caseId: id,
            subscriptionId: d.id,
            invoiceId: d.invoiceId,
          });
          await this.audit.record({
            action: 'billing.dunning.opened',
            actorType: 'system',
            orgId: d.orgId,
            resource: { type: 'dunning_case', id },
            outcome: 'failure',
            after: {
              subscriptionId: d.id,
              invoiceId: d.invoiceId,
              policyVersion: this.policy.version,
            },
          });
        }
        return r.rowCount;
      });
      kase = await this.openCase(d.orgId, d.id);
      if (!kase) return;
      if (inserted) {
        out.opened++;
        await this.notify(d.orgId, 'billing.payment_failed', {
          subscriptionId: d.id,
          invoiceId: d.invoiceId,
        });
      }
    }
    const caseId = kase.id as string;

    if (d.cancelRequested) {
      if (await this.subs.cancelNow(d.orgId, d.id, now)) {
        if (await this.close(d.orgId, caseId, 'subscription_cancelled', now)) out.closed++;
      }
      return;
    }
    if (kase.hold) return; // finance paused this case: no retries, no new stage

    if (await this.subs.settle(d.orgId, d.id)) {
      if (await this.close(d.orgId, caseId, 'paid', now)) out.closed++;
      return;
    }

    const days = daysSince(kase, now);
    const due = this.policy.retryAfterDays.filter((x) => x <= days).length;
    if ((kase.retries_done as number) < due) {
      const outcome = await this.subs.retryPayment(d.orgId, d.id, now);
      out.retries++;
      await this.db.withOrg(d.orgId, (c) =>
        c.query(
          `UPDATE billing.dunning_cases SET retries_done = $2, last_retry_at = $3, updated_at = $3 WHERE id = $1 AND closed_at IS NULL`,
          [caseId, due, now],
        ),
      );
      await this.audit.record({
        action: 'billing.dunning.retry',
        actorType: 'system',
        orgId: d.orgId,
        resource: { type: 'dunning_case', id: caseId },
        outcome: outcome === 'succeeded' || outcome === 'recovered' ? 'success' : 'failure',
        detail: { outcome, retry: due },
      });
      if (outcome === 'succeeded' || outcome === 'recovered') {
        if (await this.close(d.orgId, caseId, 'paid', now)) out.closed++;
        return;
      }
    }

    // stages, one at a time and in order
    let cur = stageIndex((await this.openCase(d.orgId, d.id))!.stage as DunningStage);
    const target = Math.max(
      0,
      ...this.policy.stages.filter((s) => s.afterDays <= days).map((s) => stageIndex(s.stage)),
    );
    while (cur < target) {
      const next = STAGES[cur + 1]! as Exclude<DunningStage, 'overdue'>;
      const moved = await this.db.withOrg(d.orgId, async (c) => {
        const r = await c.query(
          `UPDATE billing.dunning_cases SET stage = $3, stage_changed_at = $4, updated_at = $4 WHERE id = $1 AND stage = $2 AND closed_at IS NULL`,
          [caseId, STAGES[cur], next, now],
        );
        if (!r.rowCount) return false;
        const eff = STAGE_EFFECT[next];
        if (eff.request)
          await enqueue(c, d.orgId, eff.request, {
            caseId,
            subscriptionId: d.id,
            invoiceId: d.invoiceId,
          });
        await this.audit.record({
          action: 'billing.dunning.stage_changed',
          actorType: 'system',
          orgId: d.orgId,
          resource: { type: 'dunning_case', id: caseId },
          outcome: 'success',
          after: { stage: next, daysOverdue: days },
        });
        return true;
      });
      if (!moved) break; // another run moved it
      out.advanced++;
      await this.notify(d.orgId, STAGE_EFFECT[next].notice, {
        subscriptionId: d.id,
        invoiceId: d.invoiceId,
        stage: next,
        daysOverdue: days,
      });
      cur++;
    }
    // restriction makes the subscription unpaid; repaired here if an earlier run stopped between the stage and this step
    if (cur >= stageIndex('restricted') && d.status === 'past_due')
      await this.subs.markUnpaid(d.orgId, d.id);
  }

  private async close(
    orgId: string,
    caseId: string,
    reason: 'paid' | 'subscription_cancelled',
    now: Date,
  ): Promise<boolean> {
    const done = await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE billing.dunning_cases SET closed_at = $2, closed_reason = $3, updated_at = $2 WHERE id = $1 AND closed_at IS NULL`,
        [caseId, now, reason],
      );
      if (r.rowCount) {
        await enqueue(c, orgId, 'dunning.closed', { caseId, reason });
        await this.audit.record({
          action: reason === 'paid' ? 'billing.dunning.recovered' : 'billing.dunning.closed',
          actorType: 'system',
          orgId,
          resource: { type: 'dunning_case', id: caseId },
          outcome: 'success',
          detail: { reason },
        });
      }
      return r.rowCount;
    });
    if (done && reason === 'paid')
      await this.notify(orgId, 'billing.payment_recovered', { caseId });
    return Boolean(done);
  }

  // ---- finance: list, hold, resume ------------------------------------------------------------------------------------

  async list(
    o: {
      limit: number;
      cursor?: string | undefined;
      orgId?: string | undefined;
      stage?: string | undefined;
      state?: string | undefined;
    },
    now = new Date(),
  ): Promise<Page<DunningDto>> {
    if (o.stage !== undefined && !(STAGES as readonly string[]).includes(o.stage))
      throw new ProblemException('validation_failed', `stage must be one of ${STAGES.join(', ')}`);
    if (o.state !== undefined && !['open', 'closed', 'all'].includes(o.state))
      throw new ProblemException('validation_failed', 'state must be open, closed or all');
    if (o.orgId !== undefined && !UUID.test(o.orgId))
      throw new ProblemException('validation_failed', 'org must be a uuid');
    const after = decodeCursor(o.cursor);
    const state = o.state ?? 'open';
    return this.db.withPlatformScope(async (c) => {
      const rows = (
        await c.query(
          `SELECT * FROM billing.dunning_cases WHERE ($1::uuid IS NULL OR org_id = $1::uuid) AND ($2::text IS NULL OR stage = $2)
             AND ($3 = 'all' OR ($3 = 'open' AND closed_at IS NULL) OR ($3 = 'closed' AND closed_at IS NOT NULL)) AND ($4::uuid IS NULL OR id < $4::uuid)
           ORDER BY id DESC LIMIT $5`,
          [o.orgId ?? null, o.stage ?? null, state, after, o.limit + 1],
        )
      ).rows;
      const p = pageOf(
        rows.map((r) => ({ id: r.id as string, r })),
        o.limit,
      );
      return { items: p.items.map((x) => toDto(x.r, this.policy, now)), nextCursor: p.nextCursor };
    });
  }

  /** Manual hold or resume (docs/04 PATCH /v1/admin/billing/dunning/{id}). A hold needs a reason; a closed case cannot be changed (409). */
  async setHold(
    actorUserId: string,
    id: string,
    input: Record<string, unknown>,
    now = new Date(),
  ): Promise<DunningDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    for (const k of Object.keys(input))
      if (k !== 'action' && k !== 'reason')
        throw new ProblemException('validation_failed', `unknown field ${k}`);
    if (input.action !== 'hold' && input.action !== 'resume')
      throw new ProblemException('validation_failed', "action must be 'hold' or 'resume'");
    if (
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 1 ||
      input.reason.length > 500
    )
      throw new ProblemException('validation_failed', 'reason must be 1..500 characters');
    const reason = input.reason.trim();
    const found = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ org_id: string }>(
            `SELECT org_id FROM billing.dunning_cases WHERE id = $1`,
            [id.toLowerCase()],
          )
        ).rows[0],
    );
    if (!found) throw new ProblemException('not_found');
    const hold = input.action === 'hold';
    const row = await this.db.withOrg(found.org_id, async (c) => {
      const cur = (
        await c.query(`SELECT * FROM billing.dunning_cases WHERE id = $1 FOR UPDATE`, [
          id.toLowerCase(),
        ])
      ).rows[0] as Row;
      if (cur.closed_at) throw new ProblemException('conflict', 'this dunning case is closed');
      if (cur.hold === hold) return cur; // nothing to change: idempotent
      const r = (
        await c.query(
          `UPDATE billing.dunning_cases SET hold = $2, hold_reason = $3, held_by = $4, updated_at = $5 WHERE id = $1 RETURNING *`,
          [id.toLowerCase(), hold, hold ? reason : null, hold ? actorUserId : null, now],
        )
      ).rows[0] as Row;
      await this.audit.record({
        action: hold ? 'billing.dunning.held' : 'billing.dunning.resumed',
        actorUserId,
        orgId: found.org_id,
        resource: { type: 'dunning_case', id },
        outcome: 'success',
        detail: { reason },
      });
      return r;
    });
    return toDto(row, this.policy, now);
  }

  /** New purchases are refused (402) while a case is at `restricted` or beyond. Everything already bought keeps working. */
  async assertNotRestricted(orgId: string): Promise<void> {
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT stage FROM billing.dunning_cases WHERE org_id = $1 AND closed_at IS NULL AND stage IN ('restricted','suspended','terminated_pending') LIMIT 1`,
            [orgId],
          )
        ).rows[0],
    );
    if (r)
      throw new ProblemException(
        'account_restricted',
        'new purchases are blocked until the overdue invoice is paid',
      );
  }
}
