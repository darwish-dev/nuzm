import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import { OperationsService, type Db } from '@nuzm/platform';
import type { RunKind } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf } from '../../../common/pagination';
import { BudgetDenied } from './budget.service';
import { runAgent } from './agent-call';
import type { GatewayService } from './gateway.service';
import { AI_OP_KIND, isUuid, type AiConfig, type Row } from './model';
import {
  AgentOutputInvalid,
  RunKindRegistry,
  SegmentDone,
  SegmentSuspend,
  WorkerCrash,
  type AgentCall,
  type ApprovalKind,
  type ResumedWith,
  type RunContext,
  type RunRow,
} from './run-kinds';
import type { SessionService } from './session.service';
import { htmlToText, type UrlFetchPort } from './url-fetcher';

const ACTIVE = ['queued', 'running', 'waiting_approval'];
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'budget_exceeded'];
const ALL_KINDS = ['website', 'edit', 'chat', 'webapp', 'mobile', 'test-fix'];
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
export const actionHash = (runId: string, kind: string, payload: unknown) =>
  createHash('sha256')
    .update(`${runId}|${kind}|${canonical(payload)}`)
    .digest('hex');

const toRun = (r: Row): RunRow => ({
  id: r.id as string,
  orgId: r.org_id as string,
  sessionId: r.session_id as string,
  projectId: (r.project_id as string | null) ?? null,
  kind: r.kind as string,
  state: r.state as string,
  input: (r.input as Record<string, unknown>) ?? {},
  budget: (r.budget as RunRow['budget']) ?? {},
  checkpoint: (r.checkpoint as Record<string, unknown>) ?? {},
  step: (r.step as string | null) ?? null,
  dataRegion: r.data_region as string,
  createdBy: (r.created_by as string | null) ?? null,
  cancelRequested: r.cancel_requested as boolean,
  version: r.version as number,
});
export interface RunDto {
  id: string;
  sessionId: string;
  projectId: string | null;
  kind: string;
  state: string;
  operationId: string | null;
  step: string | null;
  budget: unknown;
  usage: {
    tokensIn: number;
    tokensOut: number;
    spentCredits: string;
    reservedCredits: string;
    modelRef: string | null;
  };
  dataRegion: string;
  result: unknown;
  error: unknown;
  pendingApproval: {
    id: string;
    kind: string;
    summary: unknown;
    expiresAt: string;
    /** present for approvals of the app builder (M10A): decided in the approvals inbox with this hash, not through `POST /v1/ai/runs/{id}/approvals` */
    scopeHash?: string;
  } | null;
  artifacts: { id: string; type: string; createdAt: string }[];
  createdAt: string;
  finishedAt: string | null;
}

/**
 * Runs (M09 S38): API side (create, read, events, cancel, approve) and the SEGMENT ENGINE. A run is executed in segments, each a `platform.operations` row of kind
 * `ai.run`; a segment ends when the run finishes, fails, is cancelled or waits for a human approval, and an approval decision starts the next segment from the
 * saved checkpoint. A worker that dies mid-segment leaves a running operation with an expired lease; the next claim resumes from the checkpoint.
 */
