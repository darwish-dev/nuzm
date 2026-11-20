import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { newId } from '../core';
import { flagOn } from '../flag.guard';
import type { ProjectRecord } from '../ports/m09';
import type { SandboxService } from '../sandbox/sandbox.service';
import { CLAUDE_CODE_FLAG, claudeCodeComplianceApproved } from './flag';

type Row = Record<string, unknown>;
export type ClaudeCodeState =
  | 'NOT_CONFIGURED'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATING'
  | 'READY'
  | 'AUTHENTICATION_EXPIRED'
  | 'ERROR'
  | 'STOPPED';
const VERSION_RE = /^[0-9A-Za-z .()+-]{1,60}$/;

/**
 * Claude Code in a project sandbox — PROOF OF CONCEPT ONLY (ADR-064 point 4, D-38 partly decided). What this does and does not do:
 *  - it checks that the UNMODIFIED `claude` binary is present in the sandbox (`claude --version`) and records only states it can observe;
 *  - it never asks for, receives, stores, forwards or logs Claude credentials, tokens or cookies; sign-in would be done by the customer
 *    themselves inside the sandbox terminal, which stays hidden until PA-M10-01 is approved — so a session stops at AUTHENTICATION_REQUIRED;
 *  - it never falls back to the platform's billable API (managed coding goes through the existing AI gateway, a separate, metered path);
 *  - behind `ai.claude_code_sandbox` (default OFF), and in production additionally behind the recorded compliance approval (D-38 open → refused).
 */
export class ClaudeCodeService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly sandboxes: Pick<SandboxService, 'get' | 'exec'>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private dto(r: Row | undefined) {
    return r
      ? {
          id: r.id as string,
          sandboxId: r.sandbox_id as string,
          state: r.state as ClaudeCodeState,
          binaryVersion: (r.binary_version as string | null) ?? null,
          errorCode: (r.error_code as string | null) ?? null,
          createdAt: new Date(r.created_at as string).toISOString(),
          updatedAt: new Date(r.updated_at as string).toISOString(),
        }
      : null;
  }
  private async gate(orgId: string) {
    const enabled = await flagOn(this.db, orgId, CLAUDE_CODE_FLAG);
    const compliance = claudeCodeComplianceApproved(this.env);
    return { enabled, compliance, allowed: enabled && compliance };
  }
  private async latest(orgId: string, projectId: string) {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM builder.claude_code_sessions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [projectId],
          )
        ).rows[0] as Row | undefined,
    );
  }

  async status(orgId: string, p: ProjectRecord) {
    const g = await this.gate(orgId);
    return {
      enabled: g.enabled,
      complianceApproved: g.compliance,
      available: g.allowed,
      /** why the button is off, for the UI */
      reason: !g.enabled ? 'flag_off' : !g.compliance ? 'compliance_pending' : null,
      credentialsStoredByNuzm: false,
      billableFallback: false,
      session: this.dto(await this.latest(orgId, p.id)),
    };
  }

  /** Starts a session in a READY sandbox of the project: probes for the binary and reports what it found. */
  async start(orgId: string, actor: string, p: ProjectRecord, body: Row) {
    const g = await this.gate(orgId);
    if (!g.enabled)
      throw new ProblemException(
        'feature_disabled',
        'the Claude Code proof of concept is not enabled for this organization',
      );
    if (!g.compliance)
      throw new ProblemException(
        'feature_disabled',
        'Claude Code with customer subscriptions awaits the legal and provider-compliance review (D-38)',
      );
    const sid = typeof body.sandboxId === 'string' ? body.sandboxId.toLowerCase() : '';
    if (!/^[0-9a-f-]{36}$/.test(sid))
      throw new ProblemException('validation_failed', 'sandboxId is required');
    const sb = await this.sandboxes.get(orgId, p.id, sid);
    if (sb.state !== 'ready')
      throw new ProblemException('invalid_state', `the sandbox is ${sb.state}`);

    let state: ClaudeCodeState;
    let version: string | null = null;
    let error: string | null = null;
    try {
      const r = await this.sandboxes.exec(orgId, actor, p.id, sid, ['claude', '--version'], {
        timeoutMs: 15_000,
      });
      const first = r.stdout.trim().split('\n')[0]?.trim() ?? '';
      if (r.exitCode === 127) {
        state = 'NOT_CONFIGURED';
        error = 'binary_missing';
      } else if (r.exitCode !== 0 || r.timedOut) {
        state = 'ERROR';
        error = r.timedOut ? 'probe_timeout' : 'probe_failed';
      } else {
        // the binary is there; whether the customer is signed in is not observable from here without the terminal (PA-M10-01)
        state = 'AUTHENTICATION_REQUIRED';
        version = VERSION_RE.test(first) ? first : null;
      }
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      state = 'ERROR';
      error = 'probe_failed';
    }
    const row = await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE builder.claude_code_sessions SET state = 'STOPPED', updated_at = now() WHERE project_id = $1 AND state <> 'STOPPED'`,
        [p.id],
      );
      return (
        await c.query(
          `INSERT INTO builder.claude_code_sessions (id, org_id, project_id, sandbox_id, state, binary_version, error_code, started_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [newId(), orgId, p.id, sid, state, version, error, actor],
        )
      ).rows[0] as Row;
    });
    await this.audit.record({
      action: 'builder.claude_code.started',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: p.id },
      outcome: 'success',
      detail: { sandboxId: sid, state, ...(error ? { error } : {}) },
    });
    return this.dto(row);
  }

  async stop(orgId: string, actor: string, p: ProjectRecord) {
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE builder.claude_code_sessions SET state = 'STOPPED', updated_at = now() WHERE project_id = $1 AND state <> 'STOPPED' RETURNING *`,
            [p.id],
          )
        ).rows as Row[],
    );
    if (!r.length) throw new ProblemException('not_found', 'no active Claude Code session');
    await this.audit.record({
      action: 'builder.claude_code.stopped',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: p.id },
      outcome: 'success',
    });
    return this.dto(r[0]);
  }
}
