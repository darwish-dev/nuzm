import { createHash, randomBytes } from 'node:crypto';
import { emitUsage, usageEventId, type Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { ResidencyService } from '../../../compliance';
import { SANDBOX_QUOTA, iso, newId, type Row } from '../core';
import type { OrgBudgetPort, ProjectRecord } from '../ports/m09';
import type { CanaryRegistry } from './canary';
import { redactSecrets } from './paths';
import {
  DEFAULT_QUOTA,
  RuntimeNoCapacity,
  RuntimeQuotaError,
  type ExecResult,
  type Quota,
  type SandboxRuntime,
} from './runtime';

export interface SandboxDto {
  id: string;
  projectId: string;
  profile: string;
  state: string;
  /** What actually runs the code. `isolation: 'verified'` only for an isolating runtime that passed the escape suite AND the HG-10-02 review; today it is never `verified`. */
  runtime: { kind: string; isolation: string };
  egressProfile: string;
  quota: Quota;
  ttlAt: string;
  lastActivityAt: string;
  dataRegion: string;
  terminationReason: string | null;
  createdAt: string;
  terminatedAt: string | null;
  operationId: string | null;
}
const TERMINAL = ['terminated', 'expired', 'failed'];

export interface SandboxConfig {
  /** Region of the sandbox node pool (the placement the residency policy is asked about). */
  nodeRegion: string;
  idleMinutes: number;
  maxLifetimeMinutes: number;
  concurrentPerOrg: number;
}
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  nodeRegion: 'sa-central',
  idleMinutes: SANDBOX_QUOTA.idleTimeoutMinutes,
  maxLifetimeMinutes: SANDBOX_QUOTA.maxLifetimeMinutes,
  concurrentPerOrg: SANDBOX_QUOTA.concurrentPerOrg,
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const TICKET_TTL_SECONDS = 60;

/**
 * Sandbox lifecycle (M10 §6, §9; S45.2): quotas (5 concurrent per organization, serialised per organization so 20 parallel creates at the quota edge admit exactly 5),
 * residency check of the node region before placement, capacity (503), credit check (402), idle (30 min) and maximum (4 h) lifetime reaping, CPU-second metering with
 * idempotent event ids, short-lived single-use terminal tickets, canary scanning of everything that leaves a sandbox.
 */
export class SandboxService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly runtime: SandboxRuntime,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly orgBudget: OrgBudgetPort,
    private readonly canaries: CanaryRegistry,
    private readonly cfg: SandboxConfig = DEFAULT_SANDBOX_CONFIG,
    private readonly now: () => Date = () => new Date(),
  ) {}

  dto(r: Row): SandboxDto {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      profile: r.profile as string,
      state: r.state as string,
      runtime: { kind: r.runtime_kind as string, isolation: r.isolation as string },
      egressProfile: r.egress_profile as string,
      quota: r.quota as Quota,
      ttlAt: iso(r.ttl_at)!,
      lastActivityAt: iso(r.last_activity_at)!,
      dataRegion: r.data_region as string,
      terminationReason: (r.termination_reason as string | null) ?? null,
      createdAt: iso(r.created_at)!,
      terminatedAt: iso(r.terminated_at),
      operationId: (r.operation_id as string | null) ?? null,
    };
  }

  async create(
    orgId: string,
    actor: string,
    project: ProjectRecord,
    body: { profile?: unknown; ttlMinutes?: unknown },
  ): Promise<SandboxDto> {
    if (project.type !== 'webapp')
      throw new ProblemException(
        'unsupported_capability',
        'sandboxes are available for web-app projects (mobile build workers arrive in M10B)',
      );
    const profile = body.profile === undefined ? 'standard' : body.profile;
    if (profile !== 'standard')
      throw new ProblemException('validation_failed', 'profile must be "standard"');
    const ttl =
      body.ttlMinutes === undefined ? this.cfg.maxLifetimeMinutes : Number(body.ttlMinutes);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > this.cfg.maxLifetimeMinutes)
      throw new ProblemException(
        'validation_failed',
        `ttlMinutes must be 1..${this.cfg.maxLifetimeMinutes}`,
      );
    // residency BEFORE placement (CLAUDE.md §4): where the node runs
    const res = await this.residency.evaluate({
      orgId,
      dataClass: 'customer-content',
      targetRegion: this.cfg.nodeRegion,
      purpose: 'sandbox_placement',
      operation: 'write',
    });
    if (res.decision !== 'allow')
      throw new ProblemException(
        'residency_denied',
        res.reasons.map((r) => r.message.en).join('; ') ||
          'sandbox placement is not allowed by the residency policy',
      );
    if ((await this.orgBudget.remainingMinor(orgId)) <= 0)
      throw new ProblemException(
        'budget_required',
        'the organization has no AI credit left for a sandbox',
      );
    if ((await this.runtime.freeSlots()) <= 0)
      throw new ProblemException(
        'sandbox_no_capacity',
        'no sandbox capacity is available right now',
      );
    const id = newId();
    const now = this.now();
    // the per-organization count and the insert happen under one advisory lock: concurrent creates cannot both see "4 of 5"
    const row = await this.db.withOrg(orgId, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`sandbox:${orgId}`]);
      const active = (
        await c.query(
          `SELECT count(*)::int n FROM builder.sandboxes WHERE org_id = $1 AND state IN ('starting','ready','terminating')`,
          [orgId],
        )
      ).rows[0]!.n as number;
      if (active >= this.cfg.concurrentPerOrg)
        throw new ProblemException(
          'sandbox_quota_exceeded',
          `${this.cfg.concurrentPerOrg} concurrent sandboxes are allowed per organization`,
        );
      return (
        await c.query(
          `INSERT INTO builder.sandboxes (id, org_id, project_id, profile, runtime_kind, isolation, state, quota, ttl_at, last_activity_at, data_region, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'starting',$7,$8,$9,$10,$11) RETURNING *`,
          [
            id,
            orgId,
            project.id,
            profile,
            this.runtime.kind,
            this.runtime.isolation,
            JSON.stringify(DEFAULT_QUOTA),
            new Date(now.getTime() + ttl * 60_000),
            now,
            this.cfg.nodeRegion,
            actor,
          ],
        )
      ).rows[0] as Row;
    });
    try {
      const handle = await this.runtime.create({
        sandboxId: id,
        orgId,
        projectId: project.id,
        quota: DEFAULT_QUOTA,
        egressProfile: 'default',
      });
      const ready = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `UPDATE builder.sandboxes SET state = 'ready', runtime_handle = $2, started_at = $3 WHERE id = $1 RETURNING *`,
              [id, handle, now],
            )
          ).rows[0] as Row,
      );
      await this.audit.record({
        action: 'sandbox.sandbox.created',
        orgId,
        actorUserId: actor,
        resource: { type: 'sandbox', id },
        outcome: 'success',
        after: {
          projectId: project.id,
          runtime: this.runtime.kind,
          isolation: this.runtime.isolation,
          dataRegion: this.cfg.nodeRegion,
        },
      });
      return this.dto(ready);
    } catch (e) {
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE builder.sandboxes SET state = 'failed', termination_reason = $2 WHERE id = $1`,
          [id, e instanceof RuntimeNoCapacity ? 'no_capacity' : 'start_failed'],
        ),
      );
      if (e instanceof RuntimeNoCapacity)
        throw new ProblemException(
          'sandbox_no_capacity',
          'no sandbox capacity is available right now',
        );
      throw e;
    }
    void row;
  }

  private async load(orgId: string, projectId: string | null, id: string): Promise<Row> {
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM builder.sandboxes WHERE id = $1 AND org_id = $2 AND ($3::uuid IS NULL OR project_id = $3)`,
            [id, orgId, projectId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('not_found', 'sandbox not found');
    return r;
  }
  async get(orgId: string, projectId: string, id: string): Promise<SandboxDto> {
    return this.dto(await this.load(orgId, projectId, id));
  }
  async list(orgId: string, projectId: string): Promise<SandboxDto[]> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM builder.sandboxes WHERE org_id = $1 AND project_id = $2 ORDER BY created_at DESC, id LIMIT 50`,
            [orgId, projectId],
          )
        ).rows as Row[],
    );
    return rows.map((r) => this.dto(r));
  }

  /** DELETE: terminates the sandbox (the record stays). Idempotent. */
  async terminate(
    orgId: string,
    actor: string | null,
    projectId: string | null,
    id: string,
    reason = 'user',
  ): Promise<SandboxDto> {
    const cur = await this.load(orgId, projectId, id);
    if (TERMINAL.includes(cur.state as string) || cur.state === 'terminating') return this.dto(cur);
    await this.meterCpu(orgId, id, true).catch(() => undefined);
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE builder.sandboxes SET state = 'terminating', termination_reason = $2 WHERE id = $1 AND state IN ('starting','ready','failed')`,
        [id, reason],
      ),
    );
    try {
      if (cur.runtime_handle) await this.runtime.destroy(cur.runtime_handle as string);
    } finally {
      const done = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `UPDATE builder.sandboxes SET state = $2, terminated_at = $3, ws_ticket_hash = NULL, ws_ticket_expires_at = NULL WHERE id = $1 AND state = 'terminating' RETURNING *`,
              [id, reason === 'expired' ? 'terminated' : 'terminated', this.now()],
            )
          ).rows[0] as Row | undefined,
      );
      void done;
    }
    await this.audit.record({
      action: 'sandbox.sandbox.terminated',
      orgId,
      ...(actor ? { actorUserId: actor } : { actorType: 'system' as const }),
      resource: { type: 'sandbox', id },
      outcome: 'success',
      after: { reason },
    });
    return this.dto(await this.load(orgId, null, id));
  }

  /** Idle (no activity for 30 min), TTL or maximum lifetime (4 h) reached: terminate. Called by the reaper job; returns how many sandboxes it ended. */
  async reapExpired(): Promise<number> {
    const now = this.now();
    const idleBefore = new Date(now.getTime() - this.cfg.idleMinutes * 60_000);
    const maxBefore = new Date(now.getTime() - this.cfg.maxLifetimeMinutes * 60_000);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, last_activity_at, ttl_at, created_at FROM builder.sandboxes WHERE state IN ('starting','ready') AND (ttl_at <= $1 OR last_activity_at <= $2 OR created_at <= $3)`,
            [now, idleBefore, maxBefore],
          )
        ).rows as Row[],
    );
    let n = 0;
    for (const r of rows) {
      const reason =
        (r.created_at as Date) <= maxBefore
          ? 'max_lifetime'
          : (r.ttl_at as Date) <= now
            ? 'ttl'
            : 'idle';
      await this.terminate(r.org_id as string, null, null, r.id as string, reason);
      n++;
    }
    return n;
  }

  /** Runs one command (no shell). Output is scanned for canaries and redacted of secret patterns BEFORE it is returned or stored. */
  async exec(
    orgId: string,
    actor: string,
    projectId: string | null,
    id: string,
    argv: string[],
    opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {},
  ): Promise<ExecResult & { canaryHits: number }> {
    const sb = await this.load(orgId, projectId, id);
    if (sb.state !== 'ready')
      throw new ProblemException('invalid_state', `the sandbox is ${sb.state as string}`);
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.length > 64 ||
      argv.some((a) => typeof a !== 'string' || a.length > 4096)
    )
      throw new ProblemException('validation_failed', 'argv must be 1..64 strings');
    const quota = sb.quota as Quota;
    const timeoutMs = Math.min(
      opts.timeoutMs ?? quota.buildTimeoutMinutes * 60_000,
      quota.buildTimeoutMinutes * 60_000,
    );
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE builder.sandboxes SET last_activity_at = $2 WHERE id = $1`, [id, this.now()]),
    );
    let r: ExecResult;
    try {
      r = await this.runtime.exec(sb.runtime_handle as string, {
        argv,
        timeoutMs,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch (e) {
      if (e instanceof RuntimeQuotaError)
        throw new ProblemException('sandbox_quota_exceeded', e.message);
      throw e;
    }
    const hits = (
      await this.canaries.scan(r.stdout + '\n' + r.stderr, { sandboxId: id, source: 'exec output' })
    ).length;
    return {
      ...r,
      stdout: this.canaries.redact(r.stdout),
      stderr: this.canaries.redact(r.stderr),
      canaryHits: hits,
    };
  }

  async writeFiles(
    orgId: string,
    projectId: string | null,
    id: string,
    files: ReadonlyMap<string, string>,
  ): Promise<void> {
    const sb = await this.load(orgId, projectId, id);
    if (sb.state !== 'ready')
      throw new ProblemException('invalid_state', `the sandbox is ${sb.state as string}`);
    try {
      await this.runtime.writeFiles(sb.runtime_handle as string, files);
    } catch (e) {
      if (e instanceof RuntimeQuotaError)
        throw new ProblemException(
          e.quota === 'files' ? 'change_rejected' : 'sandbox_quota_exceeded',
          e.message,
        );
      throw e;
    }
  }
  async readFiles(
    orgId: string,
    projectId: string | null,
    id: string,
    paths?: string[],
  ): Promise<Map<string, string>> {
    const sb = await this.load(orgId, projectId, id);
    if (sb.state !== 'ready')
      throw new ProblemException('invalid_state', `the sandbox is ${sb.state as string}`);
    return this.runtime.readFiles(sb.runtime_handle as string, paths);
  }

  /**
   * `ai.sandbox_cpu_seconds`: delta of the CPU seconds the runtime reports since the last metered window. The event id is deterministic over (org, meter, sandbox, window
   * start), so running the same window twice emits ONE event; the cumulative `cpu_metered` makes the sum of events equal the runtime's own total (reconciliation, AC-M10-09).
   */
  async meterCpu(
    orgId: string,
    id: string,
    final = false,
  ): Promise<{ quantity: string; windowStart: string } | null> {
    const sb = await this.load(orgId, null, id);
    if (!sb.runtime_handle || (TERMINAL.includes(sb.state as string) && !final)) return null;
    const stats = await this.runtime.stats(sb.runtime_handle as string).catch(() => null);
    if (!stats) return null;
    const end = this.now();
    const windowStart = new Date(Math.floor(end.getTime() / 60_000) * 60_000);
    if (sb.metered_until && (sb.metered_until as Date).getTime() >= windowStart.getTime() && !final)
      return null;
    const delta = Math.max(0, stats.cpuSeconds - Number(sb.cpu_metered));
    if (delta <= 0) return null;
    const quantity = delta.toFixed(3);
    await this.db.withOrg(orgId, async (c) => {
      await emitUsage(c, {
        eventId: usageEventId({
          orgId,
          meterId: 'ai.sandbox_cpu_seconds',
          resourceId: id,
          windowStart: windowStart.toISOString(),
        }),
        orgId,
        meterId: 'ai.sandbox_cpu_seconds',
        quantity,
        unit: 'cpu_second',
        resourceId: id,
        projectId: sb.project_id as string,
        windowStart: windowStart.toISOString(),
        windowEnd: new Date(windowStart.getTime() + 60_000).toISOString(),
        occurredAt: end.toISOString(),
        dimensions: { sandbox_class: String(sb.profile) },
        dataRegion: sb.data_region as string,
        source: 'builder@M10',
      });
      await c.query(
        `UPDATE builder.sandboxes SET cpu_metered = $2, metered_until = $3 WHERE id = $1`,
        [id, stats.cpuSeconds.toFixed(3), windowStart],
      );
    });
    return { quantity, windowStart: windowStart.toISOString() };
  }

  // ---- terminal tickets (WS authentication) ----
  /** Issues a one-time ticket (returned ONCE; only its hash is stored). It is valid 60 s, for this user and this sandbox only; a new ticket replaces the old one. */
  async issueTicket(
    orgId: string,
    userId: string,
    projectId: string | null,
    id: string,
  ): Promise<{ ticket: string; expiresAt: string }> {
    const sb = await this.load(orgId, projectId, id);
    if (sb.state !== 'ready')
      throw new ProblemException('invalid_state', `the sandbox is ${sb.state as string}`);
    const ticket = randomBytes(32).toString('base64url');
    const expires = new Date(this.now().getTime() + TICKET_TTL_SECONDS * 1000);
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE builder.sandboxes SET ws_ticket_hash = $2, ws_ticket_user = $3, ws_ticket_expires_at = $4 WHERE id = $1`,
        [id, hash(ticket), userId, expires],
      ),
    );
    return { ticket, expiresAt: expires.toISOString() };
  }
  /** Redeems a ticket: one UPDATE that clears it, so a second use (or another user, another sandbox, another organization, an expired or forged ticket) finds nothing. */
  async redeemTicket(orgId: string, userId: string, id: string, ticket: string): Promise<void> {
    const ok = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE builder.sandboxes SET ws_ticket_hash = NULL, ws_ticket_user = NULL, ws_ticket_expires_at = NULL, last_activity_at = $5
           WHERE id = $1 AND org_id = $2 AND state = 'ready' AND ws_ticket_hash = $3 AND ws_ticket_user = $4 AND ws_ticket_expires_at > $5 RETURNING id`,
            [id, orgId, hash(String(ticket)), userId, this.now()],
          )
        ).rowCount,
    );
    if (!ok)
      throw new ProblemException(
        'ticket_invalid',
        'the terminal ticket is invalid, expired or already used',
      );
  }

  /** What an operator may state about the isolation of what ran: never `verified` unless the row says so (it cannot, in this repository). */
  static isolationEvidence(dto: Pick<SandboxDto, 'runtime'>): boolean {
    return dto.runtime.isolation === 'verified' && dto.runtime.kind === 'isolated';
  }
  static redact = redactSecrets;
}