export class RunService {
  /** test hook: when set, called after each saved step with the step name (used to simulate a worker crash) */
  afterStep?: (step: string) => void;
  private kicker: (orgId: string, operationId: string) => void = () => undefined;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly registry: RunKindRegistry,
    private readonly gateway: GatewayService,
    private readonly sessions: SessionService,
    private readonly fetcher: UrlFetchPort,
    private readonly cfg: AiConfig,
  ) {}
  setKicker(k: (orgId: string, operationId: string) => void) {
    this.kicker = k;
  }

  // ---- API side ---------------------------------------------------------------------------------------------------------------

  async create(
    orgId: string,
    userId: string,
    idempotencyKey: string | undefined,
    b: Record<string, unknown>,
  ): Promise<RunDto> {
    const kind = b.kind;
    if (typeof kind !== 'string' || !ALL_KINDS.includes(kind))
      throw new ProblemException(
        'validation_failed',
        `kind must be one of ${ALL_KINDS.join(', ')}`,
      );
    const handler = this.registry.get(kind);
    // a kind is available exactly when a handler is registered for it (website/edit/chat by M09; webapp/test-fix by M10A's AppBuilderModule; mobile: M10B)
    if (!handler)
      throw new ProblemException('unsupported_kind', `run kind ${kind} is not available yet`);
    if (!isUuid(b.sessionId))
      throw new ProblemException('validation_failed', 'sessionId must be a uuid');
    if (b.projectId !== undefined && b.projectId !== null && !isUuid(b.projectId))
      throw new ProblemException('validation_failed', 'projectId must be a uuid');
    const input = b.input === undefined ? {} : b.input;
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input) ||
      JSON.stringify(input).length > 100_000
    )
      throw new ProblemException(
        'validation_failed',
        'input must be an object of at most 100000 characters',
      );
    handler.validateInput(input as Record<string, unknown>);
    const bud = (b.budget ?? {}) as { maxTokens?: unknown; maxCredits?: unknown };
    for (const [k, v] of Object.entries(bud))
      if (
        !['maxTokens', 'maxCredits'].includes(k) ||
        typeof v !== 'number' ||
        !Number.isInteger(v) ||
        v < 1 ||
        v > 1e12
      )
        throw new ProblemException(
          'validation_failed',
          'budget is {maxTokens?, maxCredits?} with positive integers',
        );
    await this.gateway.assertAvailable(orgId); // 503 kill switch, 422 unsupported_capability, 403 residency_denied, 402 insufficient_credits
    const sess = await this.sessions.get(orgId, b.sessionId as string);
    const projectId = (b.projectId as string | undefined) ?? sess.projectId ?? null;
    if (handler.requiresProject && !projectId)
      throw new ProblemException('validation_failed', `a ${kind} run needs a projectId`);
    const id = uuidv7();
    try {
      await this.db.withOrg(orgId, async (c) => {
        const active = Number(
          (await c.query(`SELECT count(*) n FROM ai.runs WHERE state = ANY($1)`, [ACTIVE])).rows[0]!
            .n,
        );
        if (active >= this.cfg.maxConcurrentRuns)
          throw new ProblemException('rate_limited', 'too many active runs for this organization');
        if (projectId) {
          const p = (
            await c.query(`SELECT 1 FROM builder.projects WHERE id=$1 AND deleted_at IS NULL`, [
              projectId,
            ])
          ).rows[0];
          if (!p) throw new ProblemException('not_found', 'project not found');
        }
        await c.query(
          `INSERT INTO ai.runs (id, org_id, session_id, project_id, kind, input, budget, data_region, idempotency_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            orgId,
            b.sessionId,
            projectId,
            kind,
            JSON.stringify(input),
            JSON.stringify(bud),
            this.cfg.dataRegion,
            idempotencyKey ?? null,
            userId,
          ],
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException(
          'run_active',
          'a run is already active for this session or project',
        );
      throw e;
    }
    const op = await this.ops.create(orgId, {
      kind: AI_OP_KIND,
      input: { runId: id },
      resourceKind: 'ai_run',
      resourceId: id,
      createdBy: userId,
      ...(idempotencyKey ? { idempotencyKey: `ai-run:${idempotencyKey}` } : {}),
      maxAttempts: 5,
    });
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE ai.runs SET operation_id=$2 WHERE id=$1`, [id, op.id]),
    );
    await this.event(orgId, id, 'created', { kind });
    await this.audit.record({
      action: 'ai.run.created',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'ai_run', id },
      outcome: 'success',
      detail: { kind, projectId },
    });
    this.kicker(orgId, op.id);
    return this.get(orgId, id);
  }

  async get(orgId: string, id: string): Promise<RunDto> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const r = await this.db.withOrg(orgId, async (c) => {
      const run = (await c.query(`SELECT * FROM ai.runs WHERE id=$1`, [id])).rows[0] as
        Row | undefined;
      if (!run) return null;
      const ap = (
        await c.query(
          `SELECT * FROM ai.approvals WHERE run_id=$1 AND state='pending' ORDER BY requested_at DESC LIMIT 1`,
          [id],
        )
      ).rows[0] as Row | undefined;
      const arts = (
        await c.query(
          `SELECT id, type, created_at FROM ai.artifacts WHERE run_id=$1 ORDER BY created_at`,
          [id],
        )
      ).rows as Row[];
      // run kinds of the app builder (M10A) wait on `ai.approval_requests` (the approvals inbox): surfaced here so one read of the run shows what it waits for
      const ap10 = ap
        ? undefined
        : ((
            await c.query(
              `SELECT id, approval_type, action, action_hash, expires_at FROM ai.approval_requests WHERE run_id=$1 AND status='pending' AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
              [id],
            )
          ).rows[0] as Row | undefined);
      return { run, ap, ap10, arts };
    });
    if (!r) throw new ProblemException('not_found');
    const x = r.run;
    return {
      id: x.id as string,
      sessionId: x.session_id as string,
      projectId: (x.project_id as string | null) ?? null,
      kind: x.kind as string,
      state: x.state as string,
      operationId: (x.operation_id as string | null) ?? null,
      step: (x.step as string | null) ?? null,
      budget: x.budget,
      usage: {
        tokensIn: Number(x.tokens_in),
        tokensOut: Number(x.tokens_out),
        spentCredits: String(x.spent_credits),
        reservedCredits: String(x.reserved_credits),
        modelRef: (x.model_ref as string | null) ?? null,
      },
      dataRegion: x.data_region as string,
      result: x.result ?? null,
      error: x.error ?? null,
      pendingApproval: r.ap
        ? {
            id: r.ap.id as string,
            kind: r.ap.kind as string,
            summary: r.ap.summary,
            expiresAt: new Date(r.ap.expires_at as string).toISOString(),
          }
        : r.ap10
          ? {
              id: r.ap10.id as string,
              kind: r.ap10.approval_type as string,
              summary: r.ap10.action,
              expiresAt: new Date(r.ap10.expires_at as string).toISOString(),
              scopeHash: r.ap10.action_hash as string,
            }
          : null,
      artifacts: r.arts.map((a) => ({
        id: a.id as string,
        type: a.type as string,
        createdAt: new Date(a.created_at as string).toISOString(),
      })),
      createdAt: new Date(x.created_at as string).toISOString(),
      finishedAt: x.finished_at ? new Date(x.finished_at as string).toISOString() : null,
    };
  }
  async artifact(
    orgId: string,
    runId: string,
    artifactId: string,
  ): Promise<{ id: string; type: string; payload: unknown; approved: boolean }> {
    if (!isUuid(runId) || !isUuid(artifactId)) throw new ProblemException('not_found');
    const a = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM ai.artifacts WHERE id=$1 AND run_id=$2`, [artifactId, runId]))
          .rows[0],
    )) as Row | undefined;
    if (!a) throw new ProblemException('not_found');
    return {
      id: a.id as string,
      type: a.type as string,
      payload: a.payload,
      approved: a.approved_by !== null,
    };
  }
  async list(
    orgId: string,
    o: { limit: number; cursor?: string; sessionId?: string; projectId?: string },
  ) {
    const cur = decodeCursor(o.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id FROM ai.runs WHERE ($1::uuid IS NULL OR id < $1) AND ($3::uuid IS NULL OR session_id=$3) AND ($4::uuid IS NULL OR project_id=$4) ORDER BY id DESC LIMIT $2`,
            [cur, o.limit + 1, o.sessionId ?? null, o.projectId ?? null],
          )
        ).rows as Row[],
    );
    const page = pageOf(
      rows.map((r) => ({ id: r.id as string })),
      o.limit,
    );
    return {
      items: await Promise.all(page.items.map((x) => this.get(orgId, x.id))),
      nextCursor: page.nextCursor,
    };
  }

  /** Events after `afterSeq` (SSE resume). */
  async eventsAfter(
    orgId: string,
    runId: string,
    afterSeq: number,
    limit = 200,
  ): Promise<{ seq: number; type: string; data: unknown; at: string }[]> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT seq, type, data, created_at FROM ai.run_events WHERE run_id=$1 AND seq > $2 ORDER BY seq LIMIT $3`,
            [runId, afterSeq, limit],
          )
        ).rows as Row[],
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      type: r.type as string,
      data: r.data,
      at: new Date(r.created_at as string).toISOString(),
    }));
  }
  async state(orgId: string, runId: string): Promise<string> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) => (await c.query(`SELECT state FROM ai.runs WHERE id=$1`, [runId])).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return r.state as string;
  }
  async event(
    orgId: string,
    runId: string,
    type: string,
    data: Record<string, unknown> = {},
  ): Promise<number> {
    for (let i = 0; i < 6; i++) {
      try {
        return await this.db.withOrg(orgId, async (c) =>
          Number(
            (
              await c.query(
                `INSERT INTO ai.run_events (run_id, seq, org_id, type, data) SELECT $1, coalesce(max(seq),0)+1, $2, $3, $4 FROM ai.run_events WHERE run_id=$1 RETURNING seq`,
                [runId, orgId, type, JSON.stringify(data)],
              )
            ).rows[0]!.seq,
          ),
        );
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e; // a concurrent writer took the seq: retry
      }
    }
    throw new Error('could not allocate an event sequence');
  }

  async cancel(orgId: string, userId: string, runId: string): Promise<{ state: string }> {
    const run = await this.load(orgId, runId);
    if (TERMINAL.includes(run.state))
      throw new ProblemException('invalid_state', `the run is already ${run.state}`);
    if (run.state === 'running') {
      await this.db.withOrg(orgId, (c) =>
        c.query(`UPDATE ai.runs SET cancel_requested=true WHERE id=$1 AND state='running'`, [
          runId,
        ]),
      );
      await this.event(orgId, runId, 'cancel_requested', {});
      return { state: 'cancelling' };
    }
    await this.finish(orgId, runId, 'cancelled', { error: { code: 'cancelled_by_user' } });
    await this.cancelOperation(orgId, runId);
    await this.audit.record({
      action: 'ai.run.cancelled',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'ai_run', id: runId },
      outcome: 'success',
    });
    return { state: 'cancelled' };
  }
  private async cancelOperation(orgId: string, runId: string) {
    const r = (await this.db.withOrg(
      orgId,
      async (c) => (await c.query(`SELECT operation_id FROM ai.runs WHERE id=$1`, [runId])).rows[0],
    )) as Row | undefined;
    if (r?.operation_id)
      await this.ops.requestCancel(orgId, r.operation_id as string).catch(() => undefined);
  }

  /** Decide an approval. The decision is bound to the run and to the hash of the exact action; an expired approval is 409 `approval_expired`. */
  async decide(
    orgId: string,
    userId: string,
    runId: string,
    b: Record<string, unknown>,
  ): Promise<RunDto> {
    const run = await this.load(orgId, runId); // 404 for another organization BEFORE any body validation
    if (!isUuid(b.approvalId))
      throw new ProblemException('validation_failed', 'approvalId must be a uuid');
    if (b.decision !== 'approve' && b.decision !== 'deny')
      throw new ProblemException('validation_failed', 'decision must be approve or deny');
    const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;
    const ap = await this.db.withOrg(orgId, async (c) => {
      const a = (
        await c.query(`SELECT * FROM ai.approvals WHERE id=$1 AND run_id=$2 FOR UPDATE`, [
          b.approvalId,
          runId,
        ])
      ).rows[0] as Row | undefined;
      if (!a) throw new ProblemException('not_found', 'approval not found');
      if (a.state !== 'pending')
        throw new ProblemException('invalid_state', `the approval is already ${a.state}`);
      if (new Date(a.expires_at as string).getTime() < Date.now()) {
        await c.query(`UPDATE ai.approvals SET state='expired' WHERE id=$1`, [a.id]);
        return { expired: true as const, a };
      }
      // the stored action hash must still match the stored summary payload (defence against a tampered row)
      const state = (await c.query(`SELECT state FROM ai.runs WHERE id=$1`, [runId])).rows[0]!
        .state as string;
      if (state !== 'waiting_approval')
        throw new ProblemException('invalid_state', `the run is ${state}`);
      await c.query(
        `UPDATE ai.approvals SET state=$2, decided_by=$3, decided_at=now(), note=$4 WHERE id=$1`,
        [a.id, b.decision === 'approve' ? 'approved' : 'denied', userId, note],
      );
      return { expired: false as const, a };
    });
    if (ap.expired) {
      await this.audit.record({
        action: 'ai.approval.denied',
        actorUserId: userId,
        actorType: 'user',
        orgId,
        resource: { type: 'ai_approval', id: b.approvalId as string },
        outcome: 'failure',
        detail: { reason: 'expired', runId },
      });
      throw new ProblemException('approval_expired', 'the approval has expired: ask for a new one');
    }
    const decision = b.decision === 'approve' ? 'approved' : 'denied';
    await this.audit.record({
      action: decision === 'approved' ? 'ai.approval.granted' : 'ai.approval.denied',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'ai_approval', id: b.approvalId as string },
      outcome: 'success',
      detail: { runId, kind: ap.a.kind, actionHash: ap.a.action_hash },
    });
    await this.event(orgId, runId, `approval_${decision}`, {
      approvalId: b.approvalId,
      kind: ap.a.kind,
    });
    const resumed: ResumedWith = {
      approvalId: b.approvalId as string,
      kind: ap.a.kind as ApprovalKind,
      decision,
      note,
      payload: (ap.a.summary as { payload?: unknown })?.payload ?? null,
    };
    const handler = this.registry.get(run.kind);
    if (decision === 'denied' && !handler?.onDenied) {
      await this.finish(orgId, runId, 'cancelled', {
        error: { code: 'approval_denied', kind: ap.a.kind },
      });
      return this.get(orgId, runId);
    }
    // next segment: back to `queued` with a fresh operation; the decision travels in the checkpoint
    const op = await this.ops.create(orgId, {
      kind: AI_OP_KIND,
      input: { runId },
      resourceKind: 'ai_run',
      resourceId: runId,
      createdBy: userId,
      maxAttempts: 5,
    });
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE ai.runs SET state='queued', operation_id=$2, checkpoint = checkpoint || $3::jsonb WHERE id=$1 AND state='waiting_approval'`,
        [runId, op.id, JSON.stringify({ resumedWith: resumed })],
      ),
    );
    this.kicker(orgId, op.id);
    return this.get(orgId, runId);
  }

  /**
   * Extension point for run kinds that keep their OWN approvals (M10A: `ai.approval_requests`, decided through `POST /v1/ai/approvals/{id}/decisions`): after such a
   * decision the parked run continues with the next segment from its checkpoint, exactly as after a decision on `ai.approvals`. No-op unless the run is waiting.
   */
  async resumeParked(orgId: string, userId: string | null, runId: string): Promise<boolean> {
    const run = await this.load(orgId, runId);
    if (run.state !== 'waiting_approval') return false;
    const op = await this.ops.create(orgId, {
      kind: AI_OP_KIND,
      input: { runId },
      resourceKind: 'ai_run',
      resourceId: runId,
      ...(userId ? { createdBy: userId } : {}),
      maxAttempts: 5,
    });
    const moved = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE ai.runs SET state='queued', operation_id=$2 WHERE id=$1 AND state='waiting_approval'`,
            [runId, op.id],
          )
        ).rowCount,
    );
    if (!moved) return false; // another resume won the race
    await this.event(orgId, runId, 'approval_decided', {});
    this.kicker(orgId, op.id);
    return true;
  }

  private async load(orgId: string, runId: string): Promise<RunRow> {
    if (!isUuid(runId)) throw new ProblemException('not_found');
    const r = (await this.db.withOrg(
      orgId,
      async (c) => (await c.query(`SELECT * FROM ai.runs WHERE id=$1`, [runId])).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return toRun(r);
  }
  private async finish(
    orgId: string,
    runId: string,
    to: 'succeeded' | 'failed' | 'cancelled' | 'budget_exceeded',
    o: { result?: unknown; error?: unknown } = {},
  ) {
    await this.db.withOrg(orgId, async (c) => {
      const cur = (await c.query(`SELECT state FROM ai.runs WHERE id=$1 FOR UPDATE`, [runId]))
        .rows[0] as Row | undefined;
      if (!cur || TERMINAL.includes(cur.state as string)) return;
      await c.query(
        `UPDATE ai.runs SET state=$2, result=$3, error=$4, finished_at=now(), step=coalesce(step,'done') WHERE id=$1`,
        [
          runId,
          to,
          o.result === undefined ? null : JSON.stringify(o.result),
          o.error === undefined ? null : JSON.stringify(o.error),
        ],
      );
      // any reservation still held by this run is released: nothing is left blocking the balance
      const held = (
        await c.query(
          `UPDATE ai.reservations SET state='released', closed_at=now() WHERE run_id=$1 AND state='held' RETURNING credits`,
          [runId],
        )
      ).rows as Row[];
      const sum = held.reduce((a, r) => a + BigInt(String(r.credits)), 0n);
      if (sum > 0n) {
        await c.query(
          `UPDATE ai.credit_balances SET reserved_credits = greatest(0, reserved_credits - $2) WHERE org_id=$1 AND currency=$3`,
          [orgId, sum.toString(), this.cfg.currency],
        );
        await c.query(`UPDATE ai.runs SET reserved_credits = 0 WHERE id=$1`, [runId]);
      }
    });
    await this.event(orgId, runId, to, to === 'succeeded' ? {} : { error: o.error ?? null });
    const action =
      to === 'succeeded'
        ? 'ai.run.completed'
        : to === 'cancelled'
          ? 'ai.run.cancelled'
          : to === 'budget_exceeded'
            ? 'ai.run.budget_exceeded'
            : 'ai.run.completed';
    await this.audit.record({
      action,
      actorType: 'system',
      orgId,
      resource: { type: 'ai_run', id: runId },
      outcome: to === 'succeeded' ? 'success' : 'failure',
      detail: { state: to },
    });
  }

  // ---- engine -----------------------------------------------------------------------------------------------------------------

  /** Claim and run ONE segment of the run behind an operation (what the API does right after answering 202). Returns false when nothing was claimable. */
  async runOne(orgId: string, operationId: string, worker = `ai-${process.pid}`): Promise<boolean> {
    const claimed = await this.ops.claimById(orgId, operationId, worker);
    if (!claimed) return false;
    const op = await this.ops.get(orgId, operationId);
    const runId = (op?.input as { runId?: string } | undefined)?.runId;
    if (!runId) {
      await this.ops
        .failPermanently(orgId, operationId, worker, { code: 'no_run' })
        .catch(() => undefined);
      return true;
    }
    let run = await this.load(orgId, runId);
    if (TERMINAL.includes(run.state)) {
      await this.ops.succeed(orgId, operationId, worker, { skipped: run.state });
      return true;
    }
    if (run.state === 'waiting_approval') {
      await this.ops.succeed(orgId, operationId, worker, { skipped: 'waiting_approval' });
      return true;
    }
    const handler = this.registry.get(run.kind);
    if (!handler) {
      await this.finish(orgId, runId, 'failed', { error: { code: 'unsupported_kind' } });
      await this.ops
        .failPermanently(orgId, operationId, worker, { code: 'unsupported_kind' })
        .catch(() => undefined);
      return true;
    }
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE ai.runs SET state='running', operation_id=$2, started_at=coalesce(started_at, now()) WHERE id=$1 AND state IN ('queued','running')`,
        [runId, operationId],
      ),
    );
    await this.event(orgId, runId, 'segment_started', { attempt: claimed.attempts });
    run = await this.load(orgId, runId);
    const resumed = (run.checkpoint.resumedWith as ResumedWith | undefined) ?? null;
    if (resumed)
      await this.db.withOrg(orgId, (c) =>
        c.query(`UPDATE ai.runs SET checkpoint = checkpoint - 'resumedWith' WHERE id=$1`, [runId]),
      );
    const ac = new AbortController();
    const poll = setInterval(() => {
      void this.db
        .withOrg(
          orgId,
          async (c) =>
            (await c.query(`SELECT cancel_requested FROM ai.runs WHERE id=$1`, [runId])).rows[0],
        )
        .then(
          (r) => {
            if ((r as Row | undefined)?.cancel_requested) ac.abort();
          },
          () => undefined,
        );
    }, 100);
    poll.unref();
    const hb = setInterval(
      () => void this.ops.heartbeat(orgId, operationId, worker).catch(() => undefined),
      20_000,
    );
    hb.unref();
    const ctx = this.context(run, resumed, claimed.attempts, operationId, ac.signal);
    try {
      if (resumed?.decision === 'denied' && handler.onDenied) await handler.onDenied(ctx);
      else await handler.execute(ctx);
      await this.finish(orgId, runId, 'failed', {
        error: { code: 'handler_returned_without_result' },
      });
      await this.ops
        .succeed(orgId, operationId, worker, { state: 'failed' })
        .catch(() => undefined);
    } catch (e) {
      if (e instanceof WorkerCrash) throw e; // leave everything as is: the lease expires and the next claim resumes
      if (e instanceof SegmentSuspend) {
        await this.ops
          .succeed(orgId, operationId, worker, { state: 'waiting_approval' })
          .catch(() => undefined);
      } else if (e instanceof SegmentDone) {
        await this.finish(orgId, runId, 'succeeded', { result: e.result });
        await this.ops
          .succeed(orgId, operationId, worker, { state: 'succeeded' })
          .catch(() => undefined);
      } else if (
        ac.signal.aborted ||
        (e instanceof ProblemException && e.code === 'conflict' && ac.signal.aborted)
      ) {
        await this.finish(orgId, runId, 'cancelled', { error: { code: 'cancelled_by_user' } });
        await this.ops
          .succeed(orgId, operationId, worker, { state: 'cancelled' })
          .catch(() => undefined);
      } else if (
        e instanceof BudgetDenied ||
        (e instanceof ProblemException &&
          (e.code === 'budget_exceeded' || e.code === 'insufficient_credits'))
      ) {
        await this.finish(orgId, runId, 'budget_exceeded', {
          error: {
            code: (e as ProblemException).code ?? 'budget_exceeded',
            ...(e instanceof ProblemException && e.extra ? e.extra : {}),
          },
        });
        await this.ops
          .succeed(orgId, operationId, worker, { state: 'budget_exceeded' })
          .catch(() => undefined);
      } else {
        const code =
          e instanceof ProblemException
            ? e.code
            : e instanceof AgentOutputInvalid
              ? 'agent_output_invalid'
              : 'internal_error';
        await this.finish(orgId, runId, 'failed', {
          error: {
            code,
            message:
              e instanceof AgentOutputInvalid
                ? e.errors.join('; ').slice(0, 300)
                : e instanceof ProblemException
                  ? (e.detail ?? e.message).slice(0, 240)
                  : (e as Error).message.slice(0, 200),
          },
        });
        await this.ops
          .succeed(orgId, operationId, worker, { state: 'failed', code })
          .catch(() => undefined);
      }
    } finally {
      clearInterval(poll);
      clearInterval(hb);
    }
    return true;
  }

  private context(
    run: RunRow,
    resumedWith: ResumedWith | null,
    attempt: number,
    operationId: string,
    signal: AbortSignal,
  ): RunContext {
    const orgId = run.orgId;
    const toolKind = (this.registry.get(run.kind)?.toolKind ?? 'chat') as RunKind;
    let seq = 0;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the context object literal below needs the service
    const self = this;
    const emit = (type: string, data?: Record<string, unknown>) =>
      this.event(orgId, run.id, type, data ?? {});
    const ctx: RunContext = {
      run,
      orgId,
      userId: run.createdBy,
      checkpoint: { ...run.checkpoint },
      resumedWith,
      emit,
      async call<T>(a: AgentCall) {
        if (signal.aborted) throw new ProblemException('conflict', 'cancelled');
        await emit('step_started', { task: a.task });
        const out = await runAgent<T>(
          { gateway: self.gateway, audit: self.audit, cfg: self.cfg, emit },
          run,
          toolKind,
          a,
          () => `${operationId}:${attempt}:${++seq}`,
          signal,
        );
        await emit('step_completed', { task: a.task });
        return out;
      },
      async save(patch, step) {
        Object.assign(ctx.checkpoint, patch);
        await self.db.withOrg(orgId, (c) =>
          c.query(
            `UPDATE ai.runs SET checkpoint = checkpoint || $2::jsonb, step = coalesce($3, step) WHERE id=$1`,
            [run.id, JSON.stringify(patch), step ?? null],
          ),
        );
        if (step) {
          await emit('checkpoint', { step });
          self.afterStep?.(step);
        }
      },
      async artifact(type, payload) {
        const id = uuidv7();
        await self.db.withOrg(orgId, (c) =>
          c.query(
            `INSERT INTO ai.artifacts (id, org_id, run_id, project_id, type, payload, data_region) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, orgId, run.id, run.projectId, type, JSON.stringify(payload), run.dataRegion],
          ),
        );
        await emit('artifact', { artifactId: id, type });
        return id;
      },
      async requestApproval(kind, summary, payload) {
        const id = uuidv7();
        const hash = actionHash(run.id, kind, payload);
        await self.db.withOrg(orgId, async (c: PoolClient) => {
          await c.query(
            `INSERT INTO ai.approvals (id, org_id, run_id, project_id, kind, action_hash, summary, requested_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(hours => $9))`,
            [
              id,
              orgId,
              run.id,
              run.projectId,
              kind,
              hash,
              JSON.stringify({ ...summary, payload }),
              run.createdBy,
              self.cfg.approvalTtlHours,
            ],
          );
          await c.query(
            `UPDATE ai.runs SET state='waiting_approval', step=$2 WHERE id=$1 AND state='running'`,
            [run.id, `approval:${kind}`],
          );
        });
        await emit('approval_requested', { approvalId: id, kind, summary });
        throw new SegmentSuspend('approval');
      },
      async succeed(result) {
        throw new SegmentDone(result);
      },
      async cancelled() {
        if (signal.aborted) return true;
        const r = (await self.db.withOrg(
          orgId,
          async (c) =>
            (await c.query(`SELECT cancel_requested FROM ai.runs WHERE id=$1`, [run.id])).rows[0],
        )) as Row | undefined;
        return Boolean(r?.cancel_requested);
      },
      async loadArtifact(id) {
        if (!isUuid(id)) return null;
        const a = (await self.db.withOrg(
          orgId,
          async (c) =>
            (await c.query(`SELECT type, payload FROM ai.artifacts WHERE id=$1`, [id])).rows[0],
        )) as Row | undefined;
        return a ? { type: a.type as string, payload: a.payload } : null;
      },
      async fetchText(url) {
        const r = await self.fetcher.fetch(url);
        return {
          url: r.url,
          text: htmlToText(new TextDecoder('utf-8', { fatal: false }).decode(r.body)),
        };
      },
      async sessionMessages() {
        const page = await self.sessions.messages(orgId, run.sessionId, { limit: 200 });
        return page.items.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          attachments: m.attachments,
        }));
      },
      async addAssistantMessage(content, attachments = []) {
        await self.sessions.store(
          orgId,
          null,
          run.sessionId,
          run.id,
          'assistant',
          content,
          attachments,
        );
      },
    };
    return ctx;
  }

  /** Re-run segments whose worker died (expired lease), and expire stale approvals. Called by the scheduler tick; also callable from tests. */
  async tick(): Promise<{ ran: number; expired: number }> {
    const open = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT org_id, operation_id FROM ai.runs WHERE state IN ('queued','running') AND operation_id IS NOT NULL LIMIT 200`,
          )
        ).rows as Row[],
    );
    let ran = 0;
    for (const o of open)
      if (await this.runOne(o.org_id as string, o.operation_id as string).catch(() => false)) ran++;
    const exp = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE ai.approvals SET state='expired' WHERE state='pending' AND expires_at < now() RETURNING org_id, run_id`,
          )
        ).rows as Row[],
    );
    for (const e of exp)
      await this.event(e.org_id as string, e.run_id as string, 'approval_expired', {}).catch(
        () => undefined,
      );
    return { ran, expired: exp.length };
  }

  // ---- admin (metadata only) --------------------------------------------------------------------------------------------------

  async adminList(o: { limit: number; cursor?: string; orgId?: string; state?: string }) {
    const cur = decodeCursor(o.cursor);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, session_id, project_id, kind, state, tokens_in, tokens_out, spent_credits, model_ref, data_region, error, created_at, finished_at FROM ai.runs WHERE ($1::uuid IS NULL OR id < $1) AND ($3::uuid IS NULL OR org_id=$3) AND ($4::text IS NULL OR state=$4) ORDER BY id DESC LIMIT $2`,
            [cur, o.limit + 1, o.orgId ?? null, o.state ?? null],
          )
        ).rows as Row[],
    );
    const page = pageOf(
      rows.map((r) => ({
        id: r.id as string,
        orgId: r.org_id as string,
        sessionId: r.session_id as string,
        projectId: (r.project_id as string | null) ?? null,
        kind: r.kind as string,
        state: r.state as string,
        tokensIn: Number(r.tokens_in),
        tokensOut: Number(r.tokens_out),
        spentCredits: String(r.spent_credits),
        modelRef: (r.model_ref as string | null) ?? null,
        dataRegion: r.data_region as string,
        errorCode: (r.error as { code?: string } | null)?.code ?? null,
        createdAt: new Date(r.created_at as string).toISOString(),
        finishedAt: r.finished_at ? new Date(r.finished_at as string).toISOString() : null,
      })),
      o.limit,
    );
    await this.audit.record({
      action: 'ai.admin.cross_org_read',
      actorType: 'user',
      resource: { type: 'ai_runs' },
      outcome: 'success',
      detail: { count: page.items.length, orgId: o.orgId ?? null },
    });
    return page;
  }
}
