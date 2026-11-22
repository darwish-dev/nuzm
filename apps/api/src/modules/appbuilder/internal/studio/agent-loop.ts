import { v7 as uuidv7 } from 'uuid';
import type { ContentBlock, ToolSpec } from '@nuzm/adapter-model';
import {
  ADAPT_MAX_PATCHES,
  AGENT_LOOP_LIMITS,
  EXHAUSTED_TOOLS_MESSAGE,
  agentSystemPrompt,
  ceilingFallback,
  ceilingReached,
  classifyGatewayError,
  dataFence,
  frameToolResult,
  mustPropose,
  newCounters,
  openingMessage,
  parseProposal,
  proposalFeedback,
  rejectedCallResult,
  turnPhase,
  type AgentLoopLimits,
  type FallbackReason,
  type LoopCounters,
  type LoopPhase,
  type Proposal,
} from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { AgentToolGateway, GatewayService, RunContext } from '../../../ai';
import { knowledgeAgenticEnabled, knowledgeGenerationEnabled } from '../../../knowledge';
import type { GenerationService, Prepared } from './generation';
import type { TemplateAdaptRunner } from './template-adapt';

type Msg = { role: 'user' | 'assistant'; content: string; blocks?: ContentBlock[] };

/** What the loop keeps in the run checkpoint (`ctx.checkpoint.agent`): enough to resume after a crash without repeating a model call, a tool batch or an applied change. */
interface AgentCheckpoint {
  /** the untrusted-content marker of this run: fixed across a resume so earlier tool results keep their framing */
  fence: string;
  counters: LoopCounters;
  messages: Msg[];
  toolsExhausted: boolean;
  /** the model's own words for its plan (short; shown to the customer as data) */
  plan: string | null;
  /** credits spent by the loop's own model calls, as a decimal string */
  credits: string;
  fellBack?: FallbackReason;
}

const NODE = (turn: number) => `turn-${turn}`;
const SEQ_VALIDATE = 100;
const SEQ_APPLY = 200;
const SEQ_FALLBACK = 201;

/**
 * The agent loop (S-AG3, D-46, ADR-066, SCR-K-10 §5): plan, explore with the read-only tools, propose, validate, apply. It is a mode of the existing `webapp` run kind
 * (`input.templatePlanId` + `input.agentic`) and reuses everything around it: the model gateway (metered, residency, budget, secret scan), the S-AG2 tool gateway (allow-list, limits,
 * audit, isolation), the S-K6 proposal checks and apply path (AI branch only). The loop itself has no power of its own: it cannot write, run or fetch anything. Its model turns and tool
 * calls are persisted (`ai.run_steps`, `ai.tool_calls`, run events) so the customer can see exactly what happened. It applies ONLY at its very end, so a fallback to the single-call
 * adaptation (S-K6) is always safe: before that nothing has changed. Mock provider only in this milestone: model quality is NOT VERIFIED.
 */
