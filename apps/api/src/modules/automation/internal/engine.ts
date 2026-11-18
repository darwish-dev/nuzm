import { v7 as uuidv7 } from 'uuid';
import { OperationsService, emitUsage, usageEventId, type Db } from '@nuzm/platform';
import { ExpressionError, evalExpression, indexSteps, stepBackoffSeconds, stepIdempotencyKey, stepIsIdempotent, type StepDef, type WorkflowDefinition } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { ActionRunner, renderParams, type StepRuntime } from './actions';
import type { AutomationConfig, Row } from './model';
import { ActionError } from './ports';
import { redact, sanitize } from './redact';

export const EXECUTION_OP_KIND = 'automation.execution';
export type RunResult = 'finished' | 'failed' | 'cancelled' | 'deferred' | 'not_claimed';

/** Thrown by a test hook to emulate a killed worker: the engine never catches it, so the database is left exactly as a real kill would leave it. */
export class SimulatedCrash extends Error {}
export type CrashPoint = 'before_effect' | 'after_effect' | 'after_step_commit';
export interface EngineHooks {
  at?(point: CrashPoint, ctx: { executionId: string; stepKey: string; attempt: number }): void | Promise<void>;
}

interface Cursor {
  current?: string | null;
  steps?: Record<string, { output: unknown }>;
  loop?: { id: string; items: unknown[]; i: number; b: number; results: Record<string, { output: unknown }>[] };
}
type StepResult = { kind: 'ok'; output: unknown; next?: string } | { kind: 'deferred' } | { kind: 'failed' };

const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const ACTION_TYPES = ['http_request', 'nuzm_api', 'send_email', 'start_ai_run', 'create_deployment'];

/**
 * The durable execution engine (M11 S51). It runs on `platform.operations` (lease, heartbeat, retry, cancel) and keeps ALL progress in the database:
 * `executions.cursor` (where it is, the outputs so far) and one `execution_steps` row per attempt. A worker that dies at ANY point is replaced by whoever claims
 * the operation next, which resumes from what is persisted:
 *   - a step whose attempt is recorded `succeeded` is NEVER executed again (its output is reused);
 *   - an attempt found `running` (the worker died inside it) has an UNCERTAIN outcome: an idempotent step is attempted again with the SAME idempotency key
 *     (sha256(rootExecutionId|stepKey|attemptGroup)), so the receiver dedupes: at-least-once delivery, exactly-once effect; a NON-idempotent step is never
 *     repeated: the execution fails with `uncertain_outcome` and a dead letter, and a person reconciles before replaying;
 *   - retries use exponential backoff with jitter (default 5 attempts) and park the operation until due (`defer`), no worker sleeps.
 * Every failure that ends a step lands in `dead_letters`; the connector gate is re-checked before EVERY step, so a revoked authorization stops a running execution at
 * its next step. Logs (inputs, outputs, errors) are secret-redacted before they reach the database.
 */
