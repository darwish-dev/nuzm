import { createHash } from 'node:crypto';
import {
  ReadOnlyWorkspace,
  AGENT_LOOP_LIMITS,
  AGENT_TOOL_LIMITS,
  assembleContext,
  diffWorkspace,
  type FileOrigin,
  type AdaptationMode,
  type AssembledContext,
  type WorkspaceFile,
} from '@nuzm/domain';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { RunService, SessionService } from '../../../ai';
import {
  knowledgeAgenticEnabled,
  knowledgeGenerationEnabled,
  type CustomerTemplateService,
} from '../../../knowledge';
import type { Db } from '@nuzm/platform';
import type { ProjectRecord, ProjectsPort } from '../ports/m09';
import { isUuid } from '../core';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
type Row = Record<string, unknown>;

/** What a run (or the preview) works from: the plan, the project's current files, the baseline of its template copy and the assembled, bounded context. */
export interface Prepared {
  plan: Row;
  project: ProjectRecord;
  mode: AdaptationMode;
  files: Map<string, string>;
  baseline: Record<string, string>;
  template: { resourceId: string; versionId: string; name: string; license: string | null } | null;
  aiProcessing: boolean;
  context: AssembledContext;
}

/**
 * The adaptation of a copied template (S-K6, SCR-K-09): compare the customer's workspace with the copy's baseline, show EXACTLY what a model would receive, and start the run that
 * adapts the copy. Everything here is tenant-scoped; nothing reads a template's files (the baseline is a record of what the customer's own copy contains, so it keeps working after
 * the template changes or is withdrawn). No model is called here: the run engine does that, metered, with its residency, budget and secret checks.
 */