export class AgentLoopRunner {
  /** public so a test can tighten them; production uses the domain defaults */
  limits: AgentLoopLimits = { ...AGENT_LOOP_LIMITS };
  /** the clock, replaceable in tests */
  now: () => number = () => Date.now();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly gen: GenerationService,
    private readonly adapt: TemplateAdaptRunner,
    private readonly tools: AgentToolGateway,
    private readonly gateway: GatewayService,
  ) {}

  async run(ctx: RunContext): Promise<void> {
    // as the single call: a run can be created through the generic run endpoint, which cannot know the flags
    if (!(await knowledgeGenerationEnabled(this.db, ctx.orgId)))
      throw new ProblemException(
        'unsupported_capability',
        'template generation is not enabled for this organization',
      );
    const prep = await this.prepare(ctx);

    const saved = ctx.checkpoint.agent as AgentCheckpoint | undefined;
    // a resume after the change was applied must not ask the model again: it only reports the result
    const done = ctx.checkpoint.applied as
      { versionId: string; commit: string; branch: string } | undefined;
    if (done && saved)
      return ctx.succeed({
        outcome: 'adapted',
        mode: prep.mode,
        agentic: true,
        turns: saved.counters.turns,
        toolCalls: saved.counters.toolCalls,
        ...done,
        note: 'model quality and the result of building it are NOT VERIFIED',
      });
    if (saved?.fellBack) return this.fallback(ctx, saved, saved.fellBack); // a resume after a fallback goes on with the single call
    if (!(await knowledgeAgenticEnabled(this.db, ctx.orgId)))
      return this.fallback(ctx, this.fresh(), 'agentic_disabled');
    const specs = await this.tools.specs(ctx.orgId, 'webapp');
    if (specs.length === 0) return this.fallback(ctx, saved ?? this.fresh(), 'tools_unavailable');

    const cp = saved ?? this.fresh();
    if (!saved) {
      await ctx.save({ agent: cp }, 'agent_started');
      await ctx.emit('agent_started', { mode: prep.mode, tools: specs.map((s) => s.name) });
      await this.audit.record({
        action: 'ai.agent.run_started',
        orgId: ctx.orgId,
        ...(ctx.userId ? { actorUserId: ctx.userId } : {}),
        actorType: 'user',
        resource: { type: 'ai_run', id: ctx.run.id },
        outcome: 'success',
        detail: { planId: String(ctx.run.input.templatePlanId), mode: prep.mode },
      });
    }
    try {
      return await this.loop(ctx, prep, cp, specs);
    } catch (e) {
      // a control-flow signal of the run engine (success, suspension) is not a failure
      if (!(e instanceof ProblemException)) throw e;
      await this.audit.record({
        action: 'ai.agent.run_failed',
        orgId: ctx.orgId,
        actorType: 'system',
        resource: { type: 'ai_run', id: ctx.run.id },
        outcome: 'failure',
        detail: { code: e.code, turns: cp.counters.turns, toolCalls: cp.counters.toolCalls },
      });
      throw e;
    }
  }

  private fresh(): AgentCheckpoint {
    return {
      fence: dataFence(),
      counters: newCounters(this.now()),
      messages: [],
      toolsExhausted: false,
      plan: null,
      credits: '0',
    };
  }

  private async prepare(ctx: RunContext): Promise<Prepared> {
    const prep = await this.gen.prepare(ctx.orgId, String(ctx.run.input.templatePlanId));
    if (prep.project.id !== ctx.run.projectId)
      throw new ProblemException('validation_failed', 'the plan belongs to another project');
    if (!prep.project.headVersionId)
      throw new ProblemException('validation_failed', 'the project has no files to adapt');
    return prep;
  }

  private async loop(
    ctx: RunContext,
    prep: Prepared,
    cp: AgentCheckpoint,
    specs: ToolSpec[],
  ): Promise<void> {
    const system = agentSystemPrompt({
      policy: prep.context.policy,
      toolNames: specs.map((s) => s.name),
      maxPatches: ADAPT_MAX_PATCHES,
    });
    if (cp.messages.length === 0)
      cp.messages.push({
        role: 'user',
        content: openingMessage(
          prep.context.blocks
            .filter((b) => b.kind !== 'file')
            .map((b) => ({ label: b.label, text: b.text })),
          cp.fence,
        ),
      });

    for (;;) {
      if (await ctx.cancelled()) return this.cancelled(ctx, cp);
      const ceiling = ceilingReached(cp.counters, this.now(), this.limits);
      if (ceiling) return this.fallback(ctx, cp, ceilingFallback(ceiling));

      const turn = cp.counters.turns + 1;
      const forced = mustPropose(cp.counters, cp.toolsExhausted, this.limits);
      const stepId = await this.stepBegin(
        ctx,
        turn - 1,
        NODE(turn),
        forced ? 'propose' : turn === 1 ? 'plan' : 'explore',
      );

      const attempt = await this.stepAttempt(ctx, stepId);
      let r: Awaited<ReturnType<GatewayService['invoke']>>;
      try {
        r = await this.withCancelPoll(ctx, (signal) =>
          this.gateway.invoke({
            orgId: ctx.orgId,
            runId: ctx.run.id,
            ...(ctx.run.projectId ? { projectId: ctx.run.projectId } : {}),
            runKind: 'webapp',
            task: 'edit',
            capability: 'chat',
            dataClass: 'customer-content',
            messages: [{ role: 'system', content: system }, ...cp.messages],
            maxTokens: this.limits.maxCompletionTokens,
            // tools are offered only while the loop may still explore; the forced proposal turn has none
            ...(forced ? {} : { tools: specs }),
            // a retried turn (after a crash) is a new call: the settled one is never reused
            callId: `${ctx.run.id}:${NODE(turn)}:${attempt}`,
            runBudget: ctx.run.budget,
            signal,
            ...(ctx.userId ? { actorUserId: ctx.userId } : {}),
          }),
        );
      } catch (e) {
        const code = e instanceof ProblemException ? e.code : 'internal_error';
        await this.stepEnd(ctx, stepId, NODE(turn), 'failed', { errorCode: code });
        if (await ctx.cancelled()) return this.cancelled(ctx, cp);
        const c = classifyGatewayError(code);
        if (c.action === 'fallback') return this.fallback(ctx, cp, c.reason);
        throw e;
      }

      cp.counters.turns = turn;
      cp.counters.tokens += r.tokensIn + r.tokensOut;
      cp.credits = (BigInt(cp.credits) + r.credits).toString();
      const requested = [...(r.toolCalls ?? []), ...(r.rejectedToolCalls ?? [])];

      // ---- the model asked for tools: run the valid ones, answer the rejected ones with a structured error, feed everything back
      if (requested.length > 0 && !forced) {
        if (turn === 1 && r.text) cp.plan = r.text.trim().slice(0, this.limits.planChars);
        const valid = r.toolCalls ?? [];
        const rejected = r.rejectedToolCalls ?? [];
        cp.counters.toolCalls += requested.length;
        let denied = 0;
        let results: ContentBlock[] = [];
        let limitReached: 'calls' | 'bytes' | null = null;
        if (valid.length > 0) {
          const batch = await this.tools.execute(
            { orgId: ctx.orgId, runId: ctx.run.id, stepId },
            valid,
          );
          results = batch.blocks;
          limitReached = batch.limitReached;
          denied = batch.outcomes.filter((o) => o.status !== 'succeeded').length;
        }
        const blocks: ContentBlock[] = [
          ...results.map((b) =>
            b.type === 'tool_result' ? { ...b, content: frameToolResult(cp.fence, b.content) } : b,
          ),
          ...rejected.map((x) => ({
            type: 'tool_result' as const,
            callId: x.id,
            content: frameToolResult(cp.fence, rejectedCallResult(x)),
            isError: true,
          })),
        ];
        cp.messages.push({
          role: 'assistant',
          content: r.text,
          blocks: [
            ...valid.map((c) => ({
              type: 'tool_call' as const,
              id: c.id,
              name: c.name,
              args: c.args,
            })),
            ...rejected.map((x) => ({
              type: 'tool_call' as const,
              id: x.id,
              name: x.name,
              args: {},
            })), // the arguments of a rejected call are not kept
          ],
        });
        cp.messages.push({
          role: 'user',
          content: limitReached ? EXHAUSTED_TOOLS_MESSAGE : '',
          blocks,
        });
        if (limitReached) cp.toolsExhausted = true;
        await this.stepEnd(ctx, stepId, NODE(turn), 'succeeded', {
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          credits: r.credits,
          phase: turnPhase(turn, true),
        });
        await ctx.save({ agent: cp }, NODE(turn));
        await ctx.emit('agent_turn', {
          turn,
          phase: turnPhase(turn, true),
          toolCalls: requested.length,
          rejected: rejected.length,
          denied,
          limitReached,
        });
        continue;
      }

      // ---- no tool calls: this is the proposal
      const parsed = parseProposal(r.text);
      const problems = parsed.ok
        ? this.adapt.proposalProblems(prep, parsed.proposal)
        : parsed.errors;
      // A rejected proposal is never echoed back or kept in the checkpoint: it may carry a secret or a hostile path.
      cp.messages.push({
        role: 'assistant',
        content: !parsed.ok || problems.length > 0 ? '[proposal withheld: rejected]' : r.text,
      });
      await this.stepEnd(ctx, stepId, NODE(turn), 'succeeded', {
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        credits: r.credits,
        phase: 'propose',
      });
      await ctx.emit('agent_turn', { turn, phase: 'propose', toolCalls: 0 });
      if (!parsed.ok || problems.length > 0) {
        await this.validateStep(ctx, 'failed', problems);
        await ctx.emit('agent_validation', { ok: false, problems: problems.length });
        cp.counters.repairs += 1;
        if (cp.counters.repairs > this.limits.maxRepairs)
          return this.fallback(ctx, cp, 'invalid_proposal');
        cp.messages.push({ role: 'user', content: proposalFeedback(problems) });
        await ctx.save({ agent: cp }, NODE(turn));
        continue;
      }
      await this.validateStep(ctx, 'succeeded', []);
      await ctx.emit('agent_validation', { ok: true, problems: 0 });
      await ctx.save({ agent: cp }, 'validated');
      return this.apply(ctx, prep, cp, parsed.proposal);
    }
  }

  /** Apply (the only change the loop ever makes): through the same safe-change path as the single call, on the AI branch, once. */
  private async apply(
    ctx: RunContext,
    prep: Prepared,
    cp: AgentCheckpoint,
    proposal: Proposal,
  ): Promise<void> {
    if (await ctx.cancelled()) return this.cancelled(ctx, cp);
    const stepId = await this.stepBegin(ctx, SEQ_APPLY, 'apply', 'apply');
    let applied: { versionId: string; commit: string; branch: string };
    try {
      applied = await this.adapt.applyProposal(ctx, prep, proposal);
    } catch (e) {
      await this.stepEnd(ctx, stepId, 'apply', 'failed', {
        errorCode: e instanceof ProblemException ? e.code : 'internal_error',
      });
      throw e;
    }
    await this.stepEnd(ctx, stepId, 'apply', 'succeeded', {});
    await ctx.emit('agent_applied', {
      versionId: applied.versionId,
      patches: proposal.patches.length,
      turns: cp.counters.turns,
      toolCalls: cp.counters.toolCalls,
    });
    await this.audit.record({
      action: 'ai.agent.run_finished',
      orgId: ctx.orgId,
      actorType: 'system',
      resource: { type: 'ai_run', id: ctx.run.id },
      outcome: 'success',
      detail: {
        turns: cp.counters.turns,
        toolCalls: cp.counters.toolCalls,
        tokens: cp.counters.tokens,
        patches: proposal.patches.length,
      },
    });
    return ctx.succeed({
      outcome: 'adapted',
      mode: prep.mode,
      agentic: true,
      turns: cp.counters.turns,
      toolCalls: cp.counters.toolCalls,
      summary: proposal.summary.slice(0, 1000),
      patches: proposal.patches.length,
      ...applied,
      note: 'model quality and the result of building it are NOT VERIFIED',
    });
  }

  /** The safe fallback: hand over to the single-call adaptation (S-K6). Nothing was applied before this point, the same checks apply, and the budget is the same budget. */
  private async fallback(
    ctx: RunContext,
    cp: AgentCheckpoint,
    reason: FallbackReason,
  ): Promise<void> {
    if (ctx.checkpoint.applied)
      throw new ProblemException('conflict', 'the change was already applied'); // unreachable by construction; refuse rather than apply twice
    cp.fellBack = reason;
    const stepId = await this.stepBegin(ctx, SEQ_FALLBACK, 'fallback', 'fallback');
    await this.stepEnd(ctx, stepId, 'fallback', 'succeeded', { outputRef: reason });
    await ctx.save({ agent: cp }, 'agent_fallback');
    await ctx.emit('agent_fallback', {
      reason,
      turns: cp.counters.turns,
      toolCalls: cp.counters.toolCalls,
    });
    await this.audit.record({
      action: 'ai.agent.fallback',
      orgId: ctx.orgId,
      actorType: 'system',
      resource: { type: 'ai_run', id: ctx.run.id },
      outcome: 'success',
      detail: { reason, turns: cp.counters.turns, toolCalls: cp.counters.toolCalls },
    });
    return this.adapt.run(ctx);
  }

  private async cancelled(ctx: RunContext, cp: AgentCheckpoint): Promise<never> {
    await ctx.emit('agent_stopped', { reason: 'cancelled', turns: cp.counters.turns });
    await this.audit.record({
      action: 'ai.agent.run_failed',
      orgId: ctx.orgId,
      actorType: 'system',
      resource: { type: 'ai_run', id: ctx.run.id },
      outcome: 'failure',
      detail: { code: 'cancelled', turns: cp.counters.turns, toolCalls: cp.counters.toolCalls },
    });
    throw new ProblemException('conflict', 'cancelled');
  }

  /** Polls the run for a cancel request while a model call is in flight, and aborts the call (the gateway then releases the reservation and charges nothing). */
  private async withCancelPoll<T>(
    ctx: RunContext,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ac = new AbortController();
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        await new Promise((res) => setTimeout(res, 500));
        if (!stopped && (await ctx.cancelled().catch(() => false))) ac.abort();
      }
    };
    void poll();
    try {
      return await fn(ac.signal);
    } finally {
      stopped = true;
    }
  }

  // ---- persistent steps: one per model turn, one for validation, one for apply, one for a fallback (append-only history) ----------------------------------------------------------
  private async stepAttempt(ctx: RunContext, stepId: string): Promise<number> {
    return this.db.withOrg(ctx.orgId, async (c) =>
      Number(
        (await c.query(`SELECT attempt FROM ai.run_steps WHERE id = $1`, [stepId])).rows[0]!
          .attempt,
      ),
    );
  }

  private async stepBegin(
    ctx: RunContext,
    seq: number,
    node: string,
    phase: LoopPhase,
  ): Promise<string> {
    return this.db.withOrg(ctx.orgId, async (c) => {
      const existing = (
        await c.query(`SELECT id, status FROM ai.run_steps WHERE run_id = $1 AND node = $2`, [
          ctx.run.id,
          node,
        ])
      ).rows[0] as { id: string; status: string } | undefined;
      if (existing) {
        // a step that failed and is being tried again (a resumed run) is revived with a higher attempt; a finished one is left as it is
        if (existing.status === 'failed')
          await c.query(
            `UPDATE ai.run_steps SET status = 'running', attempt = attempt + 1, error_code = NULL, finished_at = NULL WHERE id = $1`,
            [existing.id],
          );
        return existing.id;
      }
      const id = uuidv7();
      await c.query(
        `INSERT INTO ai.run_steps (id, org_id, run_id, seq, node, agent, status, input_ref, data_region, started_at)
         VALUES ($1, $2, $3, $4, $5, 'agent', 'running', $6, $7, now())`,
        [id, ctx.orgId, ctx.run.id, seq, node, phase, ctx.run.dataRegion],
      );
      return id;
    });
  }

  private async stepEnd(
    ctx: RunContext,
    stepId: string,
    node: string,
    status: 'succeeded' | 'failed',
    o: {
      tokensIn?: number;
      tokensOut?: number;
      credits?: bigint;
      errorCode?: string;
      phase?: LoopPhase;
      outputRef?: string;
    },
  ): Promise<void> {
    await this.db.withOrg(ctx.orgId, async (c) => {
      await c.query(
        `UPDATE ai.run_steps SET status = $2, checkpoint_ref = $3, tokens_in = $4, tokens_out = $5, error_code = $6, input_ref = coalesce($7, input_ref), output_ref = $8, finished_at = now()
          WHERE id = $1 AND status IN ('pending', 'running')`,
        [
          stepId,
          status,
          status === 'succeeded' ? `agent:${node}` : null,
          o.tokensIn ?? 0,
          o.tokensOut ?? 0,
          o.errorCode ? o.errorCode.slice(0, 60) : null,
          o.phase ?? null,
          o.outputRef ?? null,
        ],
      );
    });
  }

  private async validateStep(
    ctx: RunContext,
    status: 'succeeded' | 'failed',
    problems: readonly string[],
  ): Promise<void> {
    // one step per attempt: a repair writes `validate`, `validate-2`, ... (the unique node name of a run)
    const n = await this.db.withOrg(ctx.orgId, async (c) =>
      Number(
        (
          await c.query(
            `SELECT count(*)::int n FROM ai.run_steps WHERE run_id = $1 AND node LIKE 'validate%'`,
            [ctx.run.id],
          )
        ).rows[0]!.n,
      ),
    );
    const node = n === 0 ? 'validate' : `validate-${n + 1}`;
    const id = await this.stepBegin(ctx, SEQ_VALIDATE + n, node, 'validate');
    await this.stepEnd(ctx, id, node, status, {
      ...(status === 'failed' ? { errorCode: 'invalid_proposal' } : {}),
      outputRef: status === 'failed' ? `${problems.length} problems` : undefined,
    });
  }
}
