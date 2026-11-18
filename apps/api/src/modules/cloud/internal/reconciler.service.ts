import { v7 as uuidv7 } from 'uuid';
import {
  DEFAULT_ABSENCE_RULE,
  absenceProven,
  classifyObservation,
  type AbsenceRule,
  type Observation,
  type Observed,
} from '@nuzm/domain';
import { isSupported, type InstanceState } from '@nuzm/adapter-contracts';
import type { Db, Operation, OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { AdapterRegistry } from './adapter-registry';
import { UUID, type Row } from './common';
import {
  COMPUTE_OP_KINDS,
  OP_ACTION,
  OP_CREATE,
  OP_DELETE,
  type ActionInput,
  type CreateInput,
  type DeleteInput,
  type ProvisioningService,
} from './provisioning.service';
import { patchResource, transitionResource } from './resource-store';

export type ReconcileTrigger =
  'scheduled' | 'on_demand' | 'pre_retry' | 'pre_delete' | 'pre_action';
export type ReconcileResult =
  | 'in_sync'
  | 'drift'
  | 'orphan_suspected'
  | 'missing'
  | 'adopted'
  | 'absence_pending'
  | 'absence_proven'
  | 'cannot_prove_absence'
  | 'compensated'
  | 'error'
  | 'skipped';
export interface ReconcileOutcome {
  result: ReconcileResult;
  action: string;
}
export interface ReconcileConfig {
  absence: AbsenceRule;
  /** An ACTIVE resource not seen for this long is re-observed by the scheduled sweep. */
  driftIntervalMs: number;
  /** PROVISIONING / DELETING resources older than this are looked at by the sweep. */
  stuckAfterMs: number;
  /** Consecutive "cannot prove absence" cycles before an admin case is opened. */
  caseAfterCycles: number;
  /** Consecutive "missing" observations before metering stops for a resource. */
  missingConfirmations: number;
  /** DANGEROUS: delete suspected orphans automatically. Default OFF; when ON every deletion is audited. */
  autoDeleteOrphans: boolean;
  batch: number;
}
export const reconcileConfigFromEnv = (): ReconcileConfig => ({
  absence: {
    windowMs:
      Number(process.env.CLOUD_CONSISTENCY_WINDOW_SECONDS ?? DEFAULT_ABSENCE_RULE.windowMs / 1000) *
      1000,
    gapMs:
      Number(process.env.CLOUD_ABSENCE_GAP_SECONDS ?? DEFAULT_ABSENCE_RULE.gapMs / 1000) * 1000,
    minObservations: DEFAULT_ABSENCE_RULE.minObservations,
  },
  driftIntervalMs: Number(process.env.CLOUD_DRIFT_INTERVAL_SECONDS ?? 900) * 1000,
  stuckAfterMs: Number(process.env.CLOUD_STUCK_AFTER_SECONDS ?? 120) * 1000,
  caseAfterCycles: Number(process.env.CLOUD_CASE_AFTER_CYCLES ?? 3),
  missingConfirmations: 2,
  autoDeleteOrphans: process.env.CLOUD_AUTO_DELETE_ORPHANS === 'true',
  batch: 50,
});

const WORKER = () => `reconciler-${process.pid}`;

/**
 * Reconciler (M05 task 11). Compares `cloud.resources` / operations with the provider (`inspect`, `findByToken`) and records the result in
 * `cloud.resource_reconciliations`. States: in_sync | drift | orphan_suspected | missing. It is the ONLY actor that may leave `UNKNOWN`, and it
 * NEVER retries a provision unless `findByToken` PROVED absence (>= 2 absent observations after the provider's consistency window, spaced apart).
 * A resource it finds that nobody owns is an orphan CASE for an admin; it deletes nothing unless the explicit `autoDeleteOrphans` flag is on.
 */
export class ReconcilerService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly adapters: AdapterRegistry,
    private readonly prov: ProvisioningService,
    private readonly cfg: ReconcileConfig = reconcileConfigFromEnv(),
  ) {}

  private now(): Date {
    return new Date(this.adapters.clock.now());
  }

  private async record(
    resourceId: string,
    trigger: ReconcileTrigger,
    observed: unknown,
    o: ReconcileOutcome,
    actorUserId?: string,
  ): Promise<void> {
    await this.db.withPlatformScope((c) =>
      c.query(
        `INSERT INTO cloud.resource_reconciliations (id, resource_id, run_at, trigger, observed, result, action_taken, actor_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          uuidv7(),
          resourceId,
          this.now(),
          trigger,
          JSON.stringify(observed ?? {}),
          o.result === 'skipped' ? 'error' : o.result,
          o.action,
          actorUserId ?? null,
        ],
      ),
    );
  }

  /** One reconciliation of one resource. Safe to call any time, concurrently with itself (leases and the state machine arbitrate). */
  async reconcileResource(
    resourceId: string,
    opts: { trigger: ReconcileTrigger; actorUserId?: string } = { trigger: 'on_demand' },
  ): Promise<ReconcileOutcome> {
    if (!UUID.test(resourceId)) throw new ProblemException('not_found');
    const res = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM cloud.resources WHERE id = $1`, [resourceId])).rows[0] as
          Row | undefined,
    );
    if (!res) throw new ProblemException('not_found');
    let outcome: ReconcileOutcome;
    let observed: unknown = {};
    try {
      const r = await this.dispatch(res);
      outcome = r.outcome;
      observed = r.observed;
    } catch (e) {
      outcome = {
        result: 'error',
        action: `reconcile failed: ${(e as Error).message}`.slice(0, 200),
      };
    }
    await this.record(resourceId, opts.trigger, observed, outcome, opts.actorUserId);
    return outcome;
  }

  private async dispatch(res: Row): Promise<{ outcome: ReconcileOutcome; observed: unknown }> {
    const orgId = res.org_id as string;
    const state = res.state as string;
    const op = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM platform.operations WHERE resource_id = $1 AND state = 'needs_reconcile' ORDER BY created_at DESC LIMIT 1`,
            [res.id],
          )
        ).rows[0] as Row | undefined,
    );
    const acc = await this.prov.access(
      res.provider_account_id as string,
      `reconcile-${res.id as string}`,
    );
    if (!acc)
      return {
        outcome: { result: 'error', action: 'no adapter available for the account' },
        observed: {},
      };
    const supportsLookup = isSupported(acc.caps as never, 'compute.find-by-token');
    if (state === 'PROVISIONING' && !res.provider_ref) {
      // a create operation that was cancelled before it ran: release what it reserved (resource FAILED, hold released, order failed)
      const cancelled = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT * FROM platform.operations WHERE resource_id = $1 AND kind = $2 AND state = 'cancelled' ORDER BY created_at DESC LIMIT 1`,
              [res.id, OP_CREATE],
            )
          ).rows[0] as Row | undefined,
      );
      if (cancelled) {
        const o = (await this.ops.get(orgId, cancelled.id as string))!;
        await this.prov.compensateCreate(
          orgId,
          o,
          WORKER(),
          o.input as CreateInput,
          'operation_cancelled',
          'the operation was cancelled',
          'operation_cancelled',
          true,
          'orchestrator',
        );
        return {
          outcome: {
            result: 'compensated' as const,
            action: 'cancelled operation: reservation released',
          },
          observed: {},
        };
      }
    }
    const release = async <T>(p: Promise<T>): Promise<T> => {
      try {
        return await p;
      } finally {
        if (op)
          await this.ops.releaseLease(orgId, op.id as string, WORKER()).catch(() => undefined);
      }
    };
    if (op?.kind === OP_CREATE && (state === 'UNKNOWN' || state === 'PROVISIONING'))
      return release(this.reconcileCreate(res, op, acc, supportsLookup));
    if (op?.kind === OP_DELETE && (state === 'UNKNOWN' || state === 'DELETING'))
      return release(this.reconcileDelete(res, op, acc));
    if (op?.kind === OP_ACTION && state === 'UNKNOWN')
      return release(this.reconcileAct(res, op, acc));
    if (state === 'ACTIVE') return this.observeActive(res, acc);
    if ((state === 'FAILED' || state === 'DELETED') && res.provision_token && supportsLookup)
      return this.orphanCheck(res, acc);
    return {
      outcome: { result: 'skipped', action: `nothing to reconcile in state ${state}` },
      observed: {},
    };
  }

  // ---- create that ended uncertain -----------------------------------------------------------------------------------------
  private async reconcileCreate(
    res: Row,
    opRow: Row,
    acc: NonNullable<Awaited<ReturnType<ProvisioningService['access']>>>,
    supportsLookup: boolean,
  ) {
    const orgId = res.org_id as string;
    const worker = WORKER();
    if (!(await this.ops.claimReconcile(orgId, opRow.id as string, worker)))
      return {
        outcome: { result: 'skipped' as const, action: 'another worker holds the operation' },
        observed: {},
      };
    const op = (await this.ops.get(orgId, opRow.id as string))!;
    const input = op.input as CreateInput;
    const token = res.provision_token as string;
    let ref = (res.provider_ref as string | null) ?? null;
    let looked: { found: boolean; ref?: string } | null = null;
    if (!ref) {
      if (!supportsLookup) {
        const cycles = await this.bumpCycle(res, 'cannot_prove_absence');
        if (cycles >= this.cfg.caseAfterCycles)
          await this.openCase(
            res,
            'provider cannot look resources up by token: absence cannot be proven, a person must check the provider',
          );
        return {
          outcome: {
            result: 'cannot_prove_absence' as const,
            action: cycles >= this.cfg.caseAfterCycles ? 'admin case opened' : 'waiting',
          },
          observed: { cycles },
        };
      }
      const f = await acc.adapter.findByToken(acc.ctx, token);
      if (f.status !== 'succeeded')
        return {
          outcome: { result: 'error' as const, action: `lookup answered ${f.status}` },
          observed: {},
        };
      looked = f.data ? { found: true, ref: f.data.providerRef } : { found: false };
      ref = f.data?.providerRef ?? null;
    }
    if (ref) {
      const ins = await acc.adapter.inspect(acc.ctx, ref);
      if (ins.status === 'succeeded' && ins.data?.status === 'running') {
        await this.prov.finishCreate(orgId, op, worker, input, ref, ins.data, 'reconciler', true);
        return {
          outcome: {
            result: 'adopted' as const,
            action: 'adopted the provider resource; operation completed without a second create',
          },
          observed: { found: true, status: ins.data.status },
        };
      }
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE cloud.resources SET provider_ref = coalesce(provider_ref, $2), last_seen_at = $3 WHERE id = $1`,
          [res.id, ref, this.now()],
        ),
      );
      return {
        outcome: {
          result: 'adopted' as const,
          action: 'found at the provider; waiting for it to be running',
        },
        observed: { found: true, status: ins.data?.status ?? ins.status },
      };
    }
    // absent: collect observations; only PROVEN absence lets the provision be retried
    const prev = ((res.observed as { observations?: Observation[]; attemptAt?: string } | null) ??
      {}) as { observations?: Observation[]; attemptAt?: string; reason?: string };
    const attemptAt = prev.attemptAt
      ? Date.parse(prev.attemptAt)
      : Date.parse(String(res.updated_at));
    const observations = [
      ...(prev.observations ?? []),
      { at: this.now().getTime(), found: looked?.found ?? false },
    ].slice(-20);
    const proven = absenceProven(attemptAt, observations, this.cfg.absence);
    if (!proven) {
      await this.db.withOrg(orgId, (c) =>
        patchResource(c, res.id as string, { observed: { ...prev, observations } }),
      );
      return {
        outcome: {
          result: 'absence_pending' as const,
          action:
            'not found yet; not proof of absence (waiting out the provider consistency window)',
        },
        observed: { observations: observations.length },
      };
    }
    if (op.attempts >= op.max_attempts) {
      await this.prov.compensateCreate(
        orgId,
        op,
        worker,
        input,
        'provision_attempts_exhausted',
        'the provider never created the resource',
        'operation_failed',
        false,
        'reconciler',
      );
      return {
        outcome: {
          result: 'absence_proven' as const,
          action: 'absence proven and attempts exhausted: failed and authorization released',
        },
        observed: { observations: observations.length },
      };
    }
    await this.db.withOrg(orgId, async (c) => {
      await transitionResource(c, res.id as string, 'PROVISIONING', 'reconciler', {
        observed: {
          attemptAt: this.now().toISOString(),
          observations: [],
          retriedAfterProof: true,
        },
      });
      await c.query(
        `UPDATE compute.instances SET status = 'provisioning', updated_at = now(), version = version + 1 WHERE id = $1`,
        [input.instanceId],
      );
    });
    await this.audit.record({
      action: 'cloud.reconcile.absence_proven',
      orgId,
      actorType: 'system',
      resource: { type: 'compute_instance', id: input.instanceId },
      outcome: 'success',
      detail: { operationId: op.id, observations: observations.length },
    });
    await this.ops.resumeFromReconcile(orgId, op.id, worker);
    const resumed = (await this.ops.get(orgId, op.id))!;
    await this.prov.executeCreate(orgId, resumed, worker, 'provision');
    return {
      outcome: {
        result: 'absence_proven' as const,
        action: 'absence proven by lookup; provision retried once with the same token',
      },
      observed: { observations: observations.length },
    };
  }

  // ---- delete that ended uncertain -----------------------------------------------------------------------------------------
  private async reconcileDelete(
    res: Row,
    opRow: Row,
    acc: NonNullable<Awaited<ReturnType<ProvisioningService['access']>>>,
  ) {
    const orgId = res.org_id as string;
    const worker = WORKER();
    if (!(await this.ops.claimReconcile(orgId, opRow.id as string, worker)))
      return {
        outcome: { result: 'skipped' as const, action: 'another worker holds the operation' },
        observed: {},
      };
    const op = (await this.ops.get(orgId, opRow.id as string))!;
    const input = op.input as DeleteInput;
    const ref = res.provider_ref as string | null;
    if (!ref) {
      await this.prov.finishDelete(orgId, op, worker, input, 'reconciler');
      return {
        outcome: {
          result: 'adopted' as const,
          action: 'no provider resource exists: deletion completed',
        },
        observed: {},
      };
    }
    const ins = await acc.adapter.inspect(acc.ctx, ref);
    if (
      (ins.status === 'failed' && ins.error?.category === 'not_found') ||
      (ins.status === 'succeeded' && ins.data?.status === 'deleted')
    ) {
      await this.prov.finishDelete(orgId, op, worker, input, 'reconciler');
      return {
        outcome: {
          result: 'adopted' as const,
          action: 'the provider no longer has the resource: deletion completed',
        },
        observed: { absent: true },
      };
    }
    if (ins.status === 'succeeded') {
      await this.ops.resumeFromReconcile(orgId, op.id, worker);
      await this.prov.executeDelete(
        orgId,
        (await this.ops.get(orgId, op.id))!,
        worker,
        'reconciler',
      ); // delete is idempotent at the provider
      return {
        outcome: {
          result: 'adopted' as const,
          action: 'resource still exists: delete re-issued (idempotent)',
        },
        observed: { status: ins.data?.status },
      };
    }
    return {
      outcome: { result: 'error' as const, action: `inspect answered ${ins.status}` },
      observed: {},
    };
  }

  // ---- action that ended uncertain -----------------------------------------------------------------------------------------
  private async reconcileAct(
    res: Row,
    opRow: Row,
    acc: NonNullable<Awaited<ReturnType<ProvisioningService['access']>>>,
  ) {
    const orgId = res.org_id as string;
    const worker = WORKER();
    if (!(await this.ops.claimReconcile(orgId, opRow.id as string, worker)))
      return {
        outcome: { result: 'skipped' as const, action: 'another worker holds the operation' },
        observed: {},
      };
    const op = (await this.ops.get(orgId, opRow.id as string))!;
    const input = op.input as ActionInput;
    const ref = res.provider_ref as string;
    const ins = await acc.adapter.inspect(acc.ctx, ref);
    if (ins.status !== 'succeeded' || !ins.data)
      return {
        outcome: { result: 'error' as const, action: `inspect answered ${ins.status}` },
        observed: {},
      };
    const s: InstanceState = ins.data;
    const applied =
      (input.type === 'start' && s.status === 'running') ||
      (input.type === 'stop' && s.status === 'stopped') ||
      (input.type === 'resize' && s.planRef === input.targetPlan?.planRef);
    if (applied) {
      await this.prov.finishAct(orgId, op, worker, input, 'reconciler');
      return {
        outcome: {
          result: 'adopted' as const,
          action: `the ${input.type} had taken effect: completed`,
        },
        observed: { status: s.status },
      };
    }
    if (input.type === 'start' || input.type === 'stop' || input.type === 'resize') {
      await this.db.withOrg(orgId, async (c) => {
        await transitionResource(c, res.id as string, 'ACTIVE', 'reconciler', {
          last_seen_at: this.now(),
        });
        await c.query(
          `UPDATE compute.instances SET status = $2, updated_at = now(), version = version + 1 WHERE id = $1`,
          [input.instanceId, s.status === 'stopped' ? 'stopped' : 'running'],
        );
      });
      await this.ops.resumeFromReconcile(orgId, op.id, worker);
      await this.prov.executeAct(orgId, (await this.ops.get(orgId, op.id))!, worker);
      return {
        outcome: {
          result: 'absence_proven' as const,
          action: `the ${input.type} had not taken effect: re-issued (idempotent action)`,
        },
        observed: { status: s.status },
      };
    }
    // reboot / snapshot cannot be proven either way: never repeat them blindly; hand to a person
    await this.db.withOrg(orgId, async (c) => {
      await transitionResource(c, res.id as string, 'ACTIVE', 'reconciler', {
        last_seen_at: this.now(),
      });
      await c.query(
        `UPDATE compute.instances SET status = $2, updated_at = now(), version = version + 1 WHERE id = $1`,
        [input.instanceId, s.status === 'stopped' ? 'stopped' : 'running'],
      );
    });
    await this.prov.failAction(orgId, op, worker, input, 'outcome_unprovable');
    await this.openCase(
      res,
      `action ${input.type} ended uncertain and cannot be proven; not repeated`,
    );
    return {
      outcome: {
        result: 'cannot_prove_absence' as const,
        action: `${input.type} not repeated; admin case opened`,
      },
      observed: { status: s.status },
    };
  }

  // ---- drift of an ACTIVE resource -----------------------------------------------------------------------------------------
  private async observeActive(
    res: Row,
    acc: NonNullable<Awaited<ReturnType<ProvisioningService['access']>>>,
  ) {
    const orgId = res.org_id as string;
    const ref = res.provider_ref as string | null;
    if (!ref)
      return {
        outcome: {
          result: 'error' as const,
          action: 'ACTIVE resource without a provider reference',
        },
        observed: {},
      };
    const inst = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT id, status, plan FROM compute.instances WHERE resource_id = $1`, [
            res.id,
          ])
        ).rows[0] as Row | undefined,
    );
    const ins = await acc.adapter.inspect(acc.ctx, ref);
    const now = this.now();
    const observed: Observed =
      ins.status === 'succeeded' && ins.data && ins.data.status !== 'deleted'
        ? { kind: 'found', status: ins.data.status, planRef: ins.data.planRef }
        : (ins.status === 'succeeded' && ins.data?.status === 'deleted') ||
            (ins.status === 'failed' && ins.error?.category === 'not_found')
          ? { kind: 'absent' } // a deleted/terminated resource is gone for our purposes
          : { kind: 'unreadable' };
    const expected = {
      status: inst?.status === 'stopped' ? 'stopped' : 'running',
      planRef:
        (inst?.plan as { planRef?: string } | undefined)?.planRef ??
        (res.observed as { planRef?: string } | null)?.planRef ??
        '',
    };
    const verdict = classifyObservation(expected, observed);
    const prevMissing = Number(
      (res.observed as { missingCount?: number } | null)?.missingCount ?? 0,
    );
    if (verdict === 'unchanged')
      return {
        outcome: { result: 'error' as const, action: `provider answered ${ins.status}` },
        observed: {},
      };
    if (verdict === 'in_sync') {
      await this.db.withOrg(orgId, (c) =>
        patchResource(c, res.id as string, {
          last_seen_at: now,
          drift_state: 'in_sync',
          observed: { status: expected.status, planRef: expected.planRef, at: now.toISOString() },
        }),
      );
      return {
        outcome: { result: 'in_sync' as const, action: 'none' },
        observed: { status: expected.status },
      };
    }
    if (verdict === 'drift' && observed.kind === 'found') {
      await this.db.withOrg(orgId, async (c) => {
        await patchResource(c, res.id as string, {
          last_seen_at: now,
          drift_state: 'drift',
          observed: { status: observed.status, planRef: observed.planRef, at: now.toISOString() },
        });
        if (
          inst &&
          (observed.status === 'running' || observed.status === 'stopped') &&
          observed.status !== inst.status
        )
          await c.query(
            `UPDATE compute.instances SET status = $2, updated_at = now(), version = version + 1 WHERE id = $1`,
            [inst.id, observed.status],
          );
      });
      await this.audit.record({
        action: 'cloud.reconcile.drift_detected',
        orgId,
        actorType: 'system',
        resource: { type: 'cloud_resource', id: res.id as string },
        outcome: 'failure',
        detail: {
          kind: 'drift',
          expected,
          observed: { status: observed.status, planRef: observed.planRef },
        },
      });
      return {
        outcome: { result: 'drift' as const, action: 'recorded the provider state' },
        observed: { status: observed.status },
      };
    }
    // absent at the provider although we believe it is ACTIVE
    const missingCount = prevMissing + 1;
    await this.db.withOrg(orgId, async (c) => {
      await patchResource(c, res.id as string, {
        last_seen_at: now,
        drift_state: 'missing',
        observed: { missingCount, at: now.toISOString(), planRef: expected.planRef },
      });
      if (missingCount >= this.cfg.missingConfirmations)
        await c.query(
          `UPDATE compute.instance_intervals SET ended_at = $2 WHERE resource_id = $1 AND ended_at IS NULL`,
          [res.id, now],
        ); // never bill what the provider no longer has
    });
    await this.audit.record({
      action: 'cloud.reconcile.drift_detected',
      orgId,
      actorType: 'system',
      resource: { type: 'cloud_resource', id: res.id as string },
      outcome: 'failure',
      detail: { kind: 'missing', missingCount },
    });
    return {
      outcome: {
        result: 'missing' as const,
        action:
          missingCount >= this.cfg.missingConfirmations
            ? 'confirmed missing: metering stopped'
            : 'first missing observation',
      },
      observed: { missingCount },
    };
  }

  // ---- orphans -------------------------------------------------------------------------------------------------------------
  private async orphanCheck(
    res: Row,
    acc: NonNullable<Awaited<ReturnType<ProvisioningService['access']>>>,
  ) {
    const f = await acc.adapter.findByToken(acc.ctx, res.provision_token as string);
    if (f.status !== 'succeeded')
      return {
        outcome: { result: 'error' as const, action: `lookup answered ${f.status}` },
        observed: {},
      };
    if (!f.data)
      return {
        outcome: { result: 'in_sync' as const, action: 'no provider resource carries this token' },
        observed: { found: false },
      };
    const orgId = res.org_id as string;
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE cloud.resources SET provider_ref = coalesce(provider_ref, $2) WHERE id = $1`,
        [res.id, f.data!.providerRef],
      );
    });
    await this.openCase(
      res,
      'a billable provider resource exists for a failed/deleted resource (orphan suspected)',
    );
    if (this.cfg.autoDeleteOrphans && acc.adapter.delete) {
      const d = await acc.adapter.delete(acc.ctx, f.data.providerRef);
      await this.audit.record({
        action: 'cloud.orphan.auto_deleted',
        orgId,
        actorType: 'system',
        resource: { type: 'cloud_resource', id: res.id as string },
        outcome: d.status === 'succeeded' ? 'success' : 'failure',
        detail: { flag: 'CLOUD_AUTO_DELETE_ORPHANS' },
      });
      return {
        outcome: {
          result: 'orphan_suspected' as const,
          action: `auto-delete flag ON: delete answered ${d.status}`,
        },
        observed: { found: true },
      };
    }
    return {
      outcome: {
        result: 'orphan_suspected' as const,
        action: 'admin case opened; nothing deleted',
      },
      observed: { found: true },
    };
  }

  /** Opens (once) the admin case for a resource and audits it. */
  private async openCase(res: Row, detail: string): Promise<void> {
    const orgId = res.org_id as string;
    const opened = await this.db.withOrg(orgId, async (c) => {
      const cur = (
        await c.query(`SELECT case_opened_at FROM cloud.resources WHERE id = $1`, [res.id])
      ).rows[0] as Row;
      if (cur.case_opened_at) return false;
      await patchResource(c, res.id as string, {
        drift_state: 'orphan_suspected',
        case_opened_at: this.now(),
        case_detail: { reason: detail },
      });
      return true;
    });
    if (opened)
      await this.audit.record({
        action: 'orphan.case.opened',
        orgId,
        actorType: 'system',
        resource: { type: 'cloud_resource', id: res.id as string },
        outcome: 'failure',
        detail: { reason: detail },
      });
  }

  private async bumpCycle(res: Row, key: string): Promise<number> {
    const orgId = res.org_id as string;
    return this.db.withOrg(orgId, async (c) => {
      const cur = (await c.query(`SELECT observed FROM cloud.resources WHERE id = $1`, [res.id]))
        .rows[0] as Row;
      const o = ((cur.observed as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const n = Number(o[`${key}Cycles`] ?? 0) + 1;
      await patchResource(c, res.id as string, { observed: { ...o, [`${key}Cycles`]: n } });
      return n;
    });
  }

  // ---- scheduling ----------------------------------------------------------------------------------------------------------
  /** Which resources need a look now (scheduled sweep). Times come from the injected clock so tests control them. */
  async dueResources(): Promise<string[]> {
    const now = this.now().getTime();
    const stuck = new Date(now - this.cfg.stuckAfterMs);
    const seen = new Date(now - this.cfg.driftIntervalMs);
    const lookback = new Date(now - 7 * 86_400_000);
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT id FROM cloud.resources
            WHERE state = 'UNKNOWN'
               OR (state IN ('PROVISIONING','DELETING') AND updated_at < $1)
               OR (state = 'ACTIVE' AND (last_seen_at IS NULL OR last_seen_at < $2))
               OR (state IN ('FAILED','DELETED') AND provision_token IS NOT NULL AND provider_ref IS NULL AND drift_state <> 'orphan_suspected' AND updated_at > $3)
            ORDER BY updated_at LIMIT $4`,
          [stuck, seen, lookback, this.cfg.batch],
        )
      ).rows.map((r) => r.id as string),
    );
  }

  /** One scheduled cycle: run due backoff retries of compute operations, then reconcile every due resource. */
  async sweep(): Promise<{ resumed: number; reconciled: number }> {
    const worker = WORKER();
    const claimed = await this.ops.claimDue(worker, {
      kinds: COMPUTE_OP_KINDS,
      onlyPending: true,
      batch: 20,
    });
    let resumed = 0;
    for (const cl of claimed) {
      const op = await this.ops.get(cl.orgId, cl.id);
      if (op?.state === 'running') {
        resumed++;
        await this.prov.execute(cl.orgId, op as Operation, worker).catch(() => undefined);
      }
    }
    let reconciled = 0;
    for (const id of await this.dueResources()) {
      await this.reconcileResource(id, { trigger: 'scheduled' }).catch(() => undefined);
      reconciled++;
    }
    return { resumed, reconciled };
  }
}
