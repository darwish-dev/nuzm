import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import { executionGateway as eg } from '@nuzm/domain';

/**
 * P3-S02 DURABLE STORES for the real execution runtime (migrations 2310-2312; design: docs/security/sandbox/DURABLE-STORES-DESIGN.md). Everything here is behind the feature flag
 * (`ai.agent.exec_tools`, default off): nothing in the application constructs this store yet, and the in-memory components of the Execution Gateway stay the default until the Master wires
 * it (CONTRACT-P3-S02-2). The domain keeps the rules (`transitionJob`, `ApprovalWorkflow`, quota policy); this store makes their STATE survive a restart, and the database independently
 * enforces the same transition tables and single-use/append-only rules, so a bug in a worker cannot corrupt history.
 *
 * Tenant access always goes through `withOrg` (row level security enforced for the runtime role); platform records (nodes, attestations) and fleet-wide reads (the claim scan) go
 * through the platform scope, which is READ-ONLY on tenant tables: every tenant write happens inside that tenant's own scope.
 */
export interface NewJob {
  orgId: string;
  runId: string;
  idempotencyKey: string;
  profile: string;
  decisionDigest: string;
  origin: 'MOCK' | 'REAL';
  requiresApproval: boolean;
  dataRegion: string;
}
export interface JobRow extends NewJob {
  id: string;
  state: eg.JobState;
  approvalId: string | null;
  nodeId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  outcomeStatus: string | null;
  exitCode: number | null;
  durationMs: number | null;
  truncated: boolean | null;
  artifactCount: number;
}
export type TransitionOutcome = { ok: true; job: JobRow } | { ok: false; reason: string };
export interface ApprovalRow {
  id: string;
  orgId: string;
  jobId: string;
  decisionDigest: string;
  requestedAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString();
const toJob = (r: Record<string, unknown>): JobRow => ({
  id: r.id as string,
  orgId: r.org_id as string,
  runId: r.run_id as string,
  idempotencyKey: r.idempotency_key as string,
  profile: r.profile as string,
  decisionDigest: r.decision_digest as string,
  state: r.state as eg.JobState,
  origin: r.origin as 'MOCK' | 'REAL',
  requiresApproval: r.requires_approval as boolean,
  approvalId: (r.approval_id as string | null) ?? null,
  nodeId: (r.node_id as string | null) ?? null,
  leaseToken: (r.lease_token as string | null) ?? null,
  leaseExpiresAt: iso(r.lease_expires_at),
  attempts: r.attempts as number,
  queuedAt: iso(r.queued_at)!,
  startedAt: iso(r.started_at),
  endedAt: iso(r.ended_at),
  outcomeStatus: (r.outcome_status as string | null) ?? null,
  exitCode: (r.exit_code as number | null) ?? null,
  durationMs: (r.duration_ms as number | null) ?? null,
  truncated: (r.truncated as boolean | null) ?? null,
  artifactCount: r.artifact_count as number,
  dataRegion: r.data_region as string,
});
const toApproval = (r: Record<string, unknown>): ApprovalRow => ({
  id: r.id as string,
  orgId: r.org_id as string,
  jobId: r.job_id as string,
  decisionDigest: r.decision_digest as string,
  requestedAt: iso(r.requested_at)!,
  expiresAt: iso(r.expires_at)!,
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: iso(r.decided_at),
  consumedAt: iso(r.consumed_at),
  revokedAt: iso(r.revoked_at),
  revokeReason: (r.revoke_reason as string | null) ?? null,
});

export class PgExecutionStore {
  constructor(
    private readonly db: Db,
    private readonly newId: () => string = randomUUID,
  ) {}

