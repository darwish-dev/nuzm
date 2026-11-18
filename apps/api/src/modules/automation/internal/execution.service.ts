import { v7 as uuidv7 } from 'uuid';
import { OperationsService, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { QuotaService } from '../../billing';
import { EXECUTION_OP_KIND } from './engine';
import { badRequest, hint, isUuid, iso, type AutomationConfig, type Row } from './model';
import { sanitize } from './redact';

export interface ExecutionStepDto {
  stepKey: string;
  attempt: number;
  status: string;
  idempotent: boolean;
  input: unknown;
  output: unknown;
  error: unknown;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ExecutionDto {
  id: string;
  workflowId: string;
  versionId: string;
  trigger: string;
  status: string;
  input: unknown;
  operationId: string | null;
  error: unknown;
  stepsRun: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  duplicate?: boolean;
  steps?: ExecutionStepDto[];
  deadLetters?: { id: string; stepKey: string; reason: string; replayedAt: string | null }[];
}

const unwrap = (v: unknown) => (v && typeof v === 'object' && '__output' in (v as object) ? (v as { __output: unknown }).__output : v);

/** Creating, reading, cancelling and replaying executions. The execution row is created by `automation.enqueue_execution` (one idempotent place) and driven by the engine. */
export class ExecutionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly quotas: Pick<QuotaService, 'check'>,
    private readonly cfg: AutomationConfig,
  ) {}

  private dto(r: Row, extra: Partial<ExecutionDto> = {}): ExecutionDto {
    return {
      id: r.id, workflowId: r.workflow_id, versionId: r.version_id, trigger: r.trigger, status: r.status, input: r.input, operationId: r.operation_id ?? null,
      error: r.error ?? null, stepsRun: r.steps_run, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), createdAt: iso(r.created_at)!, ...extra,
    };
  }

  /** The single insert path (also used by the scheduler, inbound webhooks and platform events). Maps the database's refusals to problems. */
  async enqueue(orgId: string, i: { workflowId: string; trigger: 'manual' | 'schedule' | 'webhook' | 'platform_event' | 'replay'; triggerRef?: string; dedupeKey: string; input: unknown; versionId?: string; origin?: string; depth?: number; keyRoot?: string; cursor?: unknown }): Promise<{ id: string; created: boolean }> {
    const id = uuidv7();
    try {
      const r = await this.db.withOrg(orgId, async (c) =>
        (
          await c.query(`SELECT * FROM automation.enqueue_execution($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
            id, orgId, i.workflowId, i.trigger, i.triggerRef ?? null, i.dedupeKey, JSON.stringify(i.input ?? {}), i.origin ?? null, i.depth ?? 0, i.keyRoot ?? null, JSON.stringify(i.cursor ?? {}), i.versionId ?? null,
          ])
        ).rows[0] as { execution_id: string; created: boolean },
      );
      return { id: r.execution_id, created: r.created };
    } catch (e) {
      const h = hint(e);
      if (h === 'feature_disabled') throw new ProblemException('feature_disabled', 'automation is not enabled for this organization');
      if (h === 'not_found') throw new ProblemException('not_found');
      if (h === 'not_runnable') throw new ProblemException('invalid_state', (e as Error).message);
      throw e;
    }
  }

  /** Attach the platform operation that drives a `queued` execution (idempotent: an execution that already has one keeps it). */
  async ensureOperation(orgId: string, executionId: string, actor?: string): Promise<string> {
    const row = (await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT operation_id FROM automation.executions WHERE id = $1`, [executionId])).rows[0])) as Row | undefined;
    if (!row) throw new ProblemException('not_found');
    if (row.operation_id) return row.operation_id;
    const op = await this.ops.create(orgId, { kind: EXECUTION_OP_KIND, input: { executionId }, resourceKind: 'workflow_execution', resourceId: executionId, createdBy: actor, idempotencyKey: `execution:${executionId}`, maxAttempts: 10 });
    const set = await this.db.withOrg(orgId, async (c) => (await c.query(`UPDATE automation.executions SET operation_id = $2 WHERE id = $1 AND operation_id IS NULL RETURNING operation_id`, [executionId, op.id])).rows[0]);
    if (set) return op.id;
    // a parallel caller attached another operation first: cancel ours and use theirs
    await this.ops.requestCancel(orgId, op.id).catch(() => undefined);
    return ((await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT operation_id FROM automation.executions WHERE id = $1`, [executionId])).rows[0])) as Row).operation_id;
  }

  /** POST /v1/workflows/{id}/executions */
  async create(orgId: string, actor: string, workflowId: string, body: Record<string, unknown>): Promise<ExecutionDto> {
    for (const k of Object.keys(body)) if (!['versionId', 'input', 'dedupeKey'].includes(k)) throw badRequest(`unknown field ${k}`);
    if (!isUuid(workflowId)) throw new ProblemException('not_found');
    if (typeof body.dedupeKey !== 'string' || body.dedupeKey.length < 1 || body.dedupeKey.length > 200) throw badRequest('dedupeKey is required (1..200 characters)');
    if (body.versionId !== undefined && !isUuid(body.versionId)) throw badRequest('versionId must be a uuid');
    if (body.input !== undefined && (body.input === null || typeof body.input !== 'object' || Array.isArray(body.input))) throw badRequest('input must be an object');
    const input = sanitize(body.input ?? {}, [], 64 * 1024);
    if ((input as { truncated?: boolean }).truncated) throw badRequest('input is larger than 64 KB');
    // quota (plan limit, when one is defined) and the per-minute start rate of the organization: 429 with the reason
    const q = await this.quotas.check(orgId, 'automation', '1');
    if (!q.allowed) throw new ProblemException('rate_limited', 'the automation quota of the plan is exhausted');
    const recent = await this.db.withOrg(orgId, async (c) => Number((await c.query(`SELECT count(*) n FROM automation.executions WHERE org_id = $1 AND created_at > now() - interval '1 minute'`, [orgId])).rows[0]!.n));
    if (recent >= this.cfg.maxExecutionsPerMinutePerOrg) throw new ProblemException('rate_limited', 'too many executions were started in the last minute');
    const e = await this.enqueue(orgId, { workflowId, trigger: 'manual', triggerRef: actor, dedupeKey: body.dedupeKey, input, versionId: body.versionId as string | undefined });
    if (e.created) await this.ensureOperation(orgId, e.id, actor);
    const dto = await this.get(orgId, e.id, { steps: false });
    return { ...dto, duplicate: !e.created };
  }

  async list(orgId: string, workflowId: string, q: { limit: number; cursor?: string; status?: string }): Promise<Page<ExecutionDto>> {
    if (!isUuid(workflowId)) throw new ProblemException('not_found');
    const wf = await this.db.withOrg(orgId, async (c) => (await c.query(`SELECT 1 FROM automation.workflows WHERE id = $1 AND org_id = $2`, [workflowId, orgId])).rowCount);
    if (!wf) throw new ProblemException('not_found');
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(orgId, async (c) =>
      (await c.query(`SELECT * FROM automation.executions WHERE org_id = $1 AND workflow_id = $2 AND ($3::uuid IS NULL OR id < $3) AND ($4::text IS NULL OR status = $4) ORDER BY id DESC LIMIT $5`, [orgId, workflowId, before, q.status ?? null, q.limit + 1])).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    return { items: p.items.map((r) => this.dto(r)), nextCursor: p.nextCursor };
  }

  /** GET /v1/workflow-executions/{id}: steps, attempts, redacted logs, DLQ state. Another organization's id answers 404. */
  async get(orgId: string, id: string, opts: { steps?: boolean } = {}): Promise<ExecutionDto> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const x = await this.db.withOrg(orgId, async (c) => {
      const r = (await c.query(`SELECT * FROM automation.executions WHERE id = $1 AND org_id = $2`, [id, orgId])).rows[0] as Row | undefined;
      if (!r) return null;
      if (opts.steps === false) return { r, steps: [] as Row[], dl: [] as Row[] };
      return {
        r,
        steps: (await c.query(`SELECT * FROM automation.execution_steps WHERE execution_id = $1 ORDER BY started_at, attempt LIMIT 1000`, [id])).rows as Row[],
        dl: (await c.query(`SELECT * FROM automation.dead_letters WHERE execution_id = $1 ORDER BY created_at`, [id])).rows as Row[],
      };
    });
    if (!x) throw new ProblemException('not_found');
    return this.dto(x.r, opts.steps === false ? {} : {
      steps: x.steps.map((s) => ({ stepKey: s.step_key, attempt: s.attempt, status: s.status, idempotent: s.idempotent, input: s.input ?? null, output: unwrap(s.output) ?? null, error: s.error ?? null, startedAt: iso(s.started_at), finishedAt: iso(s.finished_at) })),
      deadLetters: x.dl.map((d) => ({ id: d.id, stepKey: d.step_key, reason: d.reason, replayedAt: iso(d.replayed_at) })),
    });
  }

  /** Cancel (service-level: the public route is `POST /v1/operations/{id}/cancellation`). A queued execution becomes cancelled at once; a running one at its next step. */
  async cancel(orgId: string, actor: string, id: string): Promise<ExecutionDto> {
    const ex = await this.get(orgId, id, { steps: false });
    if (['succeeded', 'failed', 'cancelled'].includes(ex.status)) throw new ProblemException('operation_not_cancellable', `the execution is ${ex.status}`);
    const opId = await this.ensureOperation(orgId, id, actor);
    const r = await this.ops.requestCancel(orgId, opId);
    if (r.accepted === 'cancelled')
      await this.db.withOrg(orgId, (c) => c.query(`UPDATE automation.executions SET status = 'cancelled', finished_at = now(), error = '{"code":"cancelled"}' WHERE id = $1 AND status NOT IN ('succeeded','failed','cancelled')`, [id]));
    await this.audit.record({ action: 'workflow.execution.cancelled', actorUserId: actor, orgId, resource: { type: 'workflow_execution', id }, outcome: 'success' });
    return this.get(orgId, id, { steps: false });
  }

  /**
   * Replay a dead letter (service-level; the HTTP route needs an approved SCR). Idempotent: ONE new execution per dead letter (`replay:<id>` is its dedupe key), which resumes
   * at the failed step with the outputs so far and the ORIGINAL execution as the idempotency-key root, so a step that actually succeeded at the target before it failed here is not
   * performed twice.
   */
  async replay(orgId: string, actor: string, deadLetterId: string): Promise<ExecutionDto> {
    if (!isUuid(deadLetterId)) throw new ProblemException('not_found');
    const x = await this.db.withOrg(orgId, async (c) => {
      const d = (await c.query(`SELECT * FROM automation.dead_letters WHERE id = $1 AND org_id = $2`, [deadLetterId, orgId])).rows[0] as Row | undefined;
      if (!d) return null;
      const ex = (await c.query(`SELECT * FROM automation.executions WHERE id = $1`, [d.execution_id])).rows[0] as Row;
      return { d, ex };
    });
    if (!x) throw new ProblemException('not_found');
    // the cursor of the failed execution already points at the failing step (and, inside a loop, at its iteration and body index): resume exactly there
    const cursor = x.ex.cursor ?? {};
    const e = await this.enqueue(orgId, {
      workflowId: x.ex.workflow_id, trigger: 'replay', triggerRef: deadLetterId, dedupeKey: `replay:${deadLetterId}`, input: x.ex.input, versionId: x.ex.version_id,
      origin: x.ex.id, depth: x.ex.chain_depth, keyRoot: (x.ex.key_root_id as string | null) ?? x.ex.id, cursor,
    });
    await this.db.withOrg(orgId, (c) => c.query(`UPDATE automation.dead_letters SET replayed_at = coalesce(replayed_at, now()), replayed_by = coalesce(replayed_by, $2) WHERE id = $1`, [deadLetterId, actor]));
    if (e.created) await this.ensureOperation(orgId, e.id, actor);
    await this.audit.record({ action: 'workflow.execution.replayed', actorUserId: actor, orgId, resource: { type: 'workflow_execution', id: e.id }, outcome: 'success', detail: { deadLetterId, original: x.ex.id } });
    return { ...(await this.get(orgId, e.id, { steps: false })), duplicate: !e.created };
  }
}