export class ExecutionEngine {
  hooks: EngineHooks = {};
  constructor(
    private readonly db: Db,
    private readonly ops: OperationsService,
    private readonly audit: AuditSink,
    private readonly actions: ActionRunner,
    private readonly cfg: AutomationConfig,
    private readonly random: () => number = Math.random,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async crash(point: CrashPoint, ctx: { executionId: string; stepKey: string; attempt: number }) {
    await this.hooks.at?.(point, ctx);
  }

  async runOne(orgId: string, executionId: string, workerId = `api-${process.pid}`): Promise<RunResult> {
    const ex = await this.load(orgId, executionId);
    if (!ex || TERMINAL.includes(ex.status)) return 'finished';
    if (!ex.operation_id) return 'not_claimed';
    const claim = await this.ops.claimById(orgId, ex.operation_id, workerId, { leaseSeconds: this.cfg.leaseSeconds });
    if (!claim) return 'not_claimed';
    try {
      return await this.drive(orgId, ex, ex.operation_id as string, workerId);
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      // an engine/infrastructure error (not a step outcome): hand the operation back through its retry policy; progress is already persisted
      await this.ops.fail(orgId, ex.operation_id as string, workerId, { code: 'engine_error', message: (e as Error).message.slice(0, 300) }).catch(() => undefined);
      return 'deferred';
    }
  }

  private async load(orgId: string, id: string): Promise<Row | undefined> {
    return (await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM automation.executions WHERE id = $1 AND org_id = $2`, [id, orgId])).rows[0])) as Row | undefined;
  }

  private async drive(orgId: string, ex: Row, opId: string, workerId: string): Promise<RunResult> {
    // 1. cancellation and kill switch
    const op = await this.ops.get(orgId, opId);
    if (op?.cancel_requested) return this.cancel(orgId, ex, opId, workerId, 'cancelled by request');
    const wf = (await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM automation.workflows WHERE id = $1`, [ex.workflow_id])).rows[0])) as Row | undefined;
    if (!wf || wf.status === 'paused' || wf.status === 'disabled') return this.cancel(orgId, ex, opId, workerId, `the workflow is ${wf?.status ?? 'gone'}`);
    // 2. per-organization concurrency cap (the hard bound; rate limits elsewhere are per process)
    if (ex.status !== 'running' || !ex.started_at) {
      const running = await this.db.withOrg(orgId, async (c) => Number((await c.query(`SELECT count(*) n FROM automation.executions WHERE org_id = $1 AND status = 'running' AND id <> $2`, [orgId, ex.id])).rows[0]!.n));
      if (running >= this.cfg.maxConcurrentPerOrg) {
        await this.ops.defer(orgId, opId, workerId, new Date(this.now().getTime() + 2000));
        return 'deferred';
      }
    }
    const version = (await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT definition FROM automation.workflow_versions WHERE id = $1`, [ex.version_id])).rows[0])) as Row;
    const def = version.definition as WorkflowDefinition;
    const steps = indexSteps(def);

    // 3. mark running; the first start emits the execution meter and the audit event in the same transaction
    await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(`UPDATE automation.executions SET status = 'running', wake_at = NULL, started_at = coalesce(started_at, now()) WHERE id = $1 AND status IN ('queued','running','waiting') RETURNING started_at, created_at`, [ex.id]);
      if (!ex.started_at && r.rows[0]) {
        const t = (r.rows[0].started_at as Date).toISOString();
        await emitUsage(c, {
          eventId: usageEventId({ orgId, meterId: 'automation.executions', resourceId: ex.id, windowStart: (ex.created_at as Date).toISOString() }),
          orgId, meterId: 'automation.executions', quantity: '1', unit: 'execution', resourceId: ex.id,
          windowStart: (ex.created_at as Date).toISOString(), windowEnd: (ex.created_at as Date).toISOString(), occurredAt: t, dataRegion: ex.data_region, source: 'automation@M11',
        });
        await this.audit.record({ action: 'workflow.execution.started', actorType: 'system', orgId, resource: { type: 'workflow_execution', id: ex.id }, outcome: 'success', detail: { workflowId: ex.workflow_id, trigger: ex.trigger } });
      }
    });

    const cursor: Cursor = (ex.cursor as Cursor) ?? {};
    const scope = {
      input: ex.input,
      steps: (cursor.steps ?? {}) as Record<string, { output: unknown }>,
      trigger: { type: ex.trigger, ref: ex.trigger_ref },
      execution: { id: ex.id },
    };
    const rootId = (ex.key_root_id as string | null) ?? (ex.id as string);
    let current: string | null | undefined = cursor.current === undefined ? def.start : cursor.current;
    const ctx = { orgId, ex, rootId, opId, workerId, ownerUserId: (wf.owner_user_id as string | null) ?? '00000000-0000-0000-0000-000000000000', dataRegion: ex.data_region as string };

    while (current) {
      await this.ops.heartbeat(orgId, opId, workerId, this.cfg.leaseSeconds).catch(() => undefined);
      const cancelNow = await this.ops.get(orgId, opId);
      if (cancelNow?.cancel_requested) return this.cancel(orgId, ex, opId, workerId, 'cancelled by request');
      const s: StepDef & { body?: StepDef[] } = steps.get(current)!;
      let r: StepResult;
      if (s.type === 'loop') r = await this.loop(ctx, s as StepDef & { body: StepDef[] }, scope, cursor);
      else r = await this.step(ctx, s, s.id, scope);
      if (r.kind === 'deferred') return 'deferred';
      if (r.kind === 'failed') return 'failed';
      scope.steps[s.id] = { output: r.output };
      const next: string | null = s.type === 'condition' ? ((r.output as { result: boolean }).result ? (s.onTrue ?? null) : (s.onFalse ?? null)) : (s.next ?? null);
      cursor.loop = undefined;
      cursor.current = next;
      cursor.steps = scope.steps;
      await this.saveCursor(orgId, ex.id, cursor);
      current = next;
    }
    await this.db.withOrg(orgId, (c) => c.query(`UPDATE automation.executions SET status = 'succeeded', finished_at = now(), cursor = $2 WHERE id = $1`, [ex.id, JSON.stringify({ ...cursor, current: null })]));
    await this.db.withOrg(orgId, (c) => c.query(`UPDATE automation.workflows SET last_run_at = now() WHERE id = $1`, [ex.workflow_id]));
    await this.ops.succeed(orgId, opId, workerId, { executionId: ex.id, status: 'succeeded' });
    return 'finished';
  }

  private async saveCursor(orgId: string, id: string, cursor: Cursor): Promise<void> {
    const json = JSON.stringify(cursor);
    if (Buffer.byteLength(json) > this.cfg.scopeCapBytes) throw new ActionError('scope_too_large', 'the outputs of the steps so far are larger than the cap');
    await this.db.withOrg(orgId, (c) => c.query(`UPDATE automation.executions SET cursor = $2 WHERE id = $1`, [id, json]));
  }

  // ---- loop -------------------------------------------------------------------------------------------------------------------
  private async loop(
    ctx: Ctx,
    s: StepDef & { body: StepDef[] },
    scope: { input: unknown; steps: Record<string, { output: unknown }>; trigger: unknown; execution: unknown },
    cursor: Cursor,
  ): Promise<StepResult> {
    const max = s.params.maxIterations as number;
    let st = cursor.loop && cursor.loop.id === s.id ? cursor.loop : undefined;
    if (!st) {
      let items: unknown;
      try {
        items = evalExpression(String(s.params.over), scope);
      } catch (e) {
        return this.failStep(ctx, s.id, 1, e, [], 'expression_error');
      }
      if (!Array.isArray(items)) return this.failStep(ctx, s.id, 1, new ActionError('loop_not_array', 'the loop expression did not produce an array'), []);
      if (items.length > max) return this.failStep(ctx, s.id, 1, new ActionError('loop_bound_exceeded', `the loop has ${items.length} items; the bound is ${max}`), []);
      st = { id: s.id, items, i: 0, b: 0, results: [] };
    }
    while (st.i < st.items.length) {
      const iterSteps: Record<string, { output: unknown }> = st.results[st.i] ?? {};
      while (st.b < s.body.length) {
        const b = s.body[st.b]!;
        const key = `${s.id}[${st.i}].${b.id}`;
        const iterScope = { ...scope, steps: { ...scope.steps, ...iterSteps }, item: st.items[st.i], index: st.i };
        const r = await this.step(ctx, b, key, iterScope);
        if (r.kind !== 'ok') return r;
        iterSteps[b.id] = { output: r.output };
        st.results[st.i] = iterSteps;
        st.b++;
        cursor.loop = st;
        cursor.current = s.id;
        cursor.steps = scope.steps;
        await this.saveCursor(ctx.orgId, ctx.ex.id, cursor);
      }
      st.i++;
      st.b = 0;
    }
    return { kind: 'ok', output: { iterations: st.items.length, results: st.results.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.output]))) } };
  }

  // ---- one step ---------------------------------------------------------------------------------------------------------------
  private async step(
    ctx: Ctx,
    s: StepDef,
    stepKey: string,
    scope: Record<string, unknown>,
  ): Promise<StepResult> {
    const { orgId, ex } = ctx;
    const rows = (await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT * FROM automation.execution_steps WHERE execution_id = $1 AND step_key = $2 ORDER BY attempt`, [ex.id, stepKey])).rows)) as Row[];
    const last = rows[rows.length - 1];
    if (last?.status === 'succeeded') return { kind: 'ok', output: last.output?.__output ?? last.output, next: undefined };
    const idempotent = stepIsIdempotent(s);

    // delay: durable pause
    if (s.type === 'delay') return this.delay(ctx, s, stepKey, last);

    // pure steps: no external effect, recorded in one insert
    if (!ACTION_TYPES.includes(s.type)) return this.pure(ctx, s, stepKey, scope, last);

    // the worker that held this step died inside it: the outcome is UNCERTAIN
    if (last?.status === 'running') {
      await this.db.withOrg(orgId, (c) => c.query(`UPDATE automation.execution_steps SET status = 'unknown', error = $2, finished_at = now() WHERE id = $1`, [last.id, JSON.stringify({ code: 'interrupted', message: 'the worker stopped while the step was running; the outcome is uncertain' })]));
      if (!idempotent) {
        return this.failStep(ctx, stepKey, last.attempt, new ActionError('uncertain_outcome', 'a non-idempotent step was interrupted; it is NOT retried automatically: reconcile the target, then replay', { retryable: false, uncertain: true }), []);
      }
    }
    const attempt = (last?.attempt ?? 0) + 1;
    const allowed = s.retry?.maxAttempts ?? this.cfg.retryMaxAttempts;
    const key = stepIdempotencyKey(ctx.rootId, stepKey, '0');
    const t0 = this.now();
    const input = sanitize(renderSafe(s, scope), [], this.cfg.outputCapBytes);
    await this.db.withOrg(orgId, (c) =>
      c.query(`INSERT INTO automation.execution_steps (id, org_id, execution_id, step_key, attempt_group, attempt, status, idempotent, idempotency_key, input, started_at, step_type) VALUES ($1,$2,$3,$4,'0',$5,'running',$6,$7,$8,$9,$10)`, [uuidv7(), orgId, ex.id, stepKey, attempt, idempotent, key, JSON.stringify(input), t0, s.type]),
    );
    const rt: StepRuntime = { orgId, executionId: ex.id, stepKey, attempt, idempotencyKey: key, idempotent, dataRegion: ctx.dataRegion, actorUserId: ctx.ownerUserId };
    const here = { executionId: ex.id as string, stepKey, attempt };
    await this.crash('before_effect', here);
    let out;
    try {
      out = await this.actions.run(s, scope, rt);
      await this.crash('after_effect', here);
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      const secrets = ((e as { secrets?: string[] }).secrets ?? []) as string[];
      const err = toActionError(e);
      const safeToRepeat = idempotent || err.code === 'rate_limited' || err.code === 'circuit_open';
      if (err.retryable && safeToRepeat && attempt < allowed) {
        await this.recordFailed(ctx, stepKey, attempt, err, secrets);
        const delay = this.cfg.retryBaseSeconds === 0 ? 0 : stepBackoffSeconds(attempt, { maxAttempts: allowed, baseSeconds: this.cfg.retryBaseSeconds, capSeconds: this.cfg.retryCapSeconds }, this.random);
        await this.db.withOrg(orgId, (c) => c.query(`UPDATE automation.executions SET status = 'waiting', wake_at = $2 WHERE id = $1`, [ex.id, new Date(this.now().getTime() + delay * 1000)]));
        await this.ops.defer(orgId, ctx.opId, ctx.workerId, new Date(this.now().getTime() + delay * 1000));
        return { kind: 'deferred' };
      }
      return this.failStep(ctx, stepKey, attempt, err, secrets, undefined, !safeToRepeat && err.retryable ? 'not retried: the step is not idempotent' : undefined);
    }
    // success: the step row, the billing meter and (for the caller) the cursor follow; one transaction for the first two
    const output = sanitize(out.output, out.secrets, this.cfg.outputCapBytes);
    const finished = this.now();
    await this.db.withOrg(orgId, async (c) => {
      await c.query(`UPDATE automation.execution_steps SET status = 'succeeded', output = $4, finished_at = $5 WHERE execution_id = $1 AND step_key = $2 AND attempt = $3`, [ex.id, stepKey, attempt, JSON.stringify({ __output: output }), finished]);
      await c.query(`UPDATE automation.executions SET steps_run = steps_run + 1 WHERE id = $1`, [ex.id]);
      if (out.billable)
        await emitUsage(c, {
          eventId: usageEventId({ orgId, meterId: 'automation.steps', resourceId: ex.id, windowStart: t0.toISOString(), sourceSeq: `${stepKey}:${attempt}` }),
          orgId, meterId: 'automation.steps', quantity: '1', unit: 'step', resourceId: ex.id, windowStart: t0.toISOString(), windowEnd: t0.toISOString(), occurredAt: finished.toISOString(),
          dimensions: out.connectorId ? { connector: out.connectorId } : undefined, dataRegion: ctx.dataRegion, source: 'automation@M11',
        });
    });
    await this.crash('after_step_commit', here);
    return { kind: 'ok', output };
  }

  private async delay(ctx: Ctx, s: StepDef, stepKey: string, last: Row | undefined): Promise<StepResult> {
    const { orgId, ex } = ctx;
    const key = stepIdempotencyKey(ctx.rootId, stepKey, '0');
    if (!last) {
      const wakeAt = new Date(this.now().getTime() + (s.params.seconds as number) * 1000);
      await this.db.withOrg(orgId, async (c) => {
        await c.query(`INSERT INTO automation.execution_steps (id, org_id, execution_id, step_key, attempt, status, idempotent, idempotency_key, output, step_type) VALUES ($1,$2,$3,$4,1,'waiting',true,$5,$6,'delay')`, [uuidv7(), orgId, ex.id, stepKey, key, JSON.stringify({ wakeAt: wakeAt.toISOString() })]);
        await c.query(`UPDATE automation.executions SET status = 'waiting', wake_at = $2 WHERE id = $1`, [ex.id, wakeAt]);
      });
      await this.ops.defer(orgId, ctx.opId, ctx.workerId, wakeAt);
      return { kind: 'deferred' };
    }
    const wake = new Date((last.output as { wakeAt: string }).wakeAt);
    if (this.now() < wake) {
      await this.ops.defer(orgId, ctx.opId, ctx.workerId, wake);
      return { kind: 'deferred' };
    }
    await this.db.withOrg(orgId, (c) => c.query(`UPDATE automation.execution_steps SET status = 'succeeded', finished_at = now(), output = $2 WHERE id = $1`, [last.id, JSON.stringify({ __output: { waitedSeconds: s.params.seconds } })]));
    return { kind: 'ok', output: { waitedSeconds: s.params.seconds } };
  }

  private async pure(ctx: Ctx, s: StepDef, stepKey: string, scope: Record<string, unknown>, last: Row | undefined): Promise<StepResult> {
    const { orgId, ex } = ctx;
    let output: unknown;
    try {
      if (s.type === 'condition') output = { result: Boolean(evalExpression(String(s.params.expr), scope)) };
      else if (s.type === 'transform') output = renderParams(s.params.output, scope);
      else throw new ActionError('unsupported_step', `unknown step type ${s.type}`);
    } catch (e) {
      return this.failStep(ctx, stepKey, (last?.attempt ?? 0) + 1, e, [], e instanceof ExpressionError ? 'expression_error' : undefined);
    }
    const safe = sanitize(output, [], this.cfg.outputCapBytes);
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `INSERT INTO automation.execution_steps (id, org_id, execution_id, step_key, attempt, status, idempotent, idempotency_key, output, finished_at, step_type) VALUES ($1,$2,$3,$4,$5,'succeeded',true,$6,$7,now(),$8) ON CONFLICT (execution_id, step_key, attempt) DO NOTHING`,
        [uuidv7(), orgId, ex.id, stepKey, (last?.attempt ?? 0) + 1, stepIdempotencyKey(ctx.rootId, stepKey, '0'), JSON.stringify({ __output: safe }), s.type],
      );
      await c.query(`UPDATE automation.executions SET steps_run = steps_run + 1 WHERE id = $1`, [ex.id]);
    });
    return { kind: 'ok', output: safe };
  }

  // ---- outcomes ---------------------------------------------------------------------------------------------------------------
  private async recordFailed(ctx: Ctx, stepKey: string, attempt: number, err: ActionError, secrets: string[]) {
    const e = redact({ code: err.code, message: err.message, httpStatus: err.httpStatus ?? null, uncertain: err.uncertain, retryable: err.retryable }, secrets);
    await this.db.withOrg(ctx.orgId, (c) =>
      c.query(`UPDATE automation.execution_steps SET status = 'failed', error = $4, finished_at = now() WHERE execution_id = $1 AND step_key = $2 AND attempt = $3`, [ctx.ex.id, stepKey, attempt, JSON.stringify(e)]),
    );
  }

  /** The step cannot be completed: record the failed attempt, dead-letter it, fail the execution and the operation. */
  private async failStep(ctx: Ctx, stepKey: string, attempt: number, raw: unknown, secrets: string[], code?: string, reason?: string): Promise<StepResult> {
    const err = toActionError(raw, code);
    const { orgId, ex } = ctx;
    const error = redact({ code: err.code, message: err.message, httpStatus: err.httpStatus ?? null, uncertain: err.uncertain, ...(reason ? { note: reason } : {}) }, secrets) as Record<string, unknown>;
    await this.db.withOrg(orgId, async (c) => {
      const upd = await c.query(`UPDATE automation.execution_steps SET status = CASE WHEN status = 'running' THEN 'failed' ELSE status END, error = coalesce(error, $4), finished_at = coalesce(finished_at, now()) WHERE execution_id = $1 AND step_key = $2 AND attempt = $3`, [ex.id, stepKey, attempt, JSON.stringify(error)]);
      if (!upd.rowCount)
        await c.query(`INSERT INTO automation.execution_steps (id, org_id, execution_id, step_key, attempt, status, idempotent, idempotency_key, error, finished_at) VALUES ($1,$2,$3,$4,$5,'failed',true,$6,$7,now()) ON CONFLICT DO NOTHING`, [uuidv7(), orgId, ex.id, stepKey, attempt, stepIdempotencyKey(ctx.rootId, stepKey, '0'), JSON.stringify(error)]);
      const payload = (await c.query(`SELECT input FROM automation.execution_steps WHERE execution_id = $1 AND step_key = $2 ORDER BY attempt DESC LIMIT 1`, [ex.id, stepKey])).rows[0]?.input ?? null;
      await c.query(`INSERT INTO automation.dead_letters (id, org_id, execution_id, step_key, reason, error, payload) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (execution_id, step_key) DO NOTHING`, [uuidv7(), orgId, ex.id, stepKey, `${err.code}: ${err.message}`.slice(0, 500), JSON.stringify(error), payload === null ? null : JSON.stringify(payload)]);
      await c.query(`UPDATE automation.executions SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status NOT IN ('succeeded','failed','cancelled')`, [ex.id, JSON.stringify({ stepKey, ...error })]);
      await this.audit.record({ action: 'workflow.execution.failed', actorType: 'system', orgId, resource: { type: 'workflow_execution', id: ex.id }, outcome: 'failure', detail: { workflowId: ex.workflow_id, stepKey, code: err.code } });
    });
    await this.ops.failPermanently(orgId, ctx.opId, ctx.workerId, { code: err.code, stepKey }).catch(() => undefined);
    return { kind: 'failed' };
  }

  private async cancel(orgId: string, ex: Row, opId: string, workerId: string, why: string): Promise<RunResult> {
    await this.db.withOrg(orgId, (c) => c.query(`UPDATE automation.executions SET status = 'cancelled', finished_at = now(), error = $2 WHERE id = $1 AND status NOT IN ('succeeded','failed','cancelled')`, [ex.id, JSON.stringify({ code: 'cancelled', message: why })]));
    await this.ops.finishCancelled(orgId, opId, workerId).catch(() => undefined);
    return 'cancelled';
  }
}

interface Ctx {
  orgId: string;
  ex: Row;
  rootId: string;
  opId: string;
  workerId: string;
  ownerUserId: string;
  dataRegion: string;
}

function renderSafe(s: StepDef, scope: Record<string, unknown>): unknown {
  try {
    const { connectorId: _c, ...rest } = s.params as Record<string, unknown>;
    return renderParams(rest, scope);
  } catch {
    return { unrenderable: true };
  }
}

function toActionError(e: unknown, code?: string): ActionError {
  if (e instanceof ActionError) return e;
  if (e instanceof ProblemException) return new ActionError(e.code, e.detail ?? e.message, { retryable: false });
  if (e instanceof ExpressionError) return new ActionError(code ?? 'expression_error', e.message, { retryable: false });
  return new ActionError(code ?? 'internal_error', (e as Error)?.message?.slice(0, 300) ?? 'unexpected error', { retryable: true, uncertain: true });
}
