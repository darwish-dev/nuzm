import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { ApprovalService } from './approvals/approval.service';
import { RUN_CEILINGS, isUuid, type Row } from './core';
import { WEBAPP_GRAPH } from './graph/dag';
import { clampBudget } from './graph/budget';
import type { GraphRunner } from './graph/runner';
import type {
  OrgBudgetPort,
  ProjectsPort,
  RunBudget,
  RunKind,
  RunRecord,
  RunStorePort,
} from './ports/m09';
import type { TestFixService } from './tests/test-fix.service';

export interface RunView {
  id: string;
  kind: RunKind;
  projectId: string;
  state: string;
  reason: string | null;
  budget: RunBudget;
  usage: RunRecord['usage'];
  /** Live meter: what is left of every cap (tokens, cost, minutes). */
  budgetRemaining: { tokens: number; costMinor: number; minutes: number; steps: number };
  warn: boolean;
  steps: {
    seq: number;
    node: string;
    agent: string;
    status: string;
    attempt: number;
    tokensIn: number;
    tokensOut: number;
    costMinor: number;
    errorCode: string | null;
    toolCalls: {
      tool: string;
      status: string;
      args: Record<string, unknown>;
      durationMs: number | null;
    }[];
  }[];
  pendingApprovals: { id: string; type: string; scopeHash: string; expiresAt: string }[];
  dataRegion: string;
  createdAt: string;
  finishedAt: string | null;
}
const DEFAULT_RUN_BUDGET: RunBudget = {
  maxTokens: 1_000_000,
  maxCostMinor: 50_000,
  maxMinutes: 30,
};

