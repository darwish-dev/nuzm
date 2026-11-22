import { createHash } from 'node:crypto';
import type { ContentBlock, ToolSpec } from '@nuzm/adapter-model';
import {
  AGENT_TOOL_LIMITS as LIM,
  READ_TOOL_NAMES,
  READ_TOOL_SPECS,
  executeReadTool,
  renderToolResult,
  scanForSecrets,
  type ToolErrorCode,
} from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { permissionCovers } from '../../identity';
import type { PolicyService } from '../../access';
import type { AgentWorkspaceRegistry } from './agent-workspace';
import type { AiFlags } from './flags';
import type { AiConfig } from './model';

/** Run kinds that may use agent tools, and which tools each may use. Today only the app builder's `webapp` kind (the template adaptation, S-K6) and only the read-only tools. */
const ALLOWED: Record<string, readonly string[]> = { webapp: READ_TOOL_NAMES };
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'budget_exceeded']);
/** Calls one model response may carry (the adapter contract's ceiling). */
const MAX_BATCH = 16;
/** Below this much of the per-run size budget a call is refused before it is executed. */
const MIN_RESULT_BUDGET = 2_000;
const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

export interface ToolCallContext {
  orgId: string;
  runId: string;
  /** the run step this batch belongs to (`ai.run_steps`): created by the caller, one per model turn */
  stepId: string;
}
export interface RequestedToolCall {
  id: string;
  name: string;
  args: unknown;
}
export interface ToolOutcome {
  callId: string;
  tool: string;
  status: 'succeeded' | 'failed' | 'denied';
  /** a fixed code (never a message); absent on success */
  errorCode?: string;
  resultBytes: number;
}
export interface ToolBatch {
  /** the `tool_result` blocks to hand back to the model, in the order of the calls */
  blocks: ContentBlock[];
  outcomes: ToolOutcome[];
  /** a per-run limit was hit in this batch: the loop should stop offering tools */
  limitReached: 'calls' | 'bytes' | null;
}

/**
 * The Tool Execution Gateway for the read-only agent tools (D-46, ADR-066, SCR-K-10 §4). Every tool call of every agent run passes here, and nowhere else:
 *   flag `ai.agent.read_tools` (default off) and the kill switch → the run (this organization, not finished, a kind that may use tools) → the run creator's CURRENT permissions
 *   (`ai:write` and `builder:read` in an active organization) → a read-only snapshot of the run's OWN project (never one named by the caller or the model) → per call: the allow-list,
 *   the schema, the per-run limits, execution (pure, bounded), the secret scan of the RESULT, and an append-only record in `ai.tool_calls`.
 * It never executes anything but the pure read tools, never throws for a tool-level refusal (that is a result the model can read and correct), and never puts an argument, a path, a file or an
 * exception message in an audit row or a refusal. Execution tools do not exist here and cannot be registered (D-21).
 */
