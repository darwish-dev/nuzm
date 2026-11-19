import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import type { Row } from '../core';
import { iso, newId, type AgentId, type ApprovalType } from '../core';
import { validate } from '../schema';
import type { ApprovalService } from '../approvals/approval.service';
import {
  ModelNoCapacityError,
  ModelTimeoutError,
  TERMINAL_RUN_STATES,
  type ArtifactStorePort,
  type ModelGatewayPort,
  type OrgBudgetPort,
  type RunRecord,
  type RunStorePort,
} from '../ports/m09';
import { BudgetExceeded, BudgetLedger, clampBudget } from './budget';
import { validateGraph, type AgentGraph, type GraphNode } from './dag';
import { ArtifactInvalid, GuardedModel, RunCancelled } from './guarded-model';

export interface ToolCallSummary {
  tool: string;
  /** ALREADY redacted by the agent: never a prompt, a file body or a secret. */
  args: Record<string, unknown>;
  status?: 'succeeded' | 'failed' | 'denied';
  durationMs?: number;
  resultRef?: string;
}
export interface ApprovalNeed {
  type: ApprovalType;
  action: Record<string, unknown>;
}
export interface AgentResult {
  artifact: unknown;
  toolCalls?: ToolCallSummary[];
  /** Gates the node's output must pass before it counts as done. The output is parked until every approval is approved. */
  approvals?: ApprovalNeed[];
}
export interface AgentContext {
  orgId: string;
  runId: string;
  projectId: string;
  dataRegion: string;
  node: GraphNode;
  /** The artifacts of the node's `consumes` kinds (already validated). */
  inputs: Record<string, unknown>;
  model: GuardedModel;
}
export interface AgentExecutor {
  readonly agent: AgentId;
  execute(ctx: AgentContext): Promise<AgentResult>;
}

export type RunOutcome =
  | { status: 'succeeded'; artifacts: Record<string, unknown> }
  | { status: 'waiting_approval'; approvalIds: string[] }
  | { status: 'failed'; reason: string }
  /** Another worker holds a node of this run right now: back off, nothing failed (the unique step index decided the race). */
  | { status: 'busy' }
  | { status: 'cancelled' }
  | { status: 'budget_exceeded'; dimension: string };

/** A simulated worker death: thrown by tests (and by a real crash) between persisting steps. The runner never catches it, so the rows stay exactly as a dead process leaves them. */
export class WorkerCrash extends Error {
  constructor(readonly afterNode: string) {
    super(`worker crashed after node ${afterNode}`);
    this.name = 'WorkerCrash';
  }
}

/** Optional per-execution hooks. The M09 integration passes the run context's `emit` so that every node shows up in the persisted event log (`ai.run_events`, SSE). */
export interface RunHooks {
  emit?: (type: string, data?: Record<string, unknown>) => Promise<unknown>;
  /** Runs once every node has a checkpoint and BEFORE the run is marked succeeded (e.g. commit the assembled project); a throw fails the run with `finalize_failed`. Must be idempotent. */
  finalize?: (artifacts: Record<string, unknown>) => Promise<void>;
}

export interface RunnerConfig {
  modelTimeoutMs: number;
  /** In-process retries of a node after a model timeout / no capacity (the reservation of a timed-out call is already counted as spent). */
  nodeRetries: number;
  stepMaxTokens: number;
}
export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  modelTimeoutMs: 120_000,
  nodeRetries: 2,
  stepMaxTokens: 16_000,
};

/**
 * The task-graph runner (M10 §4 S42.1/2). The DAG is validated first; nodes run in topological order; after EVERY node its output is stored (artifact store) and the
 * `ai.run_steps` row is moved to `succeeded` with its checkpoint, so a worker crash resumes from the last checkpoint without repeating a node (the unique index
 * `(run_id, node)` makes a duplicate step impossible, even from two workers). A node that needs a human approval parks the run in `waiting_approval`; the approval
 * decision resumes it. Cancellation is checked at every node and before every model call; a cancelled run ends at the next checkpoint.
 */