/** Starts, cancels and presents runs of kind `webapp` (agent graph) and `test-fix` (bounded debugging loop) on top of the M09 run store. */
export class AppRunService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly runs: RunStorePort,
    private readonly projects: ProjectsPort,
    private readonly orgBudget: OrgBudgetPort,
    private readonly graph: GraphRunner,
    private readonly testFix: TestFixService,
    private readonly approvals: ApprovalService,
    private readonly kick: 'async' | 'off' = process.env.APPBUILDER_KICK === 'off'
      ? 'off'
      : 'async',
  ) {
    approvals.onDecision(async (orgId, a) => {
      if (a.runId) void this.resume(orgId, a.runId);
    });
  }

  parseBudget(b: unknown): RunBudget {
    if (b === undefined) return DEFAULT_RUN_BUDGET;
    const x = b as Partial<RunBudget>;
    const ok = (n: unknown, max: number) =>
      Number.isInteger(n) && (n as number) > 0 && (n as number) <= max;
    if (
      typeof b !== 'object' ||
      b === null ||
      !ok(x.maxTokens, RUN_CEILINGS.maxTokens) ||
      !ok(x.maxCostMinor, 1_000_000_000) ||
      !ok(x.maxMinutes, RUN_CEILINGS.maxMinutes)
    )
      throw new ProblemException(
        'validation_failed',
        `budget needs integer maxTokens (≤ ${RUN_CEILINGS.maxTokens}), maxCostMinor and maxMinutes (≤ ${RUN_CEILINGS.maxMinutes})`,
      );
    return clampBudget(x as RunBudget);
  }

  async create(
    orgId: string,
    actor: string,
    body: {
      kind?: unknown;
      projectId?: unknown;
      sessionId?: unknown;
      specRef?: unknown;
      budget?: unknown;
      brief?: unknown;
    },
  ): Promise<RunView> {
    const kind = body.kind as RunKind;
    if (kind === 'mobile')
      throw new ProblemException('unsupported_capability', 'mobile runs arrive with M10B');
    if (kind !== 'webapp' && kind !== 'test-fix')
      throw new ProblemException(
        'unsupported_capability',
        `runs of kind ${String(kind)} are handled by M09`,
      );
    if (!isUuid(body.projectId))
      throw new ProblemException('validation_failed', 'projectId is required');
    const project = await this.projects.get(orgId, body.projectId);
    if (!project) throw new ProblemException('not_found', 'project not found');
    if (project.type !== 'webapp')
      throw new ProblemException('validation_failed', 'this run kind needs a web-app project');
    const budget = this.parseBudget(body.budget);
    if ((await this.orgBudget.remainingMinor(orgId)) <= 0)
      throw new ProblemException('budget_required', 'the organization has no AI credit left');
    const run = await this.runs.create(orgId, {
      kind,
      projectId: project.id,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      budget,
      dataRegion: project.dataRegion,
      createdBy: actor,
      specRef: typeof body.specRef === 'string' ? body.specRef : null,
    });
    await this.audit.record({
      action: 'ai.run.started',
      orgId,
      actorUserId: actor,
      resource: { type: 'run', id: run.id },
      outcome: 'success',
      after: { kind, projectId: project.id, budget },
    });
    if (this.kick === 'async') setImmediate(() => void this.execute(orgId, actor, run, body.brief));
    return this.view(orgId, run.id);
  }

  /** Runs the work of a run to its next stop (completion, approval wait, failure). Exposed for the worker and the tests. */
  async execute(orgId: string, actor: string, run: RunRecord, brief?: unknown): Promise<unknown> {
    try {
      if (run.kind === 'webapp')
        return await this.graph.run(orgId, run.id, WEBAPP_GRAPH, {
          brief: (brief as Record<string, unknown>) ?? {},
        });
      if (run.kind === 'test-fix')
        return await this.testFix.run(orgId, actor, run.projectId, run.id);
    } catch {
      await this.runs.transition(orgId, run.id, 'failed', 'internal_error').catch(() => undefined);
    }
    return null;
  }
  /** After an approval decision the parked run continues from its checkpoint. */
  async resume(orgId: string, runId: string): Promise<void> {
    const run = await this.runs.get(orgId, runId);
    if (run && run.state === 'waiting_approval' && this.kick === 'async')
      setImmediate(() => void this.execute(orgId, run.createdBy ?? '', run));
  }
  async cancel(orgId: string, actor: string, runId: string): Promise<RunView> {
    const run = await this.runs.get(orgId, runId);
    if (!run) throw new ProblemException('not_found', 'run not found');
    if (['succeeded', 'failed', 'cancelled', 'budget_exceeded'].includes(run.state))
      throw new ProblemException('conflict', `the run is already ${run.state}`);
    await this.runs.transition(orgId, runId, 'cancelled', 'cancelled_by_user');
    await this.audit.record({
      action: 'ai.run.cancelled',
      orgId,
      actorUserId: actor,
      resource: { type: 'run', id: runId },
      outcome: 'success',
    });
    return this.view(orgId, runId);
  }

  async view(orgId: string, runId: string): Promise<RunView> {
    const run = await this.runs.get(orgId, runId);
    if (!run) throw new ProblemException('not_found', 'run not found');
    const steps = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM ai.run_steps WHERE org_id = $1 AND run_id = $2 ORDER BY seq`,
            [orgId, runId],
          )
        ).rows as Row[],
    );
    const calls = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM ai.tool_calls WHERE org_id = $1 AND run_id = $2 ORDER BY created_at`,
            [orgId, runId],
          )
        ).rows as Row[],
    );
    const pending = (await this.approvals.list(orgId, { runId, status: 'pending' })).filter(
      (a) => a.subjectId === runId || a.runId === runId,
    );
    const used = run.usage;
    const minutes = run.startedAt ? (Date.now() - Date.parse(run.startedAt)) / 60_000 : 0;
    const b = clampBudget(run.budget);
    const rem = {
      tokens: Math.max(0, b.maxTokens - used.tokensIn - used.tokensOut),
      costMinor: Math.max(0, b.maxCostMinor - used.costMinor),
      minutes: Math.max(0, Math.round((b.maxMinutes - minutes) * 10) / 10),
      steps: Math.max(0, RUN_CEILINGS.maxSteps - used.steps),
    };
    const pct =
      Math.max(
        (used.tokensIn + used.tokensOut) / b.maxTokens,
        used.costMinor / Math.max(1, b.maxCostMinor),
        minutes / b.maxMinutes,
      ) * 100;
    return {
      id: run.id,
      kind: run.kind,
      projectId: run.projectId,
      state: run.state,
      reason: run.reason,
      budget: run.budget,
      usage: used,
      budgetRemaining: rem,
      warn: pct >= RUN_CEILINGS.warnAtPct,
      steps: steps.map((s) => ({
        seq: s.seq as number,
        node: s.node as string,
        agent: s.agent as string,
        status: s.status as string,
        attempt: s.attempt as number,
        tokensIn: Number(s.tokens_in),
        tokensOut: Number(s.tokens_out),
        costMinor: Number(s.cost_minor),
        errorCode: (s.error_code as string | null) ?? null,
        // tool-call summaries are already redacted when stored (args_redacted); nothing else of a call is exposed
        toolCalls: calls
          .filter((c) => c.step_id === s.id)
          .map((c) => ({
            tool: c.tool as string,
            status: c.status as string,
            args: c.args_redacted as Record<string, unknown>,
            durationMs: (c.duration_ms as number | null) ?? null,
          })),
      })),
      pendingApprovals: pending.map((a) => ({
        id: a.id,
        type: a.type,
        scopeHash: a.scopeHash,
        expiresAt: a.expiresAt,
      })),
      dataRegion: run.dataRegion,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    };
  }
}
