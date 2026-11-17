import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import { enqueue, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { dateOnly } from '../../../common/dates';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import { parseDec, rateSegment, type Rounding } from '../../../common/rating';
import type { EntitlementService } from './entitlement.service';
import type { PriceBookService } from './price-book.service';
import { prorate, type Proration } from './proration';
import { addDays, nextPeriodEnd, parseYmd, todayUtc } from './subscription-period';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'unpaid' | 'cancelled';
const STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'unpaid', 'cancelled'];
const MAX_CATCH_UP = 24; // periods a single run may bill when the scheduler was down for a long time

/** What the subscription needs from other modules. Defined here (structurally) so billing never imports invoicing/payments. */
export interface SubscriptionPorts {
  invoices: {
    issueCharge(
      orgId: string,
      input: {
        sourceKey: string;
        currency: string;
        periodStart: string;
        periodEnd: string;
        lines: {
          description: string;
          quantity: string;
          unit: string;
          netMinor: string;
          meterId: string | null;
          sourceId: string;
        }[];
      },
      actorUserId: string | null,
      now: Date,
    ): Promise<{ id: string; status: string }>;
    status(orgId: string, invoiceId: string): Promise<string>;
  };
  payments: {
    pay(
      orgId: string,
      actorUserId: string,
      p: { invoiceId: string; paymentMethodId: string },
      now: Date,
    ): Promise<{
      status: 'succeeded' | 'failed' | 'requires_action' | 'processing';
      failureCode: string | null;
    }>;
  };
  methods: { assertUsable(orgId: string, paymentMethodId: string): Promise<void> };
}

/** The priced snapshot of one recurring charge. Prices are never recomputed from the book while the subscription runs. */
export interface SubscriptionItem {
  kind: 'plan_fee';
  planKey: string;
  meterId: string;
  unitPriceMinor: string;
  rounding: Rounding;
  priceBookVersionId: string;
}
interface PendingInvoice {
  key: string;
  periodStart: string;
  periodEnd: string; // inclusive
  lines: {
    description: string;
    quantity: string;
    unit: string;
    netMinor: string;
    meterId: string | null;
    sourceId: string;
  }[];
}

export interface SubscriptionDto {
  id: string;
  planVersionId: string;
  planKey: string;
  status: SubscriptionStatus;
  currency: string;
  quantity: number;
  paymentMethodId: string;
  amountPerPeriodMinor: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  pendingCreditMinor: string;
  latestInvoiceId: string | null;
  version: number;
  createdAt: string;
}
export interface ChangePreview {
  effect: 'charge' | 'credit' | 'none';
  prorationMode: 'prorate' | 'none';
  currency: string;
  oldAmountPerPeriodMinor: string;
  newAmountPerPeriodMinor: string;
  daysLeft: number | null;
  daysTotal: number | null;
  unusedCreditMinor: string;
  newChargeMinor: string;
  /** Positive: invoiced now (tax is added on the invoice). Negative: credited against the next renewal. */
  netMinor: string;
  effectiveDate: string;
}

const toDto = (r: Row, planKey: string): SubscriptionDto => ({
  id: r.id as string,
  planVersionId: r.plan_version_id as string,
  planKey,
  status: r.status as SubscriptionStatus,
  currency: (r.currency as string).trim(),
  quantity: r.quantity as number,
  paymentMethodId: r.payment_method_id as string,
  amountPerPeriodMinor: amountOf(r.items as SubscriptionItem[], r.quantity as number).toString(),
  currentPeriodStart: dateOnly(r.period_start),
  currentPeriodEnd: dateOnly(r.period_end),
  trialEnd: r.trial_end ? dateOnly(r.trial_end) : null,
  cancelAtPeriodEnd: r.cancel_at_period_end as boolean,
  cancelledAt: r.cancelled_at ? (r.cancelled_at as Date).toISOString() : null,
  pendingCreditMinor: String(r.pending_credit_minor),
  latestInvoiceId: (r.last_invoice_id as string | null) ?? null,
  version: r.version as number,
  createdAt: (r.created_at as Date).toISOString(),
});