export class GraphRunner {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Test hook: called after a step is checkpointed (throw WorkerCrash to simulate a dead worker). */
  afterCheckpoint: (node: string) => void | Promise<void> = () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly runs: RunStorePort,
    private readonly artifacts: ArtifactStorePort,
    private readonly gateway: ModelGatewayPort,
    private readonly orgBudget: OrgBudgetPort,
    private readonly approvals: ApprovalService,
    private readonly executors: ReadonlyMap<AgentId, AgentExecutor>,
    private readonly cfg: RunnerConfig = DEFAULT_RUNNER_CONFIG,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Serialises start/resume of the same run inside this process; across processes the unique step index is the guard. */
  run(
    orgId: string,
    runId: string,
    graph: AgentGraph,
    seeds: Record<string, unknown> = {},
    hooks: RunHooks = {},
  ): Promise<RunOutcome> {
    const prev = this.locks.get(runId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.execute(orgId, runId, graph, seeds, hooks));
    this.locks.set(runId, next);
    return next.finally(() => {
      if (this.locks.get(runId) === next) this.locks.delete(runId);
    }) as Promise<RunOutcome>;
  }

  private async steps(orgId: string, runId: string): Promise<Map<string, Row>> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM ai.run_steps WHERE org_id = $1 AND run_id = $2 ORDER BY seq`,
            [orgId, runId],
          )
        ).rows as Row[],
    );
    return new Map(rows.map((r) => [r.node as string, r]));
  }

  private async execute(
    orgId: string,
    runId: string,
    graph: AgentGraph,
    seeds: Record<string, unknown>,
    hooks: RunHooks,
  ): Promise<RunOutcome> {
    const emit = async (type: string, data: Record<string, unknown> = {}) => {
      try {
        await hooks.emit?.(type, data);
      } catch {
        /* an event is observability, never a reason to stop a run */
      }
    };
    const check = validateGraph(graph);
    if (!check.ok) {
      await this.runs.transition(orgId, runId, 'failed', 'graph_invalid').catch(() => undefined);
      return { status: 'failed', reason: `graph_invalid: ${check.errors[0]}` };
    }
    let run = await this.runs.get(orgId, runId);
    if (!run) return { status: 'failed', reason: 'run_not_found' };
    if (TERMINAL_RUN_STATES.includes(run.state)) return this.outcomeOfTerminal(run);
    if (run.state !== 'running') run = await this.runs.transition(orgId, runId, 'running');

    const budget = clampBudget(run.budget);
    const ledger = new BudgetLedger(
      budget,
      run.usage,
      run.startedAt ? Date.parse(run.startedAt) : this.clock(),
      this.clock,
    );
    const cancelled = async () => {
      const r = await this.runs.get(orgId, runId);
      return r?.state === 'cancelled' || r?.cancelRequested === true;
    };
    const model = new GuardedModel(
      this.gateway,
      this.runs,
      ledger,
      this.orgBudget,
      { orgId, runId, dataRegion: run.dataRegion },
      cancelled,
      { timeoutMs: this.cfg.modelTimeoutMs },
    );

    let warned = false;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const artifacts: Record<string, unknown> = { ...seeds };
    const existing = await this.steps(orgId, runId);
    let seq = existing.size;

    for (const [index, nodeId] of check.order.entries()) {
      const node = byId.get(nodeId)!;
      if (await cancelled()) return { status: 'cancelled' };
      let row = existing.get(nodeId);

      if (row?.status === 'succeeded') {
        // resume: the checkpoint is the output; never run the node again
        const stored = await this.artifacts.get(orgId, row.checkpoint_ref as string);
        if (stored === null) return this.fail(orgId, runId, row, 'checkpoint_missing');
        artifacts[node.produces] = stored;
        continue;
      }
      if (row?.status === 'waiting_approval') {
        const decided = await this.settleApprovals(orgId, runId, row);
        if (decided.state === 'pending')
          return { status: 'waiting_approval', approvalIds: decided.ids };
        if (decided.state === 'rejected') return this.fail(orgId, runId, row, 'approval_rejected');
        if (decided.state === 'expired') return this.fail(orgId, runId, row, 'approval_expired');
        await this.runs.transition(orgId, runId, 'running').catch(() => undefined);
        await this.finishStep(orgId, row.id as string, {
          status: 'succeeded',
          checkpoint: row.output_ref as string,
        });
        artifacts[node.produces] = await this.artifacts.get(orgId, row.output_ref as string);
        await emit('node_succeeded', {
          node: node.id,
          agent: node.agent,
          artifact: node.produces,
          artifactRef: row.output_ref as string,
          approved: true,
        });
        await this.afterCheckpoint(nodeId);
        continue;
      }

      const gather = ():
        { ok: true; inputs: Record<string, unknown> } | { ok: false; kind: string } => {
        const inputs: Record<string, unknown> = {};
        for (const kind of node.consumes) {
          if (artifacts[kind] === undefined) return { ok: false, kind };
          inputs[kind] = artifacts[kind];
        }
        return { ok: true, inputs };
      };
      const g = gather();
      if (!g.ok) return this.fail(orgId, runId, row ?? null, `missing_input:${g.kind}`);

      const executor = this.executors.get(node.agent);
      if (!executor) return this.fail(orgId, runId, row ?? null, `no_executor:${node.agent}`);

      // the step row: created once; a row left `running` by a dead worker is taken over (attempt + 1)
      try {
        if (!row) {
          row = await this.insertStep(orgId, runId, run, node, seq++, index);
          existing.set(nodeId, row);
        } else {
          // take-over of a row a dead worker left `running`: an optimistic claim on `attempt`, so two workers cannot both take it
          const claimed = await this.db.withOrg(
            orgId,
            async (c) =>
              (
                await c.query(
                  `UPDATE ai.run_steps SET attempt = attempt + 1, started_at = $3 WHERE id = $1 AND status = 'running' AND attempt = $2`,
                  [row!.id, row!.attempt, new Date()],
                )
              ).rowCount,
          );
          if (!claimed) return { status: 'busy' };
        }
      } catch (e) {
        if ((e as { code?: string }).code === '23505') return { status: 'busy' };
        throw e;
      }
      const stepId = row.id as string;
      model.spent = { tokensIn: 0, tokensOut: 0, costMinor: 0 };
      await emit('node_started', {
        node: node.id,
        agent: node.agent,
        attempt: Number(row.attempt),
      });

      let result: AgentResult | null = null;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= this.cfg.nodeRetries; attempt++) {
        try {
          result = await executor.execute({
            orgId,
            runId,
            projectId: run.projectId,
            dataRegion: run.dataRegion,
            node,
            inputs: g.inputs,
            model,
          });
          const errs = validate(graph.artifacts[node.produces]!.schema, result.artifact);
          if (errs.length) throw new ArtifactInvalid(node.produces, errs);
          break;
        } catch (e) {
          lastErr = e;
          if (e instanceof WorkerCrash) throw e;
          if (
            (e instanceof ModelTimeoutError || e instanceof ModelNoCapacityError) &&
            attempt < this.cfg.nodeRetries
          ) {
            await this.db.withOrg(orgId, (c) =>
              c.query(`UPDATE ai.run_steps SET attempt = attempt + 1 WHERE id = $1`, [stepId]),
            );
            continue;
          }
          break;
        }
      }
      if (!result) {
        await emit('node_failed', {
          node: node.id,
          agent: node.agent,
          reason: lastErr instanceof Error ? lastErr.name : 'agent_error',
        });
        return this.stopOn(orgId, runId, stepId, lastErr, model);
      }

      const ref = await this.artifacts.put(orgId, runId, node.produces, result.artifact);
      await this.recordToolCalls(orgId, runId, run.dataRegion, stepId, result.toolCalls ?? []);
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE ai.run_steps SET output_ref = $2, input_ref = $3, tokens_in = tokens_in + $4, tokens_out = tokens_out + $5, cost_minor = cost_minor + $6 WHERE id = $1`,
          [stepId, ref, null, model.spent.tokensIn, model.spent.tokensOut, model.spent.costMinor],
        ),
      );
      await this.runs.addUsage(orgId, runId, { steps: 1 });
      ledger.countStep();

      if (result.approvals?.length) {
        const ids: string[] = [];
        for (const need of result.approvals) {
          const a = await this.approvals.request(orgId, {
            subject: { type: 'run', id: runId },
            type: need.type,
            action: need.action,
            runId,
            requestedBy: { kind: 'ai' },
            dataRegion: run.dataRegion,
          });
          ids.push(a.id);
        }
        await this.db.withOrg(orgId, (c) =>
          c.query(`UPDATE ai.run_steps SET status = 'waiting_approval' WHERE id = $1`, [stepId]),
        );
        await this.runs.transition(orgId, runId, 'waiting_approval');
        await emit('approval_requested', {
          node: node.id,
          approvalIds: ids,
          types: result.approvals.map((x) => x.type),
        });
        return { status: 'waiting_approval', approvalIds: ids };
      }
      await this.finishStep(orgId, stepId, { status: 'succeeded', checkpoint: ref });
      artifacts[node.produces] = result.artifact;
      await emit('node_succeeded', {
        node: node.id,
        agent: node.agent,
        artifact: node.produces,
        artifactRef: ref,
        tokensIn: model.spent.tokensIn,
        tokensOut: model.spent.tokensOut,
        costMinor: model.spent.costMinor,
      });
      if (!warned && ledger.snapshot().warn) {
        warned = true;
        await emit('budget_warn', { pct: Math.round(ledger.snapshot().pct) });
      }
      await this.afterCheckpoint(nodeId);
    }
    if (hooks.finalize) {
      try {
        await hooks.finalize(artifacts);
      } catch (e) {
        if (e instanceof WorkerCrash) throw e;
        return this.fail(orgId, runId, null, 'finalize_failed');
      }
    }
    await this.runs.transition(orgId, runId, 'succeeded');
    await this.audit.record({
      action: 'ai.run.completed',
      orgId,
      resource: { type: 'run', id: runId },
      outcome: 'success',
      actorType: 'system',
      after: { kind: run.kind, graph: graph.name },
    });
    return { status: 'succeeded', artifacts };
  }

  private outcomeOfTerminal(run: RunRecord): RunOutcome {
    if (run.state === 'succeeded') return { status: 'succeeded', artifacts: {} };
    if (run.state === 'cancelled') return { status: 'cancelled' };
    if (run.state === 'budget_exceeded')
      return { status: 'budget_exceeded', dimension: run.reason ?? 'unknown' };
    return { status: 'failed', reason: run.reason ?? 'failed' };
  }

  private async insertStep(
    orgId: string,
    runId: string,
    run: RunRecord,
    node: GraphNode,
    seq: number,
    _index: number,
  ): Promise<Row> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `INSERT INTO ai.run_steps (id, org_id, run_id, seq, node, agent, status, data_region, started_at) VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8) RETURNING *`,
            [newId(), orgId, runId, seq, node.id, node.agent, run.dataRegion, new Date()],
          )
        ).rows[0] as Row,
    );
  }

  private async finishStep(
    orgId: string,
    stepId: string,
    r: { status: 'succeeded'; checkpoint: string } | { status: 'failed'; error: string },
  ) {
    await this.db.withOrg(orgId, (c) =>
      r.status === 'succeeded'
        ? c.query(
            `UPDATE ai.run_steps SET status = 'succeeded', checkpoint_ref = $2, finished_at = $3 WHERE id = $1`,
            [stepId, r.checkpoint, new Date()],
          )
        : c.query(
            `UPDATE ai.run_steps SET status = 'failed', error_code = $2, finished_at = $3 WHERE id = $1`,
            [stepId, r.error.slice(0, 80), new Date()],
          ),
    );
  }

  private async recordToolCalls(
    orgId: string,
    runId: string,
    region: string,
    stepId: string,
    calls: ToolCallSummary[],
  ) {
    if (!calls.length) return;
    await this.db.withOrg(orgId, async (c) => {
      for (const t of calls)
        await c.query(
          `INSERT INTO ai.tool_calls (id, org_id, run_id, step_id, tool, args_redacted, result_ref, status, duration_ms, data_region) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            newId(),
            orgId,
            runId,
            stepId,
            t.tool,
            JSON.stringify(t.args),
            t.resultRef ?? null,
            t.status ?? 'succeeded',
            t.durationMs ?? null,
            region,
          ],
        );
    });
  }

  private async settleApprovals(
    orgId: string,
    runId: string,
    row: Row,
  ): Promise<{ state: 'pending' | 'approved' | 'rejected' | 'expired'; ids: string[] }> {
    const list = await this.approvals.list(orgId, { runId, limit: 200 });
    const mine = list.filter((a) => a.subjectId === runId);
    if (mine.length === 0) return { state: 'pending', ids: [] };
    void row;
    if (mine.some((a) => a.status === 'rejected'))
      return { state: 'rejected', ids: mine.map((a) => a.id) };
    // the latest request per (type, hash) decides; an expired one with no approved twin is a failure
    const byKey = new Map<string, (typeof mine)[number]>();
    for (const a of mine) {
      const k = `${a.type}:${a.scopeHash}`;
      const prev = byKey.get(k);
      if (
        !prev ||
        a.status === 'approved' ||
        (prev.status !== 'approved' && a.createdAt > prev.createdAt)
      )
        byKey.set(k, a);
    }
    const latest = [...byKey.values()];
    if (latest.some((a) => a.status === 'expired'))
      return { state: 'expired', ids: latest.map((a) => a.id) };
    if (latest.every((a) => a.status === 'approved'))
      return { state: 'approved', ids: latest.map((a) => a.id) };
    return { state: 'pending', ids: latest.filter((a) => a.status === 'pending').map((a) => a.id) };
  }

  private async fail(
    orgId: string,
    runId: string,
    row: Row | null,
    reason: string,
  ): Promise<RunOutcome> {
    if (row)
      await this.finishStep(orgId, row.id as string, { status: 'failed', error: reason }).catch(
        () => undefined,
      );
    await this.runs.transition(orgId, runId, 'failed', reason).catch(() => undefined);
    await this.audit.record({
      action: 'ai.run.failed',
      orgId,
      resource: { type: 'run', id: runId },
      outcome: 'failure',
      actorType: 'system',
      detail: { reason },
    });
    return { status: 'failed', reason };
  }

  private async stopOn(
    orgId: string,
    runId: string,
    stepId: string,
    err: unknown,
    model: GuardedModel,
  ): Promise<RunOutcome> {
    void model;
    if (err instanceof RunCancelled) {
      await this.db.withOrg(orgId, (c) =>
        c.query(`UPDATE ai.run_steps SET status = 'cancelled', finished_at = $2 WHERE id = $1`, [
          stepId,
          new Date(),
        ]),
      );
      return { status: 'cancelled' };
    }
    if (err instanceof BudgetExceeded) {
      await this.finishStep(orgId, stepId, { status: 'failed', error: `budget_${err.dimension}` });
      await this.runs.transition(orgId, runId, 'budget_exceeded', err.dimension);
      await this.audit.record({
        action: 'ai.run.budget_exceeded',
        orgId,
        resource: { type: 'run', id: runId },
        outcome: 'failure',
        actorType: 'system',
        detail: { dimension: err.dimension },
      });
      return { status: 'budget_exceeded', dimension: err.dimension };
    }
    const reason =
      err instanceof ArtifactInvalid
        ? 'artifact_invalid'
        : err instanceof ModelTimeoutError
          ? 'model_timeout'
          : err instanceof ModelNoCapacityError
            ? 'no_capacity'
            : 'agent_error';
    await this.finishStep(orgId, stepId, { status: 'failed', error: reason });
    await this.runs.transition(
      orgId,
      runId,
      'failed',
      reason,
      err instanceof ArtifactInvalid ? err.errors.slice(0, 8) : [],
    );
    await this.audit.record({
      action: 'ai.run.failed',
      orgId,
      resource: { type: 'run', id: runId },
      outcome: 'failure',
      actorType: 'system',
      detail: { reason },
    });
    return { status: 'failed', reason };
  }
}
export { iso };
