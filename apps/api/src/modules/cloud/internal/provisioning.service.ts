import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { assertResidency, ResidencyDenied, type TransitionActor } from '@nuzm/domain';
import type { ResidencyService } from '../../compliance';
import {
  idempotencyToken,
  isSupported,
  orgTag,
  type AccountContext,
  type CapabilityId,
  type ComputeAdapter,
  type InstanceState,
} from '@nuzm/adapter-contracts';
import { enqueue, type Db, type Operation, type OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { type ErrorCode } from '../../../common/errors';
import type { AdapterRegistry } from './adapter-registry';
import { pgCode, type Row } from './common';
import type { OfferService } from './offer.service';
import { transitionResource } from './resource-store';
import { recordStep } from './steps';

export const OP_CREATE = 'compute.instance.create';
export const OP_DELETE = 'compute.instance.delete';
export const OP_ACTION = 'compute.instance.action';
export const COMPUTE_OP_KINDS = [OP_CREATE, OP_DELETE, OP_ACTION] as const;

export interface PlanShape {
  vcpu: number;
  memoryMb: number;
  diskGb: number;
}
/** Input of `compute.instance.create` (platform.operations.input; never returned to customers). */
export interface CreateInput {
  instanceId: string;
  resourceId: string;
  quoteId: string;
  orderId: string;
  authorizationId: string;
  accountId: string;
  offerId: string;
  regionRowId: string;
  providerRegionId: string;
  country: string;
  dataRegion: string;
  planRef: string;
  imageRef: string;
  name: string;
  plan: PlanShape;
  sshPublicKeys: string[];
  providerPrice: { amountMinor: string; currency: string; period: string } | null;
  priceBookVersionId: string | null;
}
export interface DeleteInput {
  instanceId: string;
  resourceId: string;
  accountId: string;
  priorStatus: string;
}
export interface ActionInput {
  actionId: string;
  instanceId: string;
  resourceId: string;
  accountId: string;
  type: 'start' | 'stop' | 'reboot' | 'resize' | 'snapshot';
  params: Record<string, unknown>;
  targetPlan?: PlanShape & { planRef: string };
  priorStatus: string;
}

type ReleaseReason =
  | 'operation_failed'
  | 'operation_cancelled'
  | 'price_changed'
  | 'residency_denied'
  | 'capability_unsupported'
  | 'quota_exceeded'
  | 'instance_deleted'
  | 'other';
export interface Veto {
  code: ErrorCode | string;
  message: string;
  release: ReleaseReason;
}

const samePrice = (a: CreateInput['providerPrice'], b: CreateInput['providerPrice']): boolean =>
  (a === null && b === null) ||
  (a !== null &&
    b !== null &&
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    a.period === b.period);

export interface AccountAccess {
  adapter: ComputeAdapter;
  ctx: AccountContext;
  caps: Partial<Record<CapabilityId, string>>;
}

/**
 * Durable provisioning workflow on `platform.operations` (M05 task 10):
 *   reserve_authorization → place (TOCTOU re-check: eligibility, residency, capability, price) → provision(token) → inspect → persist → finalize.
 * Safety rules: the provider call carries a deterministic idempotency token; an `uncertain` result moves the resource to UNKNOWN and the operation to
 * `needs_reconcile` (the reconciler decides, never this code); a DEFINITIVE failure compensates (resource FAILED, hold released, order failed).
 * Provider identity never appears in operation results or errors (customers can read operations).
 */
export class ProvisioningService {
  /** Run operations in the background right after the API accepted them. Tests switch this off to drive each step themselves. */
  autoKick = true;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly adapters: AdapterRegistry,
    private readonly offers: OfferService,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
  ) {}

  now(): Date {
    return new Date(this.adapters.clock.now());
  }

  /** Fire-and-forget execution used by the API after it returned 202. */
  kick(orgId: string, operationId: string): void {
    if (!this.autoKick) return; // tests drive operations explicitly to inject faults between steps
    setImmediate(
      () =>
        void this.run(orgId, operationId).catch((e) =>
          console.error(JSON.stringify({ cloud_operation_error: (e as Error).message })),
        ),
    );
  }

  async run(orgId: string, operationId: string, worker = `api-${process.pid}`): Promise<void> {
    const claimed = await this.ops.claimById(orgId, operationId, worker);
    if (!claimed) return;
    const op = await this.ops.get(orgId, operationId);
    if (!op) return;
    await this.execute(orgId, op, worker);
  }

  /** Runs a CLAIMED (running) compute operation from its first step. */
  async execute(orgId: string, op: Operation, worker: string): Promise<void> {
    const operationId = op.id;
    try {
      if (op.kind === OP_CREATE) await this.executeCreate(orgId, op, worker, 'start');
      else if (op.kind === OP_DELETE) await this.executeDelete(orgId, op, worker);
      else if (op.kind === OP_ACTION) await this.executeAct(orgId, op, worker);
    } catch (e) {
      // An unexpected error after a provider call may have happened: never retry blindly, never lose the operation.
      await this.ops
        .markNeedsReconcile(
          orgId,
          operationId,
          worker,
          `unexpected: ${(e as Error).message}`.slice(0, 300),
        )
        .catch(() => undefined);
    }
  }

  // ---- shared helpers ------------------------------------------------------------------------------------------------------
  async access(accountId: string, traceId: string): Promise<AccountAccess | null> {
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT a.id, a.vault_ref, p.adapter_id,
                    (SELECT jsonb_object_agg(cp.capability_id, cp.state) FROM cloud.provider_capabilities cp WHERE cp.account_id = a.id) AS caps
               FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id WHERE a.id = $1`,
            [accountId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!row) return null;
    const adapter = this.adapters.compute(row.adapter_id as string);
    if (!adapter) return null;
    return {
      adapter,
      ctx: this.adapters.ctx({ id: accountId, vaultRef: row.vault_ref as string }, traceId),
      caps: (row.caps ?? {}) as AccountAccess['caps'],
    };
  }

  private release(
    c: PoolClient,
    orgId: string,
    authorizationId: string,
    reason: ReleaseReason,
    detail: Record<string, unknown> = {},
  ) {
    return c.query(
      `INSERT INTO commerce.authorization_releases (id, org_id, authorization_id, reason, detail) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (authorization_id) DO NOTHING`,
      [uuidv7(), orgId, authorizationId, reason, JSON.stringify(detail)],
    );
  }

  /** TOCTOU re-evaluation at execution (docs/04 §2.5): the offer must STILL be eligible, priced as quoted, and residency must STILL allow it. */
  async revalidate(
    orgId: string,
    input: Pick<CreateInput, 'offerId' | 'providerPrice' | 'priceBookVersionId'>,
  ): Promise<Veto | null> {
    const [c] = await this.offers.candidates(orgId, {
      planId: input.offerId,
      ignoreInstanceQuota: true,
    });
    if (!c)
      return {
        code: 'no_eligible_offer',
        message: 'the offer is no longer available',
        release: 'operation_failed',
      };
    if (c.failures.includes('residency_denied'))
      return {
        code: 'residency_denied',
        message: 'the residency policy no longer allows this placement',
        release: 'residency_denied',
      };
    if (c.failures.includes('capability_unsupported'))
      return {
        code: 'unsupported_capability',
        message: 'the provider no longer supports provisioning',
        release: 'capability_unsupported',
      };
    if (c.failures.includes('quota_blocked') || c.failures.includes('entitlement_blocked'))
      return {
        code: 'quota_exceeded',
        message: 'the compute entitlement no longer allows this',
        release: 'quota_exceeded',
      };
    if (c.failures.includes('no_provider_price') || c.failures.includes('no_nuzm_price'))
      return {
        code: 'price_changed',
        message: 'the price is no longer available',
        release: 'price_changed',
      };
    if (c.failures.length)
      return {
        code: 'no_eligible_offer',
        message: 'the offer is no longer eligible',
        release: 'operation_failed',
      };
    if (
      !samePrice(c.providerPrice, input.providerPrice) ||
      (input.priceBookVersionId !== null &&
        c.price?.priceBookVersionId !== input.priceBookVersionId)
    )
      return {
        code: 'price_changed',
        message: 'the price changed since the quote was issued; nothing was charged',
        release: 'price_changed',
      };
    try {
      await assertResidency(this.residency, {
        orgId,
        dataClass: 'customer-content',
        targetRegion: c.regionRowId,
        purpose: 'compute.provision',
        processorId: c.providerKey,
        operation: 'write',
      });
    } catch (e) {
      if (e instanceof ResidencyDenied)
        return {
          code: 'residency_denied',
          message: 'the residency policy denies this placement',
          release: 'residency_denied',
        };
      throw e;
    }
    return null;
  }

  // ---- create --------------------------------------------------------------------------------------------------------------
  async executeCreate(
    orgId: string,
    op: Operation,
    worker: string,
    from: 'start' | 'provision',
  ): Promise<void> {
    const input = op.input as CreateInput;
    const acc = await this.access(input.accountId, op.trace_id ?? op.id);
    if (!acc)
      return this.compensateCreate(
        orgId,
        op,
        worker,
        input,
        'adapter_not_available',
        'no provider adapter is available for this placement',
        'operation_failed',
      );

    if (from === 'start') {
      const held = await this.db.withOrg(orgId, async (c) => {
        const ok =
          (
            await c.query(
              `SELECT 1 FROM commerce.authorizations a WHERE a.id = $1 AND a.kind = 'hold' AND NOT EXISTS (SELECT 1 FROM commerce.authorization_releases r WHERE r.authorization_id = a.id)`,
              [input.authorizationId],
            )
          ).rowCount === 1;
        await recordStep(c, orgId, op.id, 'reserve_authorization', ok ? 'succeeded' : 'failed');
        return ok;
      });
      if (!held)
        return this.compensateCreate(
          orgId,
          op,
          worker,
          input,
          'authorization_missing',
          'the cost authorization is missing or was released',
          'operation_failed',
        );
      const veto = await this.revalidate(orgId, input);
      await this.db.withOrg(orgId, (c) =>
        recordStep(
          c,
          orgId,
          op.id,
          'place',
          veto ? 'failed' : 'succeeded',
          veto ? { code: veto.code } : {},
        ),
      );
      if (veto)
        return this.compensateCreate(
          orgId,
          op,
          worker,
          input,
          veto.code,
          veto.message,
          veto.release,
        );
    }

    const fresh = await this.ops.get(orgId, op.id);
    if (fresh?.cancel_requested)
      return this.compensateCreate(
        orgId,
        op,
        worker,
        input,
        'operation_cancelled',
        'the operation was cancelled',
        'operation_cancelled',
      );

    // provision (idempotent by token). A re-run after a DEFINITIVE failure first looks for the resource when the provider supports lookup.
    const token = idempotencyToken(orgId, op.id, 'provision');
    const res = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT provider_ref FROM cloud.resources WHERE id = $1`, [
            input.resourceId,
          ])
        ).rows[0] as Row | undefined,
    );
    let providerRef = (res?.provider_ref as string | null) ?? null;
    if (
      !providerRef &&
      op.attempts > 1 &&
      isSupported(acc.caps as never, 'compute.find-by-token')
    ) {
      const f = await acc.adapter.findByToken(acc.ctx, token);
      if (f.status === 'succeeded' && f.data) providerRef = f.data.providerRef;
      else if (f.status !== 'succeeded')
        return this.park(orgId, op, worker, input, 'pre-retry lookup did not answer', false);
      // succeeded with data:null after a DEFINITIVE failure: nothing exists, the retry is safe
    }
    if (!providerRef) {
      const r = await acc.adapter.provision(acc.ctx, {
        providerRegionId: input.providerRegionId,
        planRef: input.planRef,
        imageRef: input.imageRef,
        name: input.name,
        diskGb: input.plan.diskGb,
        sshPublicKeys: input.sshPublicKeys,
        tags: { 'nuzm-org': orgTag(orgId), 'nuzm-instance': input.instanceId },
        idempotencyToken: token,
      });
      if (r.status === 'uncertain')
        return this.park(
          orgId,
          op,
          worker,
          input,
          r.error?.message ?? 'provider call timed out',
          true,
        );
      if (r.status === 'failed') {
        if (r.error?.retryable) {
          await this.db.withOrg(orgId, (c) =>
            recordStep(c, orgId, op.id, 'provision', 'failed', {
              category: r.error!.category,
              retryable: true,
            }),
          );
          const o = await this.ops.fail(orgId, op.id, worker, {
            code: r.error.category,
            message: 'the provider could not take the request yet',
          });
          if (o.state === 'failed')
            return this.compensateCreate(
              orgId,
              op,
              worker,
              input,
              r.error.category,
              'the provider kept refusing the request',
              'operation_failed',
              true,
            );
          return; // pending with backoff: the same token is used on the next run
        }
        return this.compensateCreate(
          orgId,
          op,
          worker,
          input,
          r.error?.category ?? 'provider_error',
          'the provider rejected the request',
          'operation_failed',
        );
      }
      providerRef = r.providerRef ?? r.data?.providerRef ?? null;
      if (!providerRef)
        return this.park(orgId, op, worker, input, 'provider answered without a reference', true);
    }
    try {
      await this.db.withOrg(orgId, async (c) => {
        await c.query(
          `UPDATE cloud.resources SET provider_ref = $2, last_seen_at = $3 WHERE id = $1 AND provider_ref IS NULL`,
          [input.resourceId, providerRef, this.now()],
        );
        await recordStep(c, orgId, op.id, 'provision', 'succeeded');
      });
    } catch (e) {
      if (pgCode(e) === '23505')
        return this.park(
          orgId,
          op,
          worker,
          input,
          'provider reference already belongs to another resource',
          true,
        );
      throw e;
    }

    // inspect: wait (bounded) until the provider shows the resource running
    let state: InstanceState | null = null;
    for (let i = 0; i < 3 && !state; i++) {
      const ins = await acc.adapter.inspect(acc.ctx, providerRef);
      if (ins.status === 'succeeded' && ins.data && ins.data.status === 'running') state = ins.data;
      else if (ins.status === 'uncertain') break;
    }
    await this.db.withOrg(orgId, (c) =>
      recordStep(c, orgId, op.id, 'inspect', state ? 'succeeded' : 'failed'),
    );
    if (!state)
      return this.park(
        orgId,
        op,
        worker,
        input,
        'the provider does not show the instance running yet',
        false,
      );
    await this.finishCreate(orgId, op, worker, input, providerRef, state, 'orchestrator');
  }

  /** persist + finalize. Also used by the reconciler when it adopts an instance that the provider created (actor = reconciler). */
  async finishCreate(
    orgId: string,
    op: Operation,
    worker: string,
    input: CreateInput,
    providerRef: string,
    state: InstanceState,
    actor: TransitionActor,
    adopted = false,
  ): Promise<void> {
    const now = this.now();
    await this.db.withOrg(orgId, async (c) => {
      await transitionResource(c, input.resourceId, 'ACTIVE', actor, {
        provider_ref: providerRef,
        last_seen_at: now,
        drift_state: 'in_sync',
        observed: { status: state.status, planRef: state.planRef, at: now.toISOString() },
      });
      await c.query(
        `UPDATE compute.instances SET status = 'running', public_ips = $2, updated_at = now(), version = version + 1 WHERE id = $1`,
        [input.instanceId, JSON.stringify(state.publicIps ?? [])],
      );
      await c.query(
        `INSERT INTO compute.instance_intervals (id, org_id, instance_id, resource_id, started_at, vcpu, memory_mb, disk_gb, data_region)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE NOT EXISTS (SELECT 1 FROM compute.instance_intervals WHERE instance_id = $3 AND ended_at IS NULL)`,
        [
          uuidv7(),
          orgId,
          input.instanceId,
          input.resourceId,
          now,
          input.plan.vcpu,
          input.plan.memoryMb,
          input.plan.diskGb,
          input.dataRegion,
        ],
      );
      await c.query(
        `UPDATE commerce.orders SET status = 'fulfilled' WHERE id = $1 AND status = 'created'`,
        [input.orderId],
      );
      await enqueue(c, orgId, 'compute.instance.created', {
        instanceId: input.instanceId,
        dataRegion: input.dataRegion,
      });
      await recordStep(c, orgId, op.id, 'persist', 'succeeded', adopted ? { adopted: true } : {});
      await this.audit.record({
        action: 'instance.create.succeeded',
        orgId,
        actorType: 'system',
        resource: { type: 'compute_instance', id: input.instanceId },
        outcome: 'success',
        detail: { operationId: op.id, adopted },
      });
    });
    await this.ops.succeed(orgId, op.id, worker, { instanceId: input.instanceId });
    await this.db.withOrg(orgId, (c) => recordStep(c, orgId, op.id, 'finalize', 'succeeded'));
  }

  /** Outcome uncertain: resource UNKNOWN (when the provider call may have created something), operation `needs_reconcile`. */
  async park(
    orgId: string,
    op: Operation,
    worker: string,
    input: CreateInput,
    reason: string,
    toUnknown: boolean,
  ): Promise<void> {
    const now = this.now();
    await this.db.withOrg(orgId, async (c) => {
      if (toUnknown) {
        await transitionResource(c, input.resourceId, 'UNKNOWN', 'orchestrator', {
          observed: { attemptAt: now.toISOString(), observations: [], reason },
        });
        await c.query(
          `UPDATE compute.instances SET status = 'unknown', updated_at = now(), version = version + 1 WHERE id = $1`,
          [input.instanceId],
        );
      }
      await recordStep(c, orgId, op.id, 'provision', 'failed', { uncertain: true });
      await this.audit.record({
        action: 'instance.create.uncertain',
        orgId,
        actorType: 'system',
        resource: { type: 'compute_instance', id: input.instanceId },
        outcome: 'failure',
        detail: { operationId: op.id, resourceUnknown: toUnknown },
      });
    });
    await this.ops.markNeedsReconcile(orgId, op.id, worker, reason.slice(0, 300));
  }

  /** Definitive failure: resource FAILED, instance failed, hold released, order failed — then the operation fails permanently. */
  async compensateCreate(
    orgId: string,
    op: Operation,
    worker: string,
    input: CreateInput,
    code: string,
    message: string,
    release: ReleaseReason,
    alreadyFailed = false,
    actor: TransitionActor = 'orchestrator',
  ): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      await transitionResource(c, input.resourceId, 'FAILED', actor);
      await c.query(
        `UPDATE compute.instances SET status = 'failed', updated_at = now(), version = version + 1 WHERE id = $1`,
        [input.instanceId],
      );
      await this.release(c, orgId, input.authorizationId, release, { code });
      await c.query(
        `UPDATE commerce.orders SET status = 'failed' WHERE id = $1 AND status = 'created'`,
        [input.orderId],
      );
      await recordStep(c, orgId, op.id, 'finalize', 'failed', { code });
      await this.audit.record({
        action: 'instance.create.failed',
        orgId,
        actorType: 'system',
        resource: { type: 'compute_instance', id: input.instanceId },
        outcome: 'failure',
        detail: { operationId: op.id, code, release },
      });
    });
    if (!alreadyFailed) await this.ops.failPermanently(orgId, op.id, worker, { code, message });
  }

  // ---- delete --------------------------------------------------------------------------------------------------------------
  async executeDelete(
    orgId: string,
    op: Operation,
    worker: string,
    actor: TransitionActor = 'orchestrator',
  ): Promise<void> {
    const input = op.input as DeleteInput;
    const res = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT state, provider_ref FROM cloud.resources WHERE id = $1`, [
            input.resourceId,
          ])
        ).rows[0] as Row | undefined,
    );
    const ref = (res?.provider_ref as string | null) ?? null;
    const acc = await this.access(input.accountId, op.trace_id ?? op.id);
    if (ref && !acc)
      return void (await this.revertDelete(
        orgId,
        op,
        worker,
        input,
        'adapter_not_available',
        actor,
      ));
    if (ref && acc) {
      const r = await acc.adapter.delete(acc.ctx, ref);
      if (r.status === 'uncertain') {
        await this.db.withOrg(orgId, async (c) => {
          await transitionResource(
            c,
            input.resourceId,
            'UNKNOWN',
            actor === 'reconciler' ? 'orchestrator' : actor,
            {
              observed: {
                attemptAt: this.now().toISOString(),
                observations: [],
                reason: 'delete outcome unknown',
              },
            },
          );
          await c.query(
            `UPDATE compute.instances SET status = 'unknown', updated_at = now(), version = version + 1 WHERE id = $1`,
            [input.instanceId],
          );
          await this.audit.record({
            action: 'instance.delete.uncertain',
            orgId,
            actorType: 'system',
            resource: { type: 'compute_instance', id: input.instanceId },
            outcome: 'failure',
            detail: { operationId: op.id },
          });
        });
        return void (await this.ops.markNeedsReconcile(
          orgId,
          op.id,
          worker,
          'delete outcome unknown',
        ));
      }
      if (r.status === 'failed') {
        if (r.error?.retryable) {
          const o = await this.ops.fail(orgId, op.id, worker, {
            code: r.error.category,
            message: 'the provider could not delete yet',
          });
          if (o.state !== 'failed') return;
        }
        return void (await this.revertDelete(
          orgId,
          op,
          worker,
          input,
          r.error?.category ?? 'provider_error',
          actor,
        ));
      }
    }
    await this.finishDelete(orgId, op, worker, input, actor);
  }

  async finishDelete(
    orgId: string,
    op: Operation,
    worker: string,
    input: DeleteInput,
    actor: TransitionActor,
  ): Promise<void> {
    const now = this.now();
    await this.db.withOrg(orgId, async (c) => {
      await transitionResource(c, input.resourceId, 'DELETED', actor, {
        last_seen_at: now,
        drift_state: 'in_sync',
      });
      await c.query(
        `UPDATE compute.instances SET status = 'deleted', public_ips = '[]'::jsonb, updated_at = now(), version = version + 1 WHERE id = $1`,
        [input.instanceId],
      );
      await c.query(
        `UPDATE compute.instance_intervals SET ended_at = $2 WHERE instance_id = $1 AND ended_at IS NULL`,
        [input.instanceId, now],
      );
      await enqueue(c, orgId, 'compute.instance.deleted', { instanceId: input.instanceId });
      await this.audit.record({
        action: 'compute.instance.deleted',
        orgId,
        actorType: 'system',
        resource: { type: 'compute_instance', id: input.instanceId },
        outcome: 'success',
        detail: { operationId: op.id },
      });
    });
    await this.ops.succeed(orgId, op.id, worker, { instanceId: input.instanceId });
  }

  private async revertDelete(
    orgId: string,
    op: Operation,
    worker: string,
    input: DeleteInput,
    code: string,
    actor: TransitionActor,
  ): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      await transitionResource(c, input.resourceId, 'ACTIVE', actor);
      await c.query(
        `UPDATE compute.instances SET status = $2, updated_at = now(), version = version + 1 WHERE id = $1`,
        [input.instanceId, input.priorStatus === 'stopped' ? 'stopped' : 'running'],
      );
      await this.audit.record({
        action: 'instance.delete.failed',
        orgId,
        actorType: 'system',
        resource: { type: 'compute_instance', id: input.instanceId },
        outcome: 'failure',
        detail: { operationId: op.id, code },
      });
    });
    await this.ops.failPermanently(orgId, op.id, worker, {
      code,
      message: 'the instance could not be deleted',
    });
  }

  // ---- actions -------------------------------------------------------------------------------------------------------------
  async executeAct(orgId: string, op: Operation, worker: string): Promise<void> {
    const input = op.input as ActionInput;
    const acc = await this.access(input.accountId, op.trace_id ?? op.id);
    const res = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT provider_ref FROM cloud.resources WHERE id = $1`, [
            input.resourceId,
          ])
        ).rows[0] as Row | undefined,
    );
    const ref = res?.provider_ref as string | undefined;
    if (!acc || !ref || !acc.adapter.act)
      return void (await this.failAction(orgId, op, worker, input, 'unsupported_capability'));
    const params = input.type === 'resize' ? { planRef: input.targetPlan?.planRef } : input.params;
    const r = await acc.adapter.act(acc.ctx, ref, input.type, params);
    if (r.status === 'uncertain') {
      await this.db.withOrg(orgId, async (c) => {
        await transitionResource(c, input.resourceId, 'UNKNOWN', 'orchestrator', {
          observed: {
            attemptAt: this.now().toISOString(),
            observations: [],
            reason: `action ${input.type} outcome unknown`,
          },
        });
        await c.query(
          `UPDATE compute.instances SET status = 'unknown', updated_at = now(), version = version + 1 WHERE id = $1`,
          [input.instanceId],
        );
        await c.query(
          `UPDATE compute.instance_actions SET status = 'needs_reconcile', updated_at = now() WHERE id = $1`,
          [input.actionId],
        );
      });
      return void (await this.ops.markNeedsReconcile(
        orgId,
        op.id,
        worker,
        `action ${input.type} outcome unknown`,
      ));
    }
    if (r.status === 'failed') {
      if (r.error?.retryable) {
        const o = await this.ops.fail(orgId, op.id, worker, {
          code: r.error.category,
          message: 'the provider could not apply the action yet',
        });
        if (o.state !== 'failed') return;
        return void (await this.failAction(orgId, op, worker, input, r.error.category, true));
      }
      return void (await this.failAction(
        orgId,
        op,
        worker,
        input,
        r.error?.category ?? 'provider_error',
      ));
    }
    await this.finishAct(orgId, op, worker, input, 'orchestrator');
  }

  /** Applies the effect of a successful action on our records (also used by the reconciler when it proves the action took effect). */
  async finishAct(
    orgId: string,
    op: Operation,
    worker: string,
    input: ActionInput,
    actor: TransitionActor,
  ): Promise<void> {
    const now = this.now();
    await this.db.withOrg(orgId, async (c) => {
      const inst = (
        await c.query(`SELECT * FROM compute.instances WHERE id = $1 FOR UPDATE`, [
          input.instanceId,
        ])
      ).rows[0] as Row;
      if (
        (await c.query(`SELECT state FROM cloud.resources WHERE id = $1`, [input.resourceId]))
          .rows[0]?.state === 'UNKNOWN'
      )
        await transitionResource(c, input.resourceId, 'ACTIVE', actor, { last_seen_at: now });
      const plan = inst.plan as PlanShape;
      const close = () =>
        c.query(
          `UPDATE compute.instance_intervals SET ended_at = $2 WHERE instance_id = $1 AND ended_at IS NULL`,
          [input.instanceId, now],
        );
      const open = (p: PlanShape) =>
        c.query(
          `INSERT INTO compute.instance_intervals (id, org_id, instance_id, resource_id, started_at, vcpu, memory_mb, disk_gb, data_region)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE NOT EXISTS (SELECT 1 FROM compute.instance_intervals WHERE instance_id = $3 AND ended_at IS NULL)`,
          [
            uuidv7(),
            orgId,
            input.instanceId,
            input.resourceId,
            now,
            p.vcpu,
            p.memoryMb,
            p.diskGb,
            inst.data_region,
          ],
        );
      let status = inst.status as string;
      let newPlan: PlanShape | null = null;
      if (input.type === 'start') {
        status = 'running';
        await open(plan);
      } else if (input.type === 'stop') {
        status = 'stopped';
        await close();
      } else if (input.type === 'resize' && input.targetPlan) {
        newPlan = {
          vcpu: input.targetPlan.vcpu,
          memoryMb: input.targetPlan.memoryMb,
          diskGb: input.targetPlan.diskGb,
        };
        if (status === 'running') {
          await close();
          await open(newPlan);
        }
      } else if (input.type === 'snapshot') {
        await c.query(
          `INSERT INTO compute.snapshots (id, org_id, instance_id, data_region, state) VALUES ($1,$2,$3,$4,'available')`,
          [uuidv7(), orgId, input.instanceId, inst.data_region],
        );
      }
      await c.query(
        `UPDATE compute.instances SET status = $2, plan = coalesce($3::jsonb, plan), updated_at = now(), version = version + 1 WHERE id = $1`,
        [input.instanceId, status, newPlan ? JSON.stringify(newPlan) : null],
      );
      await c.query(
        `UPDATE compute.instance_actions SET status = 'succeeded', updated_at = now() WHERE id = $1`,
        [input.actionId],
      );
      await enqueue(c, orgId, 'compute.instance.action', {
        instanceId: input.instanceId,
        type: input.type,
      });
      await this.audit.record({
        action: 'compute.instance.action',
        orgId,
        actorType: 'system',
        resource: { type: 'compute_instance', id: input.instanceId },
        outcome: 'success',
        detail: { operationId: op.id, type: input.type },
      });
    });
    await this.ops.succeed(orgId, op.id, worker, {
      instanceId: input.instanceId,
      type: input.type,
    });
  }

  async failAction(
    orgId: string,
    op: Operation,
    worker: string,
    input: ActionInput,
    code: string,
    alreadyFailed = false,
  ): Promise<void> {
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE compute.instance_actions SET status = 'failed', updated_at = now() WHERE id = $1`,
        [input.actionId],
      );
      await this.audit.record({
        action: 'compute.instance.action',
        orgId,
        actorType: 'system',
        resource: { type: 'compute_instance', id: input.instanceId },
        outcome: 'failure',
        detail: { operationId: op.id, type: input.type, code },
      });
    });
    if (!alreadyFailed)
      await this.ops.failPermanently(orgId, op.id, worker, {
        code,
        message: `the ${input.type} action could not be applied`,
      });
  }
}
