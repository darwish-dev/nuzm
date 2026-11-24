import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import type { RunContext } from '../../../ai';
import type { PgRunStore } from '../ports/m09-real';
import type {
  LifecycleArtifacts,
  LifecycleHost,
  LifecycleState,
  StepId,
  Usage,
} from './lifecycle.types';

/** step names are the unique `node` of `ai.run_steps` (`^[a-z][a-z0-9_-]{0,40}$`): one row per step and repair round */
const node = (step: StepId, round: number) => `lc-${step.replace(/_/g, '-')}-r${round}`;

/**
 * The run engine's side of the lifecycle, over a `RunContext` of the M09 segment engine: the checkpoint (`ctx.save`, after every step), run events, audit, cancellation,
 * artifacts (`ai.artifacts`) and one `ai.run_steps` row per step (a repair round is a new row; a retried step revives its own row with a higher attempt).
 */
export class RunContextHost implements LifecycleHost {
  readonly orgId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly userId: string | null;
  readonly budget: { maxTokens?: number; maxCredits?: number };
  readonly input: LifecycleHost['input'];
  constructor(
    private readonly ctx: RunContext,
    private readonly deps: { db: Db; audit: AuditSink; store: PgRunStore },
    readonly permissions: ReadonlySet<string>,
  ) {
    this.orgId = ctx.orgId;
    this.runId = ctx.run.id;
    this.projectId = ctx.run.projectId!;
    this.userId = ctx.userId;
    this.budget = ctx.run.budget;
    const b = (ctx.run.input.brief ?? {}) as { prompt?: unknown };
    this.input = {
      prompt: typeof b.prompt === 'string' ? b.prompt : '',
      ...(Number.isInteger(ctx.run.input.maxRepairRounds)
        ? { maxRepairRounds: ctx.run.input.maxRepairRounds as number }
        : {}),
      ...(Number.isInteger(ctx.run.input.maxMinutes)
        ? { maxMinutes: ctx.run.input.maxMinutes as number }
        : {}),
    };
  }
  now() {
    return new Date().toISOString();
  }
  async load() {
    const saved = this.ctx.checkpoint.lifecycle as
      { state: LifecycleState; artifacts: LifecycleArtifacts } | undefined;
    return saved ?? null;
  }
  async save(state: LifecycleState, artifacts: LifecycleArtifacts, step: string) {
    await this.ctx.save({ lifecycle: { state, artifacts } }, step.slice(0, 60));
  }
  async emit(type: string, data?: Record<string, unknown>) {
    await this.ctx.emit(type, data);
  }
  async audit(action: string, outcome: 'success' | 'failure', detail: Record<string, unknown>) {
    await this.deps.audit.record({
      action: action as `${string}.${string}.${string}`,
      orgId: this.orgId,
      ...(this.userId ? { actorUserId: this.userId } : {}),
      actorType: this.userId ? 'user' : 'system',
      resource: { type: 'ai_run', id: this.runId },
      outcome,
      detail,
    });
  }
  cancelled() {
    return this.ctx.cancelled();
  }
  async setRunState(state: 'running' | 'waiting_approval') {
    await this.deps.store.transition(this.orgId, this.runId, state).catch(() => undefined);
  }
  async storeArtifact(type: 'change_set' | 'evaluation_report', payload: unknown) {
    return this.ctx.artifact(type, payload);
  }
  async loadArtifact(id: string) {
    return (await this.ctx.loadArtifact(id))?.payload ?? null;
  }

  // ---- persistent step records ---------------------------------------------------------------------------------------------------------------------------------------------
  async stepBegin(step: StepId, round: number, attempt: number): Promise<string> {
    const n = node(step, round);
    return this.deps.db.withOrg(this.orgId, async (c) => {
      const existing = (
        await c.query(`SELECT id, status FROM ai.run_steps WHERE run_id = $1 AND node = $2`, [
          this.runId,
          n,
        ])
      ).rows[0] as { id: string; status: string } | undefined;
      if (existing) {
        // a step tried again (a retry, a resumed run) revives its own row with a higher attempt; a succeeded one is left alone
        if (existing.status === 'failed' || existing.status === 'running')
          await c.query(
            `UPDATE ai.run_steps SET status = 'running', attempt = $2, error_code = NULL, finished_at = NULL WHERE id = $1`,
            [existing.id, attempt],
          );
        return existing.id;
      }
      const id = uuidv7();
      const seq = Number(
        (await c.query(`SELECT count(*)::int n FROM ai.run_steps WHERE run_id = $1`, [this.runId]))
          .rows[0]!.n,
      );
      await c.query(
        `INSERT INTO ai.run_steps (id, org_id, run_id, seq, node, agent, status, attempt, input_ref, data_region, started_at)
         VALUES ($1, $2, $3, $4, $5, 'agent', 'running', $6, $7, $8, now())`,
        [id, this.orgId, this.runId, seq, n, attempt, `lifecycle:${step}`, this.ctx.run.dataRegion],
      );
      return id;
    });
  }
  async stepEnd(
    id: string,
    status: 'succeeded' | 'failed',
    o: { usage?: Usage; code?: string },
  ): Promise<void> {
    await this.deps.db.withOrg(this.orgId, async (c) => {
      await c.query(
        `UPDATE ai.run_steps SET status = $2, tokens_in = tokens_in + $3, tokens_out = tokens_out + $4, error_code = $5, finished_at = now(),
                checkpoint_ref = CASE WHEN $2 = 'succeeded' THEN 'lifecycle:' || node ELSE checkpoint_ref END
          WHERE id = $1 AND status IN ('pending', 'running')`,
        [
          id,
          status,
          Math.max(0, Math.trunc(o.usage?.tokensIn ?? 0)),
          Math.max(0, Math.trunc(o.usage?.tokensOut ?? 0)),
          o.code ? o.code.slice(0, 60) : null,
        ],
      );
    });
  }
}