/** Amount of one full period under the snapshot: Σ price × quantity, each with the item's own rounding (exact decimals, no floats). */
export function amountOf(items: SubscriptionItem[], quantity: number): bigint {
  let total = 0n;
  for (const i of items)
    total += rateSegment(parseDec(String(quantity)), {
      model: 'flat',
      unitPrice: parseDec(i.unitPriceMinor),
      allowance: 0n,
      rounding: i.rounding,
    }).amountMinor;
  return total;
}
/** The meter that carries a plan's recurring fee in the price book (convention until the owner adds an explicit plan fee, see S10b report). */
export const planFeeMeter = (planKey: string) => `plan.${planKey.replace(/-/g, '_')}_months`;

export interface SubscriptionPolicy {
  trialDays: number;
  /** Production profiles refuse the DRAFT-NOT-APPROVED placeholder price book (HG-02-01). */
  production: () => boolean;
}
export const subscriptionPolicyFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): Omit<SubscriptionPolicy, 'production'> => {
  const trialDays = Number(env.SUBSCRIPTION_TRIAL_DAYS ?? 0);
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90)
    throw new Error('SUBSCRIPTION_TRIAL_DAYS must be an integer 0..90');
  return { trialDays };
};

/**
 * Subscriptions (docs/11 §2, docs/05 rule 2). The rules that matter:
 *  - **Priced snapshot:** the plan fee is read from the price book when the plan is set and then frozen in `items`.
 *  - **Invoice intent in the same transaction as the state change:** a renewal advances the period (compare-and-set) AND records
 *    `pending_invoice` atomically; issuing the invoice is idempotent by its source key and the payment is reconcile-before-retry, so a
 *    crash anywhere is repaired by the next run: never a lost period, never two invoices for one.
 *  - **No access without payment:** the plan is written to the entitlements when the first charge succeeds (or a trial starts).
 *  - **No invented prices:** a plan with no flat fee in the price book cannot be subscribed to.
 */