export class AgentToolGateway {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly flags: AiFlags,
    private readonly policy: PolicyService,
    private readonly workspaces: AgentWorkspaceRegistry,
    private readonly cfg: AiConfig,
  ) {}

  /** The tools a loop may offer the model for a run kind in this organization: none while the flag is off, the kill switch is on, or the kind may not use tools. */
  async specs(orgId: string, runKind: string): Promise<ToolSpec[]> {
    const names = ALLOWED[runKind];
    if (
      !names ||
      !(await this.flags.enabled(orgId)) ||
      (await this.flags.killSwitch(orgId)) ||
      !(await this.flags.readTools(orgId))
    )
      return [];
    return READ_TOOL_SPECS.filter((s) => names.includes(s.name)).map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.inputSchema as unknown as Record<string, unknown>,
    }));
  }

  async execute(ctx: ToolCallContext, calls: readonly RequestedToolCall[]): Promise<ToolBatch> {
    const { orgId, runId } = ctx;
    if (!(await this.flags.enabled(orgId)) || !(await this.flags.readTools(orgId)))
      throw new ProblemException(
        'unsupported_capability',
        'agent read tools are not enabled for this organization',
      );
    if (await this.flags.killSwitch(orgId))
      throw new ProblemException('ai_unavailable', 'AI is switched off by the kill switch');
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_BATCH)
      throw new ProblemException('validation_failed', `a batch has 1..${MAX_BATCH} tool calls`);

    // the run: this organization's (row-level security), not finished, of a kind that may use tools
    const run = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, project_id, kind, state, created_by, data_region FROM ai.runs WHERE id = $1`,
            [runId],
          )
        ).rows[0] as
          | {
              id: string;
              project_id: string | null;
              kind: string;
              state: string;
              created_by: string | null;
              data_region: string;
            }
          | undefined,
    );
    if (!run) throw new ProblemException('not_found', 'run not found');
    if (TERMINAL.has(run.state)) throw new ProblemException('conflict', 'the run has finished');
    const allowed = ALLOWED[run.kind];
    if (!allowed || !run.project_id)
      throw new ProblemException('unsupported_capability', 'this run kind cannot use agent tools');

    // the creator's permissions NOW (a role change takes effect on the next call)
    const member = run.created_by ? await this.policy.membership(run.created_by, orgId) : null;
    if (
      !member ||
      member.orgStatus !== 'active' ||
      !permissionCovers(member.permissions, 'ai:write') ||
      !permissionCovers(member.permissions, 'builder:read')
    )
      throw new ProblemException(
        'forbidden',
        'the run creator may not use agent tools in this organization',
      );

    const step = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT 1 FROM ai.run_steps WHERE id = $1 AND run_id = $2`, [
            ctx.stepId,
            runId,
          ])
        ).rows[0],
    );
    if (!step) throw new ProblemException('not_found', 'run step not found');

    const provider = this.workspaces.get(run.kind);
    const ws = provider ? await provider.open(orgId, run.project_id) : null;
    if (!ws) throw new ProblemException('not_found', 'project not found');

    const used = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int AS calls, coalesce(sum(result_bytes), 0)::bigint AS bytes FROM ai.tool_calls WHERE run_id = $1 AND call_id IS NOT NULL`,
            [runId],
          )
        ).rows[0] as { calls: number; bytes: string },
    );
    let calls0 = used.calls;
    let bytes0 = Number(used.bytes);
    const blocks: ContentBlock[] = [];
    const outcomes: ToolOutcome[] = [];
    let limitReached: ToolBatch['limitReached'] = null;

    for (const call of calls) {
      const started = Date.now();
      const finish = async (o: { status: ToolOutcome['status']; text: string; code?: string }) => {
        const resultBytes = Buffer.byteLength(o.text, 'utf8');
        blocks.push({
          type: 'tool_result',
          callId: call.id,
          content: o.text,
          ...(o.status === 'succeeded' ? {} : { isError: true }),
        });
        outcomes.push({
          callId: call.id,
          tool: String(call.name).slice(0, 60),
          status: o.status,
          ...(o.code ? { errorCode: o.code } : {}),
          resultBytes,
        });
        await this.record(
          orgId,
          runId,
          ctx.stepId,
          run.data_region,
          call,
          o.status,
          o.code,
          resultBytes,
          Date.now() - started,
        );
        calls0 += 1;
        bytes0 += resultBytes;
      };
      const refuse = (code: string, message: string) => JSON.stringify({ error: code, message });

      if (calls0 >= LIM.maxCallsPerRun) {
        limitReached = 'calls';
        await finish({
          status: 'denied',
          code: 'limit_exceeded',
          text: refuse('limit_exceeded', 'the tool-call limit of this run was reached'),
        });
        continue;
      }
      // too little of the per-run size budget is left for any useful result: the run has used it up (the loop should wrap up, not keep asking)
      if (LIM.maxResultBytesPerRun - bytes0 < MIN_RESULT_BUDGET) {
        limitReached = limitReached ?? 'bytes';
        await finish({
          status: 'denied',
          code: 'budget_exhausted',
          text: refuse('budget_exhausted', 'the tool-result size limit of this run was reached'),
        });
        continue;
      }
      if (
        typeof call.id !== 'string' ||
        call.id.length < 1 ||
        call.id.length > 128 ||
        typeof call.name !== 'string' ||
        !allowed.includes(call.name)
      ) {
        await this.audit.record({
          action: 'ai.tool_call.denied',
          orgId,
          actorType: 'system',
          resource: { type: 'ai_run', id: runId },
          outcome: 'failure',
          detail: { tool: String(call.name).slice(0, 60), kind: run.kind },
        });
        await finish({
          status: 'denied',
          code: 'unknown_tool',
          text: refuse('unknown_tool', 'this tool is not available'),
        });
        continue;
      }

      const result = executeReadTool(call.name, call.args, ws);
      const cap = Math.min(
        LIM.maxResultBytesPerCall,
        Math.max(0, LIM.maxResultBytesPerRun - bytes0),
      );
      const rendered = renderToolResult(result, cap);
      if (rendered.isError && rendered.code === 'too_large' && cap < LIM.maxResultBytesPerCall) {
        // it did not fit in what is left of the run's size budget (not just the per-call limit): that is the run's limit
        limitReached = limitReached ?? 'bytes';
        await finish({
          status: 'denied',
          code: 'budget_exhausted',
          text: refuse('budget_exhausted', 'the tool-result size limit of this run was reached'),
        });
        continue;
      }
      let text = rendered.text;
      let code: string | undefined = rendered.isError
        ? (rendered.code as ToolErrorCode | undefined)
        : undefined;
      // the result is scanned like any outbound text: a secret that is somehow in a readable file is withheld, never sent
      const leaks = scanForSecrets(text, this.cfg.canaries);
      if (leaks.length) {
        const kinds = [...new Set(leaks.map((l) => l.kind))];
        await this.audit.record({
          action: 'ai.secret_scan.blocked',
          orgId,
          actorType: 'system',
          resource: { type: 'ai_run', id: runId },
          outcome: 'failure',
          detail: { kinds, where: 'tool_result', tool: call.name },
        });
        text = refuse('secret_detected', 'the result contained a secret pattern and was withheld');
        code = 'secret_detected';
      }
      await finish({ status: code ? 'failed' : 'succeeded', text, ...(code ? { code } : {}) });
    }
    return { blocks, outcomes, limitReached };
  }

  /** The append-only record of one call. Arguments are reduced to what is safe to keep: a validated path, numbers, a glob, and for a search only the length and a short hash of the query. */
  private async record(
    orgId: string,
    runId: string,
    stepId: string,
    region: string,
    call: RequestedToolCall,
    status: ToolOutcome['status'],
    errorCode: string | undefined,
    resultBytes: number,
    ms: number,
  ) {
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `INSERT INTO ai.tool_calls (id, org_id, run_id, step_id, tool, args_redacted, status, duration_ms, data_region, call_id, result_bytes, error_code)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (org_id, run_id, call_id) WHERE call_id IS NOT NULL DO NOTHING`,
        [
          orgId,
          runId,
          stepId,
          /^[a-z][a-z0-9_.-]{0,60}$/.test(String(call.name)) ? String(call.name) : 'invalid',
          JSON.stringify(redactArgs(String(call.name), call.args)),
          status,
          Math.max(0, Math.min(ms, 2_000_000_000)),
          region,
          String(call.id).slice(0, 128) || 'invalid',
          resultBytes,
          errorCode ?? null,
        ],
      );
    });
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
// eslint-disable-next-line no-control-regex -- a string with a control character is not kept
const CONTROL = /[\u0000-\u001f]/;
const shortStr = (v: unknown, max = 120) =>
  typeof v === 'string' && !CONTROL.test(v) ? v.slice(0, max) : undefined;
/** What may be kept of a model-proposed argument object. A free-text query is never stored: its length and a short hash are enough to tell two searches apart. */
export function redactArgs(tool: string, args: unknown): Record<string, unknown> {
  const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  if (tool === 'read_file') {
    set('path', shortStr(a.path, LIM.pathMaxChars));
    set('startLine', num(a.startLine));
    set('endLine', num(a.endLine));
  } else if (tool === 'list_files') {
    set('dir', shortStr(a.dir, LIM.pathMaxChars));
    set('glob', shortStr(a.glob, LIM.globMaxChars));
    set('limit', num(a.limit));
  } else if (tool === 'search_code') {
    if (typeof a.query === 'string') {
      set('queryLength', a.query.length);
      set('queryHash', sha12(a.query));
    }
    set('pathGlob', shortStr(a.pathGlob, LIM.globMaxChars));
    set('limit', num(a.limit));
    set('caseSensitive', typeof a.caseSensitive === 'boolean' ? a.caseSensitive : undefined);
  }
  return out;
}