  // ------------------------------------------------------------------ jobs
  /** idempotent per (org, idempotencyKey): a replay returns the stored job (`created: false`) */
  async enqueue(
    j: NewJob,
    initial: Extract<eg.JobState, 'requested' | 'queued' | 'awaiting_approval'> = 'queued',
  ): Promise<{ job: JobRow; created: boolean }> {
    return this.db.withOrg(j.orgId, async (c) => {
      const ins = await c.query(
        `INSERT INTO execution.jobs (id, org_id, run_id, idempotency_key, profile, decision_digest, state, origin, requires_approval, data_region)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING *`,
        [
          this.newId(),
          j.orgId,
          j.runId,
          j.idempotencyKey,
          j.profile,
          j.decisionDigest,
          initial,
          j.origin,
          j.requiresApproval,
          j.dataRegion,
        ],
      );
      if (ins.rows[0]) {
        await this.log(c, ins.rows[0] as Record<string, unknown>, 'requested', initial, 'enqueued');
        return { job: toJob(ins.rows[0]), created: true };
      }
      const old = await c.query(
        `SELECT * FROM execution.jobs WHERE org_id = $1 AND idempotency_key = $2`,
        [j.orgId, j.idempotencyKey],
      );
      return { job: toJob(old.rows[0]), created: false };
    });
  }
  private async log(
    c: PoolClient,
    job: Record<string, unknown>,
    from: string,
    to: string,
    cause: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO execution.job_transitions (id, job_id, org_id, from_state, to_state, cause, data_region) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [this.newId(), job.id, job.org_id, from, to, cause, job.data_region],
    );
  }
  async get(orgId: string, jobId: string): Promise<JobRow | null> {
    return this.db.withOrg(orgId, async (c) => {
      const r = await c.query(`SELECT * FROM execution.jobs WHERE id = $1`, [jobId]);
      return r.rows[0] ? toJob(r.rows[0]) : null;
    });
  }
  /**
   * Move a job. The domain decides legality first (`transitionJob`); the UPDATE is guarded by the state the caller saw (`state = from`) so two writers cannot both win, and the
   * database trigger re-checks the same table. Writes the append-only transition row in the same transaction.
   */
  async transition(
    orgId: string,
    jobId: string,
    to: eg.JobState,
    cause: string,
    patch: {
      outcomeStatus?: string;
      exitCode?: number | null;
      durationMs?: number;
      truncated?: boolean;
      artifactCount?: number;
      approvalId?: string;
    } = {},
  ): Promise<TransitionOutcome> {
    return this.db.withOrg(orgId, async (c) => {
      const cur = await c.query(`SELECT * FROM execution.jobs WHERE id = $1 FOR UPDATE`, [jobId]);
      const row = cur.rows[0] as Record<string, unknown> | undefined;
      if (!row) return { ok: false as const, reason: 'job_not_found' };
      const from = row.state as eg.JobState;
      const t = eg.transitionJob(from, to);
      if (!t.ok) return { ok: false as const, reason: t.reason };
      const terminal = eg.JOB_TERMINAL.includes(to);
      const upd = await c.query(
        `UPDATE execution.jobs SET state = $3,
           lease_token = CASE WHEN $3 = 'running' THEN lease_token ELSE NULL END,
           lease_expires_at = CASE WHEN $3 = 'running' THEN lease_expires_at ELSE NULL END,
           ended_at = CASE WHEN $4 THEN now() ELSE ended_at END,
           outcome_status = coalesce($5, outcome_status), exit_code = coalesce($6, exit_code), duration_ms = coalesce($7, duration_ms),
           truncated = coalesce($8, truncated), artifact_count = coalesce($9, artifact_count), approval_id = coalesce($10, approval_id),
           started_at = CASE WHEN $3 = 'running' THEN now() ELSE started_at END,
           attempts = CASE WHEN $3 = 'running' THEN attempts + 1 ELSE attempts END, updated_at = now()
         WHERE id = $1 AND state = $2 RETURNING *`,
        [
          jobId,
          from,
          to,
          terminal,
          patch.outcomeStatus ?? null,
          patch.exitCode ?? null,
          patch.durationMs ?? null,
          patch.truncated ?? null,
          patch.artifactCount ?? null,
          patch.approvalId ?? null,
        ],
      );
      if (!upd.rows[0]) return { ok: false as const, reason: 'state_changed_concurrently' };
      await this.log(c, upd.rows[0] as Record<string, unknown>, from, to, cause);
      return { ok: true as const, job: toJob(upd.rows[0]) };
    });
  }
  /**
   * Claim the oldest queued job, FAIR across organizations (the organization with the fewest running jobs first, then the oldest job). The fleet-wide scan runs in the read-only
   * platform scope; the claim itself is one atomic UPDATE inside the job's own organization, so two workers can never both get it (the loser tries the next candidate).
   * `nodeId` is recorded; a node the caller names as quarantined/dropped must be excluded by the caller (the registry is read with `listNodes`).
   */
  async claim(opts: {
    leaseMs: number;
    nodeId: string;
    maxCandidates?: number;
  }): Promise<JobRow | null> {
    const cands = await this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `SELECT q.id, q.org_id FROM execution.jobs q
         LEFT JOIN (SELECT org_id, count(*) AS running FROM execution.jobs WHERE state = 'running' GROUP BY org_id) r ON r.org_id = q.org_id
         WHERE q.state = 'queued' ORDER BY coalesce(r.running, 0), q.queued_at LIMIT $1`,
        [opts.maxCandidates ?? 10],
      );
      return r.rows as { id: string; org_id: string }[];
    });
    for (const cand of cands) {
      const got = await this.db.withOrg(cand.org_id, async (c) => {
        const lease = randomUUID();
        const r = await c.query(
          `UPDATE execution.jobs SET state = 'running', lease_token = $2, lease_expires_at = now() + ($3 || ' milliseconds')::interval, node_id = $4,
             attempts = attempts + 1, started_at = now(), updated_at = now()
           WHERE id = $1 AND state = 'queued' RETURNING *`,
          [cand.id, lease, String(opts.leaseMs), opts.nodeId],
        );
        if (r.rows[0])
          await this.log(c, r.rows[0] as Record<string, unknown>, 'queued', 'running', 'claimed');
        return r.rows[0] ? toJob(r.rows[0]) : null;
      });
      if (got) return got;
    }
    return null;
  }
  /** extend a lease; false if the caller no longer holds it (it expired and was swept, or another worker owns it) */
  async heartbeat(
    orgId: string,
    jobId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    return this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE execution.jobs SET lease_expires_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
         WHERE id = $1 AND state = 'running' AND lease_token = $2 AND lease_expires_at > now() AND org_id = $3 RETURNING id`,
        [jobId, leaseToken, orgId, String(leaseMs)],
      );
      return r.rowCount === 1;
    });
  }
  /**
   * Expired leases: `running -> queued` while attempts remain (the run is reconciled against the node BEFORE it is retried: the caller asks the node what exists), else
   * `running -> failed`. Returns the job ids per outcome. A crashed worker therefore never strands a job and never causes an unreconciled blind retry (CLAUDE.md §4).
   */
  async sweepExpiredLeases(maxAttempts: number): Promise<{ requeued: string[]; failed: string[] }> {
    const expired = await this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `SELECT id, org_id, attempts FROM execution.jobs WHERE state = 'running' AND lease_expires_at < now() LIMIT 200`,
      );
      return r.rows as { id: string; org_id: string; attempts: number }[];
    });
    const out = { requeued: [] as string[], failed: [] as string[] };
    for (const e of expired) {
      const to: eg.JobState = e.attempts < maxAttempts ? 'queued' : 'failed';
      const res = await this.transition(
        e.org_id,
        e.id,
        to,
        to === 'queued' ? 'lease_expired_requeued' : 'lease_expired_attempts_exhausted',
        to === 'failed' ? { outcomeStatus: 'failed' } : {},
      );
      if (res.ok) (to === 'queued' ? out.requeued : out.failed).push(e.id);
    }
    return out;
  }

  // ------------------------------------------------------------------ approvals
  async requestApproval(
    orgId: string,
    jobId: string,
    decisionDigest: string,
    ttlMs: number,
    dataRegion: string,
  ): Promise<ApprovalRow> {
    return this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `INSERT INTO execution.approvals (id, org_id, job_id, decision_digest, expires_at, data_region) VALUES ($1,$2,$3,$4, now() + ($5 || ' milliseconds')::interval, $6) RETURNING *`,
        [this.newId(), orgId, jobId, decisionDigest, String(ttlMs), dataRegion],
      );
      return toApproval(r.rows[0]);
    });
  }
  /** a HUMAN decides (the caller has already verified the user, the organization and the permission; a service account has no code path here) */
  async approve(
    orgId: string,
    approvalId: string,
    humanUserId: string,
  ): Promise<ApprovalRow | null> {
    return this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE execution.approvals SET decided_by = $3, decider_kind = 'human', decided_at = now()
         WHERE id = $1 AND org_id = $2 AND decided_at IS NULL AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > now() RETURNING *`,
        [approvalId, orgId, humanUserId],
      );
      return r.rows[0] ? toApproval(r.rows[0]) : null;
    });
  }
  /** SINGLE USE: one atomic statement. Returns the approval only if it was decided, bound to this exact decision, unexpired, unrevoked and not yet consumed; otherwise null. */
  async consumeApproval(
    orgId: string,
    approvalId: string,
    decisionDigest: string,
  ): Promise<ApprovalRow | null> {
    return this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE execution.approvals SET consumed_at = now()
         WHERE id = $1 AND org_id = $2 AND decision_digest = $3 AND decided_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING *`,
        [approvalId, orgId, decisionDigest],
      );
      return r.rows[0] ? toApproval(r.rows[0]) : null;
    });
  }
  async revokeApproval(orgId: string, approvalId: string, reason: string): Promise<boolean> {
    return this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE execution.approvals SET revoked_at = now(), revoke_reason = $3 WHERE id = $1 AND org_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,
        [approvalId, orgId, reason.slice(0, 80)],
      );
      return r.rowCount === 1;
    });
  }

  // ------------------------------------------------------------------ kill switch (append-only history; latest row per scope wins)
  async setKillSwitch(
    scope: { kind: 'global' } | { kind: 'org'; orgId: string },
    engaged: boolean,
    byUserId: string | null,
    reasonCode: string,
  ): Promise<void> {
    const run =
      scope.kind === 'global'
        ? (f: (c: PoolClient) => Promise<void>) => this.db.withPlatformScope(f)
        : (f: (c: PoolClient) => Promise<void>) => this.db.withOrg(scope.orgId, f);
    await run(async (c) => {
      await c.query(
        `INSERT INTO execution.kill_switch (id, scope, org_id, engaged, by_user_id, reason_code) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          this.newId(),
          scope.kind,
          scope.kind === 'org' ? scope.orgId : null,
          engaged,
          byUserId,
          reasonCode.slice(0, 60),
        ],
      );
    });
  }
  /** engaged if the LATEST global row is engaged or the latest row of this organization is. Read on every submit and before every run. Fails closed: an error is "engaged". */
  async isStopped(orgId: string): Promise<boolean> {
    try {
      return await this.db.withOrg(orgId, async (c) => {
        const r = await c.query(
          `SELECT bool_or(engaged) AS stopped FROM (
             SELECT DISTINCT ON (scope, org_id) scope, org_id, engaged FROM execution.kill_switch ORDER BY scope, org_id, at DESC, id DESC) latest`,
        );
        return r.rows[0]?.stopped === true;
      });
    } catch {
      return true;
    }
  }

  /** the scopes whose LATEST kill-switch row is engaged (restored at start so a restart never releases a kill switch). Platform scope is read-only here; an error propagates (the caller fails closed). */
  async engagedScopes(): Promise<{ global: boolean; orgs: string[] }> {
    return this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `SELECT scope, org_id, engaged FROM (
           SELECT DISTINCT ON (scope, org_id) scope, org_id, engaged FROM execution.kill_switch ORDER BY scope, org_id, at DESC, id DESC) latest WHERE engaged`,
      );
      const rows = r.rows as { scope: string; org_id: string | null }[];
      return {
        global: rows.some((x) => x.scope === 'global'),
        orgs: rows.filter((x) => x.scope === 'org' && x.org_id).map((x) => x.org_id as string),
      };
    });
  }
  /** every non-terminal job (platform scope, read-only): input of the restart recovery, which then terminates each inside its own organization's scope */
  async openJobs(limit = 1000): Promise<{ id: string; orgId: string; state: eg.JobState }[]> {
    return this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `SELECT id, org_id, state FROM execution.jobs WHERE state NOT IN ('refused','rejected','succeeded','failed','timed_out','terminated','cancelled','expired') ORDER BY queued_at LIMIT $1`,
        [limit],
      );
      return (r.rows as { id: string; org_id: string; state: eg.JobState }[]).map((x) => ({
        id: x.id,
        orgId: x.org_id,
        state: x.state,
      }));
    });
  }

  // ------------------------------------------------------------------ workspaces
  async recordWorkspace(w: {
    id: string;
    orgId: string;
    runId: string;
    jobId: string | null;
    nodeId: string;
    dataRegion: string;
  }): Promise<void> {
    await this.db.withOrg(w.orgId, async (c) => {
      await c.query(
        `INSERT INTO execution.workspaces (id, org_id, run_id, job_id, node_id, state, data_region) VALUES ($1,$2,$3,$4,$5,'creating',$6) ON CONFLICT (id) DO NOTHING`,
        [w.id, w.orgId, w.runId, w.jobId, w.nodeId, w.dataRegion],
      );
    });
  }
  async transitionWorkspace(
    orgId: string,
    id: string,
    to: eg.WorkspaceState,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.db.withOrg(orgId, async (c) => {
      const cur = await c.query(`SELECT state FROM execution.workspaces WHERE id = $1 FOR UPDATE`, [
        id,
      ]);
      if (!cur.rows[0]) return { ok: false as const, reason: 'workspace_not_found' };
      const t = eg.transitionWorkspace(cur.rows[0].state as eg.WorkspaceState, to);
      if (!t.ok) return { ok: false as const, reason: t.reason };
      await c.query(
        `UPDATE execution.workspaces SET state = $2, last_activity_at = now(), destroyed_at = CASE WHEN $2 = 'destroyed' THEN now() ELSE NULL END WHERE id = $1`,
        [id, to],
      );
      return { ok: true as const };
    });
  }
  /** workspaces the control plane believes exist on a node (not destroyed): reconciled against the node's `listWorkspaces` after a restart */
  async liveWorkspaces(
    nodeId: string,
  ): Promise<{ id: string; orgId: string; runId: string; state: string }[]> {
    return this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `SELECT id, org_id, run_id, state FROM execution.workspaces WHERE node_id = $1 AND state <> 'destroyed' ORDER BY created_at`,
        [nodeId],
      );
      return r.rows.map((x) => ({
        id: x.id as string,
        orgId: x.org_id as string,
        runId: x.run_id as string,
        state: x.state as string,
      }));
    });
  }

  // ------------------------------------------------------------------ reservations and usage
  async holdReservation(r: {
    orgId: string;
    jobId: string;
    currency: string;
    reservedMinor: number;
    concurrencySlots: number;
    dataRegion: string;
  }): Promise<boolean> {
    return this.db.withOrg(r.orgId, async (c) => {
      const x = await c.query(
        `INSERT INTO execution.quota_reservations (id, org_id, job_id, currency, reserved_minor, concurrency_slots, data_region) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, job_id) DO NOTHING RETURNING id`,
        [
          this.newId(),
          r.orgId,
          r.jobId,
          r.currency,
          r.reservedMinor,
          r.concurrencySlots,
          r.dataRegion,
        ],
      );
      return x.rowCount === 1;
    });
  }
  async closeReservation(
    orgId: string,
    jobId: string,
    to: 'released' | 'settled',
  ): Promise<boolean> {
    return this.db.withOrg(orgId, async (c) => {
      const x = await c.query(
        `UPDATE execution.quota_reservations SET state = $3 WHERE org_id = $1 AND job_id = $2 AND state = 'held' RETURNING id`,
        [orgId, jobId, to],
      );
      return x.rowCount === 1;
    });
  }
  /** the measured-use fact for the metering pipeline (idempotent per run and job); this store never writes a ledger row */
  async recordUsage(u: {
    orgId: string;
    runId: string;
    jobId: string | null;
    nodeId: string;
    runtimeClass: string;
    profile: string;
    cpuSeconds: number;
    wallMs: number;
    peakMemoryMb: number;
    peakPids: number;
    diskMb: number;
    outputBytes: number;
    status: string;
    estimatedMinor: number;
    currency: string;
    dataRegion: string;
  }): Promise<boolean> {
    return this.db.withOrg(u.orgId, async (c) => {
      const x = await c.query(
        `INSERT INTO execution.usage_records (id, org_id, run_id, job_id, node_id, runtime_class, profile, cpu_seconds, wall_ms, peak_memory_mb, peak_pids, disk_mb, output_bytes, status, estimated_minor, currency, data_region)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (org_id, run_id, job_id) DO NOTHING RETURNING id`,
        [
          this.newId(),
          u.orgId,
          u.runId,
          u.jobId,
          u.nodeId,
          u.runtimeClass,
          u.profile,
          u.cpuSeconds,
          u.wallMs,
          u.peakMemoryMb,
          u.peakPids,
          u.diskMb,
          u.outputBytes,
          u.status,
          u.estimatedMinor,
          u.currency,
          u.dataRegion,
        ],
      );
      return x.rowCount === 1;
    });
  }

  // ------------------------------------------------------------------ node registry and attestation records (platform scope; public data only)
  async upsertNode(n: {
    nodeId: string;
    endpointId: string;
    environment: 'staging' | 'production';
    runtimeClass: string;
    dataRegion?: string;
  }): Promise<void> {
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `INSERT INTO execution.runtime_nodes (id, node_id, endpoint_id, environment, runtime_class, data_region) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (node_id) DO UPDATE SET endpoint_id = EXCLUDED.endpoint_id, data_region = EXCLUDED.data_region, updated_at = now()`,
        [this.newId(), n.nodeId, n.endpointId, n.environment, n.runtimeClass, n.dataRegion ?? null],
      );
    });
  }
  async setNodeState(
    nodeId: string,
    state: 'admitted' | 'quarantined' | 'dropped' | 'retired',
    reason: string | null,
  ): Promise<boolean> {
    return this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `UPDATE execution.runtime_nodes SET state = $2, quarantine_reason = $3, updated_at = now() WHERE node_id = $1 RETURNING id`,
        [nodeId, state, reason?.slice(0, 80) ?? null],
      );
      return r.rowCount === 1;
    });
  }
  async listNodes(): Promise<
    { nodeId: string; state: string; environment: string; dataRegion: string | null }[]
  > {
    return this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `SELECT node_id, state, environment, data_region FROM execution.runtime_nodes ORDER BY node_id`,
      );
      return r.rows.map((x) => ({
        nodeId: x.node_id as string,
        state: x.state as string,
        environment: x.environment as string,
        dataRegion: (x.data_region as string | null) ?? null,
      }));
    });
  }
  async recordAttestation(a: {
    attestationId: string;
    nodeId: string;
    label: string;
    issuedAt: string;
    expiresAt: string;
    reportSha256: string;
    reviewer: string;
    reviewRef: string;
    evidenceRef?: string;
  }): Promise<boolean> {
    return this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `INSERT INTO execution.attestations (id, attestation_id, node_id, label, issued_at, expires_at, report_sha256, reviewer, review_ref, evidence_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (attestation_id) DO NOTHING RETURNING id`,
        [
          this.newId(),
          a.attestationId,
          a.nodeId,
          a.label,
          a.issuedAt,
          a.expiresAt,
          a.reportSha256,
          a.reviewer,
          a.reviewRef,
          a.evidenceRef ?? null,
        ],
      );
      return r.rowCount === 1;
    });
  }
  async revokeAttestation(attestationId: string, reason: string): Promise<boolean> {
    return this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `UPDATE execution.attestations SET revoked_at = now(), revoke_reason = $2 WHERE attestation_id = $1 AND revoked_at IS NULL RETURNING id`,
        [attestationId, reason.slice(0, 80)],
      );
      return r.rowCount === 1;
    });
  }
  /** the revocation set the control plane hands to `RealRuntimeService` (`isRevoked`): fail closed callers treat a read error as "everything revoked" */
  async revokedAttestationIds(): Promise<Set<string>> {
    return this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `SELECT attestation_id FROM execution.attestations WHERE revoked_at IS NOT NULL`,
      );
      return new Set(r.rows.map((x) => x.attestation_id as string));
    });
  }
}