export class SubscriptionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly prices: Pick<PriceBookService, 'resolveForRating'>,
    private readonly entitlements: Pick<EntitlementService, 'assignPlan' | 'assignDefaultPlan'>,
    private readonly ports: SubscriptionPorts,
    private readonly policy: SubscriptionPolicy,
  ) {}

  // ---- pricing ------------------------------------------------------------------------------------------------------

  private async plan(c: PoolClient, planVersionId: string) {
    const v = (
      await c.query(
        `SELECT v.id, v.status, v.currency, p.key, p.status AS plan_status FROM billing.plan_versions v JOIN billing.plans p ON p.id = v.plan_id WHERE v.id = $1`,
        [planVersionId],
      )
    ).rows[0];
    if (!v) throw new ProblemException('not_found', 'plan version not found');
    if (v.status !== 'published' || v.plan_status !== 'active')
      throw new ProblemException(
        'conflict',
        'only a published version of an active plan can be subscribed to',
      );
    return { key: v.key as string, currency: (v.currency as string).trim() };
  }

  private async snapshot(orgId: string, planVersionId: string, now: Date) {
    return this.db.withOrg(orgId, async (c) => {
      const plan = await this.plan(c, planVersionId);
      const book = await this.prices.resolveForRating(c, plan.currency, {
        production: this.policy.production(),
      });
      const version = [...book.versions]
        .filter((v) => Date.parse(v.effectiveFrom) <= now.getTime())
        .pop();
      const meterId = planFeeMeter(plan.key);
      const item = version?.items.find((i) => i.meterId === meterId);
      if (!version || !item)
        throw new ProblemException(
          'validation_failed',
          `no price is configured for plan '${plan.key}'; it cannot be subscribed to yet`,
        );
      if (
        item.tierModel !== 'flat' ||
        item.unitPriceMinor === null ||
        parseDec(item.includedAllowance) !== 0n
      )
        throw new ProblemException(
          'validation_failed',
          `the fee of plan '${plan.key}' must be a flat price without allowance`,
        );
      const snap: SubscriptionItem = {
        kind: 'plan_fee',
        planKey: plan.key,
        meterId,
        unitPriceMinor: item.unitPriceMinor,
        rounding: item.rounding,
        priceBookVersionId: version.id,
      };
      return { items: [snap], currency: plan.currency, planKey: plan.key };
    });
  }

  private charge(
    sub: { id: string; items: SubscriptionItem[]; quantity: number },
    start: string,
    endExclusive: string,
    net: bigint,
    credit: bigint,
  ): PendingInvoice {
    const planKey = sub.items[0]!.planKey;
    return {
      key: `subscription:${sub.id}:${start}`,
      periodStart: start,
      periodEnd: addDays(endExclusive, -1),
      lines: [
        {
          description: `Subscription ${planKey} × ${sub.quantity}, ${start} to ${addDays(endExclusive, -1)}${credit > 0n ? ` (after ${credit.toString()} credit)` : ''}`,
          quantity: '1',
          unit: 'subscription_period',
          netMinor: net.toString(),
          meterId: sub.items[0]!.meterId,
          sourceId: `subscription:${sub.id}:${start}`,
        },
      ],
    };
  }

  // ---- create -------------------------------------------------------------------------------------------------------

  async create(
    orgId: string,
    actorUserId: string,
    input: Record<string, unknown>,
    now = new Date(),
  ): Promise<SubscriptionDto> {
    if (typeof input.planVersionId !== 'string' || !UUID.test(input.planVersionId))
      throw new ProblemException('validation_failed', 'planVersionId must be a uuid');
    if (input.paymentMethodId === undefined || input.paymentMethodId === null)
      throw new ProblemException(
        'payment_method_required',
        'a payment method is required to subscribe',
      );
    if (typeof input.paymentMethodId !== 'string' || !UUID.test(input.paymentMethodId))
      throw new ProblemException('validation_failed', 'paymentMethodId must be a uuid');
    const quantity = input.quantity ?? 1;
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 1000
    )
      throw new ProblemException('validation_failed', 'quantity must be an integer 1..1000');
    await this.ports.methods.assertUsable(orgId, input.paymentMethodId.toLowerCase());
    const snap = await this.snapshot(orgId, input.planVersionId.toLowerCase(), now);
    const amount = amountOf(snap.items, quantity);
    if (amount <= 0n)
      throw new ProblemException('validation_failed', 'the plan fee must be greater than zero');

    const today = todayUtc(now);
    const id = uuidv7();
    try {
      await this.db.withOrg(orgId, async (c) => {
        // a trial is offered once per organization
        const had = (
          await c.query(`SELECT 1 FROM billing.subscriptions WHERE org_id = $1 LIMIT 1`, [orgId])
        ).rowCount;
        const trialDays = had ? 0 : this.policy.trialDays;
        const trialEnd = trialDays > 0 ? addDays(today, trialDays) : null;
        const start = today;
        const anchorDay = parseYmd(trialEnd ?? today).d;
        const end = trialEnd ?? nextPeriodEnd(start, anchorDay);
        const pending = trialEnd
          ? null
          : this.charge({ id, items: snap.items, quantity }, start, end, amount, 0n);
        await c.query(
          `INSERT INTO billing.subscriptions (id, org_id, plan_version_id, currency, status, items, quantity, payment_method_id, anchor_day, period_start, period_end, trial_end, pending_invoice, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
          [
            id,
            orgId,
            input.planVersionId!.toString().toLowerCase(),
            snap.currency,
            trialEnd ? 'trialing' : 'active',
            JSON.stringify(snap.items),
            quantity,
            (input.paymentMethodId as string).toLowerCase(),
            anchorDay,
            start,
            end,
            trialEnd,
            pending ? JSON.stringify(pending) : null,
            actorUserId,
            now,
          ],
        );
        await enqueue(c, orgId, 'subscription.created', {
          subscriptionId: id,
          planKey: snap.planKey,
          status: trialEnd ? 'trialing' : 'active',
        });
        await this.audit.record({
          action: 'billing.subscription.created',
          actorUserId,
          orgId,
          resource: { type: 'subscription', id },
          outcome: 'success',
          after: {
            planKey: snap.planKey,
            quantity,
            amountPerPeriodMinor: amount.toString(),
            currency: snap.currency,
            trialEnd,
          },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException(
          'conflict',
          'this organization already has a subscription; change or cancel it instead',
        );
      throw e;
    }
    await this.afterCreate(orgId, id, now);
    return this.get(orgId, id);
  }

  private async afterCreate(orgId: string, id: string, now: Date) {
    const sub = await this.load(orgId, id);
    if (sub.status === 'trialing') await this.ensureEntitlement(orgId, id);
    else await this.bill(orgId, id, now);
  }

  // ---- billing (issue + pay, repairable) -------------------------------------------------------------------------------

  /** Issue the pending invoice (idempotent) and take payment; record the outcome. Safe to call any number of times. */
  async bill(orgId: string, id: string, now = new Date()): Promise<void> {
    const sub = await this.load(orgId, id);
    const pi = sub.pending_invoice as PendingInvoice | null;
    if (!pi || sub.status === 'cancelled') return;
    const inv = await this.ports.invoices.issueCharge(
      orgId,
      {
        sourceKey: pi.key,
        currency: (sub.currency as string).trim(),
        periodStart: pi.periodStart,
        periodEnd: pi.periodEnd,
        lines: pi.lines,
      },
      (sub.created_by as string | null) ?? null,
      now,
    );
    let outcome: 'succeeded' | 'failed' | 'requires_action' | 'processing';
    if (inv.status === 'paid') outcome = 'succeeded';
    else {
      try {
        outcome = (
          await this.ports.payments.pay(
            orgId,
            (sub.created_by as string | null) ?? '',
            { invoiceId: inv.id, paymentMethodId: sub.payment_method_id as string },
            now,
          )
        ).status;
      } catch (e) {
        if (!(e instanceof ProblemException)) throw e; // an unexpected fault: keep the pending invoice and retry next run
        outcome = 'failed'; // the method is gone or unusable: the customer must act
      }
    }
    await this.db.withOrg(orgId, async (c) => {
      const cur = (
        await c.query(`SELECT * FROM billing.subscriptions WHERE id = $1 FOR UPDATE`, [id])
      ).rows[0] as Row;
      const stillPending = (cur.pending_invoice as PendingInvoice | null)?.key === pi.key;
      const next: SubscriptionStatus =
        outcome === 'succeeded'
          ? cur.status === 'cancelled'
            ? 'cancelled'
            : 'active'
          : outcome === 'processing'
            ? (cur.status as SubscriptionStatus)
            : cur.status === 'trialing' || cur.status === 'active'
              ? 'past_due'
              : (cur.status as SubscriptionStatus);
      if (!stillPending && next === cur.status && cur.last_invoice_id === inv.id) return; // already recorded by an earlier run
      await c.query(
        `UPDATE billing.subscriptions SET pending_invoice = NULL, last_invoice_id = $2, status = $3, updated_at = now() WHERE id = $1`,
        [id, inv.id, next],
      );
      if (next !== cur.status) {
        await enqueue(
          c,
          orgId,
          next === 'past_due' ? 'subscription.past_due' : 'subscription.activated',
          { subscriptionId: id, invoiceId: inv.id },
        );
        await this.audit.record({
          action:
            next === 'past_due'
              ? 'billing.subscription.past_due'
              : 'billing.subscription.activated',
          actorType: 'system',
          orgId,
          resource: { type: 'subscription', id },
          outcome: next === 'past_due' ? 'failure' : 'success',
          detail: { invoiceId: inv.id, paymentOutcome: outcome },
        });
      }
    });
    if (outcome === 'succeeded') await this.ensureEntitlement(orgId, id);
  }

  /** past_due → active once the invoice that failed has been paid (by the customer, the PSP webhook or a retry). */
  async settle(orgId: string, id: string): Promise<boolean> {
    const sub = await this.load(orgId, id);
    if (sub.status !== 'past_due' || !sub.last_invoice_id) return false;
    if ((await this.ports.invoices.status(orgId, sub.last_invoice_id as string)) !== 'paid')
      return false;
    const done = await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE billing.subscriptions SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'past_due'`,
        [id],
      );
      if (r.rowCount) {
        await enqueue(c, orgId, 'subscription.activated', {
          subscriptionId: id,
          invoiceId: sub.last_invoice_id,
        });
        await this.audit.record({
          action: 'billing.subscription.recovered',
          actorType: 'system',
          orgId,
          resource: { type: 'subscription', id },
          outcome: 'success',
        });
      }
      return r.rowCount;
    });
    if (done) await this.ensureEntitlement(orgId, id);
    return Boolean(done);
  }

  private async ensureEntitlement(orgId: string, id: string): Promise<void> {
    const sub = await this.load(orgId, id);
    if (sub.status !== 'trialing' && sub.status !== 'active') return;
    if (sub.assigned_plan_version_id === sub.plan_version_id) return;
    await this.entitlements.assignPlan(
      orgId,
      sub.plan_version_id as string,
      (sub.created_by as string | null) ?? undefined,
    );
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE billing.subscriptions SET assigned_plan_version_id = plan_version_id, updated_at = now() WHERE id = $1 AND status IN ('trialing','active')`,
        [id],
      ),
    );
  }

  // ---- renewal ------------------------------------------------------------------------------------------------------

  /**
   * Advance every period that has ended (up to MAX_CATCH_UP) and bill each one; cancel at period end when asked. Idempotent: a second call
   * for the same day does nothing, and concurrent calls cannot both advance the same period (compare-and-set on the period end).
   */
  async renew(
    orgId: string,
    id: string,
    now = new Date(),
  ): Promise<{ periodsBilled: number; cancelled: boolean }> {
    const today = todayUtc(now);
    let periodsBilled = 0;
    for (let i = 0; i < MAX_CATCH_UP; i++) {
      const sub = await this.load(orgId, id);
      if (sub.status !== 'trialing' && sub.status !== 'active') break;
      if (sub.pending_invoice) {
        await this.bill(orgId, id, now); // repair first: an earlier run advanced the period and did not finish billing it
        if ((await this.load(orgId, id)).pending_invoice) break;
        continue;
      }
      if (dateOnly(sub.period_end) > today) break;
      if (sub.cancel_at_period_end) {
        const done = await this.db.withOrg(orgId, async (c) => {
          const r = await c.query(
            `UPDATE billing.subscriptions SET status = 'cancelled', cancelled_at = $3, cancel_reason = coalesce(cancel_reason, 'cancel_at_period_end'), updated_at = now() WHERE id = $1 AND period_end = $2 AND status IN ('trialing','active')`,
            [id, sub.period_end, now],
          );
          if (r.rowCount) {
            await enqueue(c, orgId, 'subscription.cancelled', { subscriptionId: id });
            await this.audit.record({
              action: 'billing.subscription.cancelled',
              actorType: 'system',
              orgId,
              resource: { type: 'subscription', id },
              outcome: 'success',
              detail: { reason: 'cancel_at_period_end' },
            });
          }
          return r.rowCount;
        });
        if (done) await this.entitlements.assignDefaultPlan(orgId);
        return { periodsBilled, cancelled: Boolean(done) };
      }
      const items = sub.items as SubscriptionItem[];
      const start = dateOnly(sub.period_end);
      const end = nextPeriodEnd(start, sub.anchor_day as number);
      const amount = amountOf(items, sub.quantity as number);
      const credit =
        BigInt(sub.pending_credit_minor as string) < amount
          ? BigInt(sub.pending_credit_minor as string)
          : amount;
      const net = amount - credit;
      const pending =
        net > 0n
          ? this.charge({ id, items, quantity: sub.quantity as number }, start, end, net, credit)
          : null;
      const advanced = await this.db.withOrg(orgId, async (c) => {
        const r = await c.query(
          `UPDATE billing.subscriptions SET period_start = $3, period_end = $4, trial_end = NULL, pending_credit_minor = pending_credit_minor - $5, pending_invoice = $6, updated_at = now() WHERE id = $1 AND period_end = $2 AND status IN ('trialing','active') AND pending_invoice IS NULL`,
          [
            id,
            sub.period_end,
            start,
            end,
            credit.toString(),
            pending ? JSON.stringify(pending) : null,
          ],
        );
        if (r.rowCount) {
          await enqueue(c, orgId, 'subscription.renewed', {
            subscriptionId: id,
            periodStart: start,
            periodEnd: end,
          });
          await this.audit.record({
            action: 'billing.subscription.renewed',
            actorType: 'system',
            orgId,
            resource: { type: 'subscription', id },
            outcome: 'success',
            after: {
              periodStart: start,
              periodEnd: end,
              netMinor: net.toString(),
              creditAppliedMinor: credit.toString(),
            },
          });
        }
        return r.rowCount;
      });
      if (!advanced) break; // another run advanced it
      periodsBilled++;
      if (pending) await this.bill(orgId, id, now);
      else if (sub.status === 'trialing')
        await this.db.withOrg(orgId, (c) =>
          c.query(
            `UPDATE billing.subscriptions SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'trialing'`,
            [id],
          ),
        );
    }
    return { periodsBilled, cancelled: false };
  }

  /** Scheduler entry point: renew what is due, repair half-finished billing, settle recovered payments. Errors are per subscription. */
  async runDue(
    now = new Date(),
    limit = 100,
  ): Promise<{ renewed: number; settled: number; failed: number }> {
    const today = todayUtc(now);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ id: string; org_id: string; status: string }>(
            `SELECT id, org_id, status FROM billing.subscriptions
              WHERE (status IN ('trialing','active') AND (period_end <= $1::date OR pending_invoice IS NOT NULL)) OR status = 'past_due'
              ORDER BY period_end, id LIMIT $2`,
            [today, limit],
          )
        ).rows,
    );
    let renewed = 0;
    let settled = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        if (r.status === 'past_due') {
          if (await this.settle(r.org_id, r.id)) settled++;
        } else {
          const x = await this.renew(r.org_id, r.id, now);
          if (x.periodsBilled > 0 || x.cancelled) renewed++;
        }
      } catch {
        failed++;
      }
    }
    return { renewed, settled, failed };
  }

  // ---- change & cancel ------------------------------------------------------------------------------------------------

  async change(
    orgId: string,
    actorUserId: string,
    id: string,
    input: Record<string, unknown>,
    ifMatch: number | null,
    now = new Date(),
  ): Promise<{ applied: boolean; subscription: SubscriptionDto; proration: ChangePreview }> {
    const sub = await this.load(orgId, id); // first: a foreign or unknown id is a 404 whatever the body says
    const known = ['planVersionId', 'quantity', 'paymentMethodId', 'prorationMode', 'preview'];
    for (const k of Object.keys(input))
      if (!known.includes(k)) throw new ProblemException('validation_failed', `unknown field ${k}`);
    const preview = input.preview === true;
    if (input.preview !== undefined && typeof input.preview !== 'boolean')
      throw new ProblemException('validation_failed', 'preview must be a boolean');
    const mode = input.prorationMode ?? 'prorate';
    if (mode !== 'prorate' && mode !== 'none')
      throw new ProblemException('validation_failed', "prorationMode must be 'prorate' or 'none'");
    if (
      input.planVersionId === undefined &&
      input.quantity === undefined &&
      input.paymentMethodId === undefined
    )
      throw new ProblemException(
        'validation_failed',
        'send planVersionId, quantity or paymentMethodId',
      );
    if (
      input.planVersionId !== undefined &&
      (typeof input.planVersionId !== 'string' || !UUID.test(input.planVersionId))
    )
      throw new ProblemException('validation_failed', 'planVersionId must be a uuid');
    if (
      input.quantity !== undefined &&
      (typeof input.quantity !== 'number' ||
        !Number.isInteger(input.quantity) ||
        input.quantity < 1 ||
        input.quantity > 1000)
    )
      throw new ProblemException('validation_failed', 'quantity must be an integer 1..1000');
    if (
      input.paymentMethodId !== undefined &&
      (typeof input.paymentMethodId !== 'string' || !UUID.test(input.paymentMethodId))
    )
      throw new ProblemException('validation_failed', 'paymentMethodId must be a uuid');
    if (!preview && ifMatch === null)
      throw new ProblemException(
        'precondition_required',
        'If-Match with the subscription ETag is required',
      );

    if (!preview && ifMatch !== sub.version)
      throw new ProblemException('precondition_failed', 'the subscription changed; reload it');
    if (sub.status !== 'trialing' && sub.status !== 'active')
      throw new ProblemException(
        'conflict',
        `a ${sub.status as string} subscription cannot be changed; settle the unpaid invoice first`,
      );
    const today = todayUtc(now);
    if (dateOnly(sub.period_end) <= today)
      throw new ProblemException('conflict', 'a renewal is due; retry in a moment');
    if (input.paymentMethodId !== undefined)
      await this.ports.methods.assertUsable(orgId, (input.paymentMethodId as string).toLowerCase());

    const oldItems = sub.items as SubscriptionItem[];
    const oldQty = sub.quantity as number;
    let newItems = oldItems;
    let newPlanVersion = sub.plan_version_id as string;
    if (
      input.planVersionId !== undefined &&
      (input.planVersionId as string).toLowerCase() !== sub.plan_version_id
    ) {
      const snap = await this.snapshot(orgId, (input.planVersionId as string).toLowerCase(), now);
      if (snap.currency !== (sub.currency as string).trim())
        throw new ProblemException(
          'validation_failed',
          'the new plan is priced in another currency',
        );
      newItems = snap.items;
      newPlanVersion = (input.planVersionId as string).toLowerCase();
    }
    const newQty = (input.quantity as number | undefined) ?? oldQty;
    const oldAmount = amountOf(oldItems, oldQty);
    const newAmount = amountOf(newItems, newQty);
    if (newAmount <= 0n)
      throw new ProblemException('validation_failed', 'the plan fee must be greater than zero');
    const pricingChanged = newItems !== oldItems || newQty !== oldQty;

    let pr: Proration | null = null;
    if (pricingChanged && mode === 'prorate' && sub.status === 'active')
      pr = prorate({
        oldAmountMinor: oldAmount,
        newAmountMinor: newAmount,
        periodStart: dateOnly(sub.period_start),
        periodEnd: dateOnly(sub.period_end),
        changeDate: today,
      });
    const net = pr?.netMinor ?? 0n;
    const proration: ChangePreview = {
      effect: net > 0n ? 'charge' : net < 0n ? 'credit' : 'none',
      prorationMode: mode,
      currency: (sub.currency as string).trim(),
      oldAmountPerPeriodMinor: oldAmount.toString(),
      newAmountPerPeriodMinor: newAmount.toString(),
      daysLeft: pr?.daysLeft ?? null,
      daysTotal: pr?.daysTotal ?? null,
      unusedCreditMinor: (pr?.unusedCreditMinor ?? 0n).toString(),
      newChargeMinor: (pr?.newChargeMinor ?? 0n).toString(),
      netMinor: net.toString(),
      effectiveDate: today,
    };
    const planKey = async () => await this.snapshotKey(orgId, newPlanVersion);
    if (preview) return { applied: false, subscription: toDto(sub, await planKey()), proration };

    const pending: PendingInvoice | null =
      net > 0n
        ? {
            key: `subscription:${id}:change:${sub.version as number}`,
            periodStart: today,
            periodEnd: addDays(dateOnly(sub.period_end), -1),
            lines: [
              {
                description: `Plan change ${oldItems[0]!.planKey} × ${oldQty} → ${newItems[0]!.planKey} × ${newQty}, ${today} to ${addDays(dateOnly(sub.period_end), -1)} (prorated: ${pr!.newChargeMinor.toString()} new − ${pr!.unusedCreditMinor.toString()} unused)`,
                quantity: '1',
                unit: 'proration',
                netMinor: net.toString(),
                meterId: newItems[0]!.meterId,
                sourceId: `subscription:${id}:change:${sub.version as number}`,
              },
            ],
          }
        : null;
    const changed = await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE billing.subscriptions SET plan_version_id = $3, items = $4, quantity = $5, payment_method_id = $6,
                pending_credit_minor = pending_credit_minor + $7, pending_invoice = $8, updated_at = now()
          WHERE id = $1 AND version = $2 AND status IN ('trialing','active') AND pending_invoice IS NULL`,
        [
          id,
          ifMatch,
          newPlanVersion,
          JSON.stringify(newItems),
          newQty,
          (
            (input.paymentMethodId as string | undefined) ?? (sub.payment_method_id as string)
          ).toLowerCase(),
          net < 0n ? (-net).toString() : '0',
          pending ? JSON.stringify(pending) : null,
        ],
      );
      if (r.rowCount)
        await this.audit.record({
          action: 'billing.subscription.changed',
          actorUserId,
          orgId,
          resource: { type: 'subscription', id },
          outcome: 'success',
          before: { planVersionId: sub.plan_version_id as string, quantity: oldQty },
          after: {
            planVersionId: newPlanVersion,
            quantity: newQty,
            netMinor: net.toString(),
            prorationMode: mode,
          },
        });
      return r.rowCount;
    });
    if (!changed)
      throw new ProblemException('precondition_failed', 'the subscription changed; reload it');
    await this.ensureEntitlement(orgId, id);
    if (pending) await this.bill(orgId, id, now);
    return { applied: true, subscription: await this.get(orgId, id), proration };
  }

  private async snapshotKey(orgId: string, planVersionId: string): Promise<string> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query<{ key: string }>(
            `SELECT p.key FROM billing.plan_versions v JOIN billing.plans p ON p.id = v.plan_id WHERE v.id = $1`,
            [planVersionId],
          )
        ).rows[0]!.key,
    );
  }

  /** Cancel at the end of the paid period (the plan stays until then). Idempotent. */
  async cancel(
    orgId: string,
    actorUserId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<SubscriptionDto> {
    if (
      input.reason !== undefined &&
      (typeof input.reason !== 'string' || input.reason.length > 500)
    )
      throw new ProblemException('validation_failed', 'reason must be at most 500 characters');
    const sub = await this.load(orgId, id);
    if (sub.status === 'cancelled')
      throw new ProblemException('conflict', 'this subscription is already cancelled');
    if (!sub.cancel_at_period_end)
      await this.db.withOrg(orgId, async (c) => {
        await c.query(
          `UPDATE billing.subscriptions SET cancel_at_period_end = true, cancel_reason = $2, updated_at = now() WHERE id = $1 AND status <> 'cancelled'`,
          [id, (input.reason as string | undefined) ?? null],
        );
        await this.audit.record({
          action: 'billing.subscription.cancellation_requested',
          actorUserId,
          orgId,
          resource: { type: 'subscription', id },
          outcome: 'success',
          after: { periodEnd: dateOnly(sub.period_end) },
        });
      });
    return this.get(orgId, id);
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------

  private async load(orgId: string, id: string): Promise<Row> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM billing.subscriptions WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    );
    if (!r) throw new ProblemException('not_found');
    return r as Row;
  }

  async get(orgId: string, id: string): Promise<SubscriptionDto> {
    const r = await this.load(orgId, id);
    return toDto(r, (r.items as SubscriptionItem[])[0]!.planKey);
  }

  async list(
    orgId: string,
    o: { limit: number; cursor?: string | undefined; status?: string | undefined },
  ): Promise<Page<SubscriptionDto>> {
    if (o.status !== undefined && !STATUSES.includes(o.status as SubscriptionStatus))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${STATUSES.join(', ')}`,
      );
    const after = decodeCursor(o.cursor);
    return this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT * FROM billing.subscriptions WHERE org_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR id < $3::uuid) ORDER BY id DESC LIMIT $4`,
          [orgId, o.status ?? null, after, o.limit + 1],
        )
      ).rows;
      const p = pageOf(
        rows.map((r) => ({ id: r.id as string, r })),
        o.limit,
      );
      return {
        items: p.items.map((x) => toDto(x.r, (x.r.items as SubscriptionItem[])[0]!.planKey)),
        nextCursor: p.nextCursor,
      };
    });
  }

  /** True when an active (not cancelled) subscription uses this payment method: such a method cannot be removed. */
  async methodInUse(orgId: string, paymentMethodId: string): Promise<boolean> {
    return this.db.withOrg(orgId, async (c) =>
      Boolean(
        (
          await c.query(
            `SELECT 1 FROM billing.subscriptions WHERE org_id = $1 AND payment_method_id = $2 AND status <> 'cancelled' LIMIT 1`,
            [orgId, paymentMethodId],
          )
        ).rowCount,
      ),
    );
  }
}