export class GenerationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly templates: CustomerTemplateService,
    private readonly projects: ProjectsPort,
    private readonly runs: RunService,
    private readonly sessions: SessionService,
  ) {}

  private async head(orgId: string, p: ProjectRecord): Promise<Map<string, string>> {
    if (!p.headVersionId) return new Map();
    return (await this.projects.readFiles(orgId, p.id, p.headVersionId)) ?? new Map();
  }
  private async project(orgId: string, id: unknown): Promise<ProjectRecord> {
    if (!isUuid(id)) throw new ProblemException('not_found', 'project not found');
    const p = await this.projects.get(orgId, id.toLowerCase());
    if (!p) throw new ProblemException('not_found', 'project not found');
    return p;
  }

  /** The project compared with the template copy it started from. A project that was not copied (or was copied before baselines were recorded) says so. */
  async workspace(orgId: string, projectId: string) {
    const p = await this.project(orgId, projectId);
    const link = await this.templates.linkForProject(orgId, p.id);
    if (!link)
      return { linked: false as const, project: { id: p.id, headVersionId: p.headVersionId } };
    const files = await this.head(orgId, p);
    const diff = diffWorkspace(link.baseline, new Map([...files].map(([k, v]) => [k, sha(v)])));
    const facts = await this.templates.templateFacts(orgId, link.versionId);
    return {
      linked: true as const,
      project: { id: p.id, headVersionId: p.headVersionId },
      copiedAt: link.createdAt,
      // the template may have been changed or withdrawn since: the comparison does not depend on it
      template: facts
        ? {
            resourceId: facts.template.id,
            versionId: link.versionId,
            versionSeq: facts.template.versionSeq,
            name: facts.template.name,
            license: facts.template.license.spdx,
          }
        : null,
      templateAvailable: facts !== null,
      diff,
    };
  }

  /**
   * The project as a READ-ONLY snapshot for the agent tools (S-AG2): its current files, who wrote each (a file still byte-identical to the template copy is the template's), and the
   * template's AI-processing permission (unknown, or a template that is gone, means not allowed). `null` when the project is not visible to this organization.
   */
  async workspaceView(orgId: string, projectId: string): Promise<ReadOnlyWorkspace | null> {
    if (!isUuid(projectId)) return null;
    const project = await this.projects.get(orgId, projectId.toLowerCase());
    if (!project) return null;
    const link = await this.templates.linkForProject(orgId, project.id);
    const baseline = link?.baseline ?? {};
    const files = await this.head(orgId, project);
    const facts = link ? await this.templates.templateFacts(orgId, link.versionId) : null;
    const origins = new Map<string, FileOrigin>();
    for (const [path, content] of files)
      origins.set(
        path,
        Object.hasOwn(baseline, path) && baseline[path] === sha(content) ? 'template' : 'customer',
      );
    return new ReadOnlyWorkspace(files, { origins, aiProcessing: facts?.aiProcessing === true });
  }

  /** Everything a run needs, computed from the current state (never cached: the project may have changed since the preview). */
  async prepare(orgId: string, planId: string, budgetTokens?: number): Promise<Prepared> {
    const plan = await this.templates.planRow(orgId, planId);
    const project = await this.project(orgId, plan.project_id);
    const mode = plan.adaptation_mode as AdaptationMode;
    const link = await this.templates.linkForProject(orgId, project.id);
    const baseline = link?.baseline ?? {};
    const files = await this.head(orgId, project);
    const facts = link ? await this.templates.templateFacts(orgId, link.versionId) : null;
    // an unknown permission is "not allowed": a template that is gone cannot say that its source may be sent
    const aiProcessing = facts?.aiProcessing === true;
    const workspace: WorkspaceFile[] = [...files].map(([path, content]) => ({
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
      origin:
        Object.hasOwn(baseline, path) && baseline[path] === sha(content) ? 'template' : 'customer',
    }));
    const req = (plan.requirements ?? {}) as Row;
    const context = assembleContext({
      requirement: {
        text: typeof req.text === 'string' ? req.text : null,
        platform: typeof req.platform === 'string' ? req.platform : null,
        frameworks: Array.isArray(req.frameworks) ? (req.frameworks as string[]) : [],
      },
      mode,
      template: facts
        ? {
            name: facts.template.name,
            description: facts.template.description,
            capabilities: facts.template.capabilities,
            license: facts.template.license.spdx,
            design: (() => {
              const d = facts.template.design as Row | null;
              return d
                ? {
                    modes: (d.modes as string[]) ?? [],
                    roles: (d.roles as { role: string; hex: string }[]) ?? [],
                    families: (d.families as string[]) ?? [],
                  }
                : null;
            })(),
          }
        : null,
      aiProcessing,
      files: workspace,
      contents: files,
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    });
    return {
      plan,
      project,
      mode,
      files,
      baseline,
      template: facts
        ? {
            resourceId: facts.template.id,
            versionId: facts.template.versionId,
            name: facts.template.name,
            license: facts.template.license.spdx,
          }
        : null,
      aiProcessing,
      context,
    };
  }

  /** The preview: exactly what the run would send (the policy and every data block), what was left out and why, and the facts that decided it. */
  async context(orgId: string, planId: string, budgetTokens?: number) {
    const x = await this.prepare(orgId, planId, budgetTokens);
    return {
      planId: x.plan.id as string,
      projectId: x.project.id,
      mode: x.mode,
      template: x.template,
      aiProcessing: x.aiProcessing,
      policy: x.context.policy,
      tokens: x.context.tokens,
      blocks: x.context.blocks.map((b) => ({
        kind: b.kind,
        label: b.label,
        tokens: b.tokens,
        text: b.text,
      })),
      included: x.context.included,
      excluded: x.context.excluded,
      notes: x.context.notes,
    };
  }

  /** Starts the adaptation: a run of the existing `webapp` kind with `input.templatePlanId` (budget, kill switch, residency, secret scan and metering are the run engine's). */
  async start(
    orgId: string,
    userId: string,
    planId: string,
    idempotencyKey: string | undefined,
    body: { budget?: unknown; agentic?: unknown },
  ) {
    const plan = await this.templates.planRow(orgId, planId);
    if (plan.status !== 'PLANNED' || plan.run_id)
      throw new ProblemException('conflict', 'this plan has already been started');
    const project = await this.project(orgId, plan.project_id);
    if (project.type !== 'webapp')
      throw new ProblemException('validation_failed', 'a plan adapts a web-app project');
    if (!project.headVersionId)
      throw new ProblemException('validation_failed', 'the project has no files to adapt');
    // the agent loop is a separate, per-organization flag (default off): asking for it while it is off is refused, never silently downgraded
    if (body.agentic !== undefined && typeof body.agentic !== 'boolean')
      throw new ProblemException('validation_failed', 'agentic must be a boolean');
    if (body.agentic === true && !(await knowledgeAgenticEnabled(this.db, orgId)))
      throw new ProblemException(
        'unsupported_capability',
        'the agent mode is not enabled for this organization',
      );
    const session = await this.sessions.create(orgId, userId, {
      title: 'Template adaptation',
      projectId: project.id,
    });
    const run = await this.runs.create(orgId, userId, idempotencyKey, {
      kind: 'webapp',
      sessionId: session.id,
      projectId: project.id,
      input: { templatePlanId: plan.id, ...(body.agentic === true ? { agentic: true } : {}) },
      ...(body.budget !== undefined ? { budget: body.budget } : {}),
    });
    if (!(await this.templates.attachRun(orgId, plan.id as string, run.id)))
      // a second start won the race: this run must not also adapt the project
      await this.runs.cancel(orgId, userId, run.id).catch(() => undefined);
    await this.audit.record({
      action: 'knowledge.plan.run_started',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'knowledge_plan', id: plan.id as string },
      outcome: 'success',
      detail: { runId: run.id, projectId: project.id, mode: plan.adaptation_mode },
    });
    return this.plan(orgId, plan.id as string);
  }

  /** A plan, following its run: RUNNING settles to COMPLETED, FAILED or CANCELLED when the run has ended; `execution` says what can happen next, honestly. */
  async plan(orgId: string, planId: string) {
    let row = await this.templates.planRow(orgId, planId);
    let runState: string | null = null;
    if (row.run_id) {
      const run = await this.runs.get(orgId, row.run_id as string).catch(() => null);
      runState = run?.state ?? null;
      if (row.status === 'RUNNING' && runState) {
        const end =
          runState === 'succeeded'
            ? 'COMPLETED'
            : runState === 'cancelled'
              ? 'CANCELLED'
              : runState === 'failed' || runState === 'budget_exceeded'
                ? 'FAILED'
                : null;
        if (end) {
          await this.templates.settlePlan(orgId, row.id as string, end);
          row = await this.templates.planRow(orgId, planId);
        }
      }
    }
    const base = await this.templates.getPlan(orgId, planId);
    const enabled = await knowledgeGenerationEnabled(this.db, orgId);
    const execution = row.run_id
      ? { status: String(row.status), runId: row.run_id as string, runState }
      : enabled
        ? {
            status: 'READY',
            reason: 'start the run to adapt the copy; model quality is NOT VERIFIED',
          }
        : { status: 'BLOCKED', reason: 'template generation is not enabled for this organization' };
    return { ...base, status: String(row.status), plan: { ...base.plan, execution } };
  }

  /**
   * The read-only execution timeline of a plan's run (S-AG3): what the run did, step by step: the model turns (phase, tokens), the read-only tool calls of each (tool, redacted arguments,
   * outcome, size), the validation and apply steps, a fallback to the single call and why, the limits used, and the outcome. Everything is the customer's own run data; nothing is
   * written and no model is called. A plan without a run, or a run of the single-call adaptation, says so.
   */
  async timeline(orgId: string, planId: string) {
    const plan = await this.templates.planRow(orgId, planId);
    const runId = (plan.run_id as string | null) ?? null;
    const empty = {
      planId: plan.id as string,
      runId: null as string | null,
      mode: 'NONE' as 'NONE' | 'SINGLE_CALL' | 'AGENTIC' | 'AGENTIC_FELL_BACK',
      runState: null as string | null,
      fellBack: null as string | null,
      plan: null as string | null,
      limits: this.limitsView(0, 0, 0, 0),
      steps: [] as unknown[],
      outcome: null as Record<string, unknown> | null,
    };
    if (!runId) return empty;
    const data = await this.db.withOrg(orgId, async (c) => {
      const run = (
        await c.query(
          `SELECT state, result, error, checkpoint #>> '{agent,plan}' AS plan, created_at, started_at, finished_at FROM ai.runs WHERE id = $1`,
          [runId],
        )
      ).rows[0] as Record<string, unknown> | undefined;
      const steps = (
        await c.query(
          `SELECT id, seq, node, status, input_ref, output_ref, error_code, tokens_in, tokens_out, started_at, finished_at
             FROM ai.run_steps WHERE run_id = $1 AND agent = 'agent' ORDER BY seq`,
          [runId],
        )
      ).rows as Record<string, unknown>[];
      const calls = (
        await c.query(
          `SELECT step_id, tool, args_redacted, status, error_code, result_bytes, duration_ms, call_id
             FROM ai.tool_calls WHERE run_id = $1 AND call_id IS NOT NULL ORDER BY created_at, id`,
          [runId],
        )
      ).rows as Record<string, unknown>[];
      return { run, steps, calls };
    });
    if (!data.run) return empty;
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
    const stepViews = data.steps.map((st) => ({
      seq: Number(st.seq),
      node: String(st.node),
      phase: typeof st.input_ref === 'string' ? st.input_ref : null,
      status: String(st.status),
      errorCode: (st.error_code as string | null) ?? null,
      reason: st.node === 'fallback' ? ((st.output_ref as string | null) ?? null) : null,
      tokensIn: Number(st.tokens_in),
      tokensOut: Number(st.tokens_out),
      startedAt: iso(st.started_at),
      finishedAt: iso(st.finished_at),
      toolCalls: data.calls
        .filter((k) => k.step_id === st.id)
        .map((k) => ({
          callId: String(k.call_id),
          tool: String(k.tool),
          args: k.args_redacted as Record<string, unknown>,
          status: String(k.status),
          errorCode: (k.error_code as string | null) ?? null,
          resultBytes: Number(k.result_bytes ?? 0),
          durationMs: k.duration_ms === null ? null : Number(k.duration_ms),
        })),
    }));
    const fb = stepViews.find((x) => x.node === 'fallback');
    const turns = stepViews.filter((x) => /^turn-\d+$/.test(x.node)).length;
    const result = (data.run.result ?? null) as Record<string, unknown> | null;
    const errCode = (data.run.error as { code?: unknown } | null)?.code;
    const state = String(data.run.state);
    const outcome =
      state === 'succeeded' && result
        ? {
            outcome: typeof result.outcome === 'string' ? result.outcome : null,
            summary: typeof result.summary === 'string' ? result.summary.slice(0, 500) : null,
            patches: typeof result.patches === 'number' ? result.patches : null,
            versionId: typeof result.versionId === 'string' ? result.versionId : null,
            branch: typeof result.branch === 'string' ? result.branch : null,
          }
        : ['failed', 'cancelled', 'budget_exceeded'].includes(state)
          ? { outcome: state, errorCode: typeof errCode === 'string' ? errCode.slice(0, 60) : null }
          : null;
    const started = data.run.started_at instanceof Date ? data.run.started_at.getTime() : null;
    const finished =
      data.run.finished_at instanceof Date ? data.run.finished_at.getTime() : Date.now();
    return {
      planId: plan.id as string,
      runId,
      mode:
        stepViews.length === 0
          ? ('SINGLE_CALL' as const)
          : fb
            ? ('AGENTIC_FELL_BACK' as const)
            : ('AGENTIC' as const),
      runState: state,
      fellBack: fb?.reason ?? null,
      plan: (data.run.plan as string | null) ?? null,
      limits: this.limitsView(
        turns,
        data.calls.length,
        data.calls.reduce((n, k) => n + Number(k.result_bytes ?? 0), 0),
        stepViews.reduce((n, x) => n + x.tokensIn + x.tokensOut, 0),
        started === null ? 0 : Math.max(0, Math.round((finished - started) / 1000)),
      ),
      steps: stepViews,
      outcome,
    };
  }

  private limitsView(
    turns: number,
    toolCalls: number,
    resultBytes: number,
    tokens: number,
    seconds = 0,
  ) {
    return {
      turns: { used: turns, max: AGENT_LOOP_LIMITS.maxTurns },
      toolCalls: { used: toolCalls, max: AGENT_TOOL_LIMITS.maxCallsPerRun },
      resultBytes: { used: resultBytes, max: AGENT_TOOL_LIMITS.maxResultBytesPerRun },
      tokens: { used: tokens, max: AGENT_LOOP_LIMITS.maxTokens },
      seconds: { used: seconds, max: AGENT_LOOP_LIMITS.maxMinutes * 60 },
    };
  }
}
