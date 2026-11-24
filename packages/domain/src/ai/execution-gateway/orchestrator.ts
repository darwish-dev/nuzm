import {
  ApprovalWorkflow,
  describeForApproval,
  type AllowedDecision,
  type Approver,
} from './approval';
import {
  buildExecAudit,
  outputByteCounts,
  type ExecAuditAction,
  type ExecAuditRecord,
} from './audit';
import { collectArtifacts, DEFAULT_ARTIFACT_POLICY, type ArtifactPolicy } from './artifacts';
import { createHash } from 'node:crypto';
import { canonicalJson } from './real-runtime/attestation';
import { checkRunEnv, screenOutput } from './env-guard';
import { StateTrack, transitionJob, type JobState, type TransitionRecord } from './lifecycle';
import type { JournalDeps, JournalPatch } from './journal';
import { executionGate, type ExecGateState, type ExecRequest } from './policy';
import { type ExecutionOutcome, type ExecutionPort } from './port';
import { ExecutionQueue, type QueueConfig } from './queue';
import { QuotaLedger, type OrgCeilings, type Reservation } from './quota';
import type { ExecutionKillSwitch } from './termination';

/**
 * S-AG6 (OFFLINE): the orchestrator composes the gateway pieces into the flow ADR-067 describes, against ports, with an injected clock. It is NOT wired to a route, a tool, a job or
 * a module; it exists so the whole flow (policy, flags, kill switch, quota, approval, queue, run, output screening, artifacts, audit, quota settlement) is tested end to end on the
 * mock. Order of checks at `submit`: execution flag, kill switch, gate (for a REAL port), policy decision, early quota check, then approval or queue. `runNext` re-checks the
 * kill switch, the gate and the environment immediately before running. A `REAL` port with a closed gate is refused at both points.
 *
 * Engineering decisions (recorded in REPORT-04): (1) a quota reservation is taken when a worker claims the job (queued jobs hold no concurrency slot); (2) a canary in output
 * engages the organization's kill switch (fail closed); (3) an approval is consumed at claim time, so an approval that expired while queued stops the run.
 */
export interface OrchestratorFlags {
  /** `ai.agent.exec_tools`, default off */
  execTools: boolean;
  /** the existing platform AI kill switch */
  aiKillSwitch: boolean;
}
export interface OrchestratorDeps {
  port: ExecutionPort;
  ledger: QuotaLedger;
  queue: ExecutionQueue<string>;
  approvals: ApprovalWorkflow;
  killSwitch: ExecutionKillSwitch;
  audit: (r: ExecAuditRecord) => void | Promise<void>;
  gate: () => ExecGateState;
  flags: () => OrchestratorFlags;
  ceilings: (orgId: string) => OrgCeilings;
  canaries: () => readonly string[];
  now: () => number;
  artifactPolicy?: ArtifactPolicy;
  /** P3-S02 durable journal (default: none). With it, every job and state change is also recorded durably; creation is fail-closed (see `journal.ts`). */
  journal?: JournalDeps;
}
export type SubmitResult =
  | { status: 'refused'; reasons: string[] }
  | {
      status: 'awaiting_approval';
      jobId: string;
      approvalId: string;
      summary: ReturnType<typeof describeForApproval>;
    }
  | { status: 'queued'; jobId: string; duplicate: boolean };
export interface JobView {
  jobId: string;
  state: JobState;
  profile: string;
  origin: 'MOCK' | 'REAL';
  outcome: ScreenedOutcome | null;
  history: { to: JobState; cause: string }[];
}
export interface ScreenedOutcome extends Omit<ExecutionOutcome, 'artifacts'> {
  artifacts: { id: string; path: string; bytes: number; sha256: string }[];
  artifactsRefused: { path: string; reason: string }[];
  redactions: number;
  /** candidates only: nothing is applied to the project */
  applied: false;
}
interface Job {
  id: string;
  orgId: string;
  runId: string;
  idempotencyKey: string;
  fingerprint: string;
  decision: AllowedDecision;
  approvalId: string | null;
  track: StateTrack<JobState>;
  outcome: ScreenedOutcome | null;
  reservation: Reservation | null;
  queueId: string | null;
  actorUserId?: string;
}

export interface SubmitInput {
  orgId: string;
  runId: string;
  request: ExecRequest;
  idempotencyKey: string;
  actorUserId?: string;
}
/** a stable digest of what a submit asks for: the same key must always mean the same request in the same run */
function fingerprintOf(i: SubmitInput): string {
  return createHash('sha256')
    .update(canonicalJson({ r: i.runId, q: i.request }))
    .digest('hex');
}

export class ExecutionOrchestrator {
  private readonly jobs = new Map<string, Job>();
  private readonly keys = new Map<string, string>();
  /** submits being processed, by idempotency key: registered BEFORE the first await so concurrent duplicates cannot both pass the key check (DEFECT-10) */
  private readonly inflight = new Map<
    string,
    { fingerprint: string; result: Promise<SubmitResult> }
  >();
  private seq = 0;
  constructor(private readonly d: OrchestratorDeps) {}

  private async emit(
    action: ExecAuditAction,
    j: { orgId: string; runId: string; id?: string },
    outcome: 'success' | 'failure',
    detail: Record<string, unknown> = {},
    actor: { userId?: string; type: 'user' | 'system' | 'agent' } = { type: 'system' },
  ) {
    await this.d.audit(
      buildExecAudit({
        action,
        orgId: j.orgId,
        runId: j.runId,
        jobId: j.id,
        actorUserId: actor.userId,
        actorType: actor.type,
        outcome,
        detail: { runtimeOrigin: this.d.port.origin, ...detail },
        at: new Date(this.d.now()),
      }),
    );
  }
  /** ids of jobs whose durable record exists: only these are journaled (a move for an unrecorded job would be an orphan row) */
  private readonly journaled = new Set<string>();
  /** the outcome numbers of a job's terminal move, set just before it */
  private readonly patches = new Map<string, JournalPatch>();
  private newTrack(id: string, orgId: string) {
    return new StateTrack<JobState>(
      'requested',
      transitionJob,
      () => new Date(this.d.now()),
      (m: TransitionRecord<JobState>) => {
        const sink = this.d.journal?.sink;
        if (!sink || !this.journaled.has(id)) return;
        const patch = this.patches.get(id);
        this.patches.delete(id);
        sink.moved({
          jobId: id,
          orgId,
          from: m.from,
          to: m.to,
          cause: m.cause,
          at: m.at,
          ...(patch ? { patch } : {}),
        });
      },
    );
  }
  /** common pre-run checks; returns the refusal reasons */
  private preflight(orgId: string): string[] {
    const r: string[] = [];
    const f = this.d.flags();
    if (!f.execTools) r.push('feature_flag_off');
    if (f.aiKillSwitch) r.push('ai_kill_switch');
    if (this.d.killSwitch.isEngaged(orgId)) r.push('execution_kill_switch');
    if (this.d.port.origin === 'REAL') {
      const g = executionGate(this.d.gate());
      if (!g.open) r.push('gate_closed');
    }
    return r;
  }

  /**
   * Idempotent per organization and key. The key is claimed synchronously, before any await: a concurrent duplicate waits for the first submit and gets the same job; the same key
   * with a different run or request is a CONFLICT (`idempotency_key_conflict`), never the first job returned for a different request.
   */
  async submit(i: SubmitInput): Promise<SubmitResult> {
    const k = `${i.orgId}\u0000${i.idempotencyKey}`;
    const fp = fingerprintOf(i);
    const flying = this.inflight.get(k);
    if (flying) {
      if (flying.fingerprint !== fp) return this.conflict(i);
      const first = await flying.result;
      return first.status === 'queued' ? { ...first, duplicate: true } : first;
    }
    const stored = this.keys.get(k);
    if (stored && this.jobs.get(stored)!.fingerprint !== fp) return this.conflict(i);
    const result = this.submitOnce(i);
    this.inflight.set(k, { fingerprint: fp, result });
    try {
      return await result;
    } finally {
      this.inflight.delete(k);
    }
  }
  private async conflict(i: SubmitInput): Promise<SubmitResult> {
    await this.emit('ai.execution.refused', { orgId: i.orgId, runId: i.runId }, 'failure', {
      reasons: ['idempotency_key_conflict'],
    });
    return { status: 'refused', reasons: ['idempotency_key_conflict'] };
  }

  private async submitOnce(i: SubmitInput): Promise<SubmitResult> {
    const base = { orgId: i.orgId, runId: i.runId };
    await this.emit(
      'ai.execution.requested',
      base,
      'success',
      {},
      { type: 'agent', userId: i.actorUserId },
    );
    // the organization and run in the request are the CALLER's verified context: a request that names another is refused by the policy, never "fixed"
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(i.idempotencyKey)) {
      await this.emit('ai.execution.refused', base, 'failure', {
        reasons: ['idempotency_key_invalid'],
      });
      return { status: 'refused', reasons: ['idempotency_key_invalid'] };
    }
    const pre = this.preflight(i.orgId);
    if (pre.length) {
      await this.emit(
        pre.includes('gate_closed') ? 'ai.execution.gate_refused' : 'ai.execution.refused',
        base,
        'failure',
        { reasons: pre },
      );
      return { status: 'refused', reasons: pre };
    }
    const dup = this.keys.get(`${i.orgId}\u0000${i.idempotencyKey}`);
    if (dup) {
      const j = this.jobs.get(dup)!;
      return j.approvalId && j.track.state === 'awaiting_approval'
        ? {
            status: 'awaiting_approval',
            jobId: j.id,
            approvalId: j.approvalId,
            summary: describeForApproval(j.decision),
          }
        : { status: 'queued', jobId: j.id, duplicate: true };
    }
    const decision = await this.d.port.request(i.request);
    if (!decision.allowed) {
      await this.emit('ai.execution.refused', base, 'failure', { reasons: decision.reasons });
      return { status: 'refused', reasons: decision.reasons };
    }
    const quota = this.d.ledger.check(i.orgId, decision.limits, this.d.ceilings(i.orgId), true);
    if (quota.length) {
      await this.emit('ai.execution.quota_refused', base, 'failure', {
        reasons: quota,
        profile: decision.profile,
      });
      return { status: 'refused', reasons: quota };
    }
    const jobId = `ej-${++this.seq}`;
    const job: Job = {
      id: jobId,
      orgId: i.orgId,
      runId: i.runId,
      idempotencyKey: i.idempotencyKey,
      fingerprint: fingerprintOf(i),
      decision,
      approvalId: null,
      track: this.newTrack(jobId, i.orgId),
      outcome: null,
      reservation: null,
      queueId: null,
      actorUserId: i.actorUserId,
    };
    const jr = this.d.journal;
    if (jr) {
      // FAIL CLOSED: the durable record is written BEFORE the job exists in memory; if it cannot be written (store down, key reused after a restart), nothing runs
      const rec = await jr.sink
        .created({
          jobId,
          orgId: i.orgId,
          runId: i.runId,
          idempotencyKey: i.idempotencyKey,
          profile: decision.profile,
          decisionDigest: createHash('sha256').update(canonicalJson(decision)).digest('hex'),
          origin: this.d.port.origin === 'REAL' ? 'REAL' : 'MOCK',
          requiresApproval: decision.requiresApproval,
          dataRegion: jr.dataRegion(i.orgId),
        })
        .catch((): { ok: false; reason: string } => ({ ok: false, reason: 'journal_unavailable' }));
      if (!rec.ok) {
        await this.emit('ai.execution.refused', base, 'failure', { reasons: [rec.reason] });
        return { status: 'refused', reasons: [rec.reason] };
      }
      this.journaled.add(jobId);
    }
    this.jobs.set(job.id, job);
    this.keys.set(`${i.orgId}\u0000${i.idempotencyKey}`, job.id);
    if (decision.requiresApproval) {
      const a = this.d.approvals.request(decision, i.orgId, i.runId);
      if (!a.ok) throw new Error(`approval invariant: ${a.reason}`);
      job.approvalId = a.approval.id;
      job.track.move('awaiting_approval', 'approval_requested');
      await this.emit('ai.execution.approval_requested', { ...base, id: job.id }, 'success', {
        profile: decision.profile,
        network: decision.network,
        approvalId: a.approval.id,
      });
      return {
        status: 'awaiting_approval',
        jobId: job.id,
        approvalId: a.approval.id,
        summary: describeForApproval(decision),
      };
    }
    return this.enqueue(job, 'admitted');
  }

  private async enqueue(job: Job, cause: string): Promise<SubmitResult> {
    const q = this.d.queue.enqueue({
      orgId: job.orgId,
      runId: job.runId,
      idempotencyKey: `exec-job-${job.id}`,
      payload: job.id,
    });
    if (!q.ok) {
      job.track.move('refused', q.reason);
      await this.emit(
        'ai.execution.refused',
        { orgId: job.orgId, runId: job.runId, id: job.id },
        'failure',
        { reasons: [q.reason] },
      );
      return { status: 'refused', reasons: [q.reason] };
    }
    job.queueId = q.job.id;
    job.track.move('queued', cause);
    await this.emit(
      'ai.execution.queued',
      { orgId: job.orgId, runId: job.runId, id: job.id },
      'success',
      { profile: job.decision.profile },
    );
    return { status: 'queued', jobId: job.id, duplicate: q.duplicate };
  }

  /** A human decides. Tenant-scoped: another organization's job id is "unknown". */
  async decide(
    jobId: string,
    by: Approver,
    verdict: 'approve' | 'reject',
    reason?: string,
  ): Promise<{ ok: true; state: JobState } | { ok: false; reason: string }> {
    const job = this.jobs.get(jobId);
    if (!job || job.orgId !== by.orgId || !job.approvalId)
      return { ok: false, reason: 'unknown_job' };
    const r = this.d.approvals.decide(job.approvalId, by, verdict, reason);
    const ev = { orgId: job.orgId, runId: job.runId, id: job.id };
    if (!r.ok) {
      if (r.reason === 'approval_expired' && job.track.state === 'awaiting_approval') {
        job.track.move('expired', 'approval_expired');
        await this.emit('ai.execution.approval_expired', ev, 'failure', {
          approvalId: job.approvalId,
        });
      }
      return { ok: false, reason: r.reason };
    }
    if (verdict === 'reject') {
      job.track.move('rejected', 'human_rejected');
      await this.emit(
        'ai.execution.rejected',
        ev,
        'success',
        { approvalId: job.approvalId },
        { type: 'user', userId: by.userId },
      );
      return { ok: true, state: 'rejected' };
    }
    await this.emit(
      'ai.execution.approved',
      ev,
      'success',
      { approvalId: job.approvalId },
      { type: 'user', userId: by.userId },
    );
    const pre = this.preflight(job.orgId);
    if (pre.length) {
      job.track.move('terminated', pre[0]!);
      this.d.approvals.revoke(job.approvalId, job.orgId);
      await this.emit('ai.execution.refused', ev, 'failure', { reasons: pre });
      return { ok: true, state: 'terminated' };
    }
    const q = await this.enqueue(job, 'human_approved');
    return q.status === 'refused' ? { ok: true, state: 'refused' } : { ok: true, state: 'queued' };
  }

  /** One worker step: claim the next job that may run, run it through the port, screen, settle quota, audit. Returns null when nothing may run. */
  async runNext(workerId: string): Promise<JobView | null> {
    const ceil = (o: string) => this.d.ceilings(o).maxConcurrent;
    const claimed = this.d.queue.claim(workerId, ceil);
    if (!claimed) return null;
    const job = this.jobs.get(claimed.payload)!;
    const ev = { orgId: job.orgId, runId: job.runId, id: job.id };
    job.track.move('running', 'claimed');
    const stop = async (
      to: 'failed' | 'terminated',
      cause: string,
      reasons: string[],
      action: ExecAuditAction = 'ai.execution.refused',
    ) => {
      this.d.queue.complete(claimed.id, claimed.lease!.token, to);
      job.track.move(to, cause);
      await this.emit(action, ev, 'failure', { reasons });
      return this.view(job);
    };
    const pre = this.preflight(job.orgId);
    if (pre.length) return stop('terminated', pre[0]!, pre);
    const env = checkRunEnv(job.decision.env);
    if (!env.ok) return stop('failed', 'env_guard', env.reasons);
    const adm = this.d.ledger.admit(
      job.orgId,
      job.runId,
      job.decision.limits,
      this.d.ceilings(job.orgId),
    );
    if (!adm.ok) return stop('failed', 'quota', adm.reasons, 'ai.execution.quota_refused');
    job.reservation = adm.reservation;
    let approvalId: string | undefined;
    if (job.decision.requiresApproval) {
      const c = this.d.approvals.consume(job.approvalId ?? '', job.decision, job.orgId, job.runId);
      if (!c.ok) {
        this.d.ledger.release(adm.reservation.id, job.orgId, 0, this.d.ceilings(job.orgId).rates);
        job.reservation = null;
        return stop('failed', `approval_${c.reason}`, [c.reason]);
      }
      approvalId = c.approval.id;
    }
    await this.emit('ai.execution.started', ev, 'success', {
      profile: job.decision.profile,
      attempt: claimed.attempts,
    });
    let raw: ExecutionOutcome;
    try {
      raw = await this.d.port.run(job.decision, { orgId: job.orgId, runId: job.runId, approvalId });
    } catch {
      raw = {
        status: 'failed',
        exitCode: null,
        stdout: '',
        stderr: 'runtime_error',
        truncated: false,
        durationMs: 0,
        artifacts: [],
      };
    }
    return this.settle(job, claimed.id, claimed.lease!.token, raw);
  }

  private async settle(
    job: Job,
    queueId: string,
    lease: string,
    raw: ExecutionOutcome,
  ): Promise<JobView> {
    const ev = { orgId: job.orgId, runId: job.runId, id: job.id };
    const canaries = this.d.canaries();
    const o = screenOutput(raw.stdout, canaries);
    const e = screenOutput(raw.stderr, canaries);
    const art = collectArtifacts(
      raw.artifacts.map((a) => ({
        path: a.path,
        bytes: a.bytes,
        kind: a.kind ?? ('file' as const),
        sha256: a.sha256,
      })),
      this.d.artifactPolicy ?? DEFAULT_ARTIFACT_POLICY,
      () => new Date(this.d.now()),
      (n) => `${job.id}-art-${n + 1}`,
    );
    job.outcome = {
      ...raw,
      stdout: o.text,
      stderr: e.text,
      artifacts: art.accepted.map((a) => ({
        id: a.id,
        path: a.path,
        bytes: a.bytes,
        sha256: a.sha256,
      })),
      artifactsRefused: art.refused,
      redactions: o.redactions + e.redactions,
      applied: false,
    };
    if (o.canaryHit || e.canaryHit) {
      this.d.killSwitch.engageOrg(job.orgId, 'canary_in_output');
      await this.emit('ai.execution.kill_switch', ev, 'failure', {
        scope: 'org',
        cause: 'canary_in_output',
      });
    }
    if (o.redactions + e.redactions > 0)
      await this.emit('ai.execution.output_redacted', ev, 'success', {
        count: o.redactions + e.redactions,
      });
    if (art.accepted.length)
      await this.emit('ai.execution.artifact_recorded', ev, 'success', {
        artifactCount: art.accepted.length,
        artifactBytes: art.accepted.reduce((n, a) => n + a.bytes, 0),
      });
    if (art.refused.length)
      await this.emit('ai.execution.artifact_refused', ev, 'failure', {
        count: art.refused.length,
        reasons: [...new Set(art.refused.map((r) => r.reason))],
      });
    const final: Extract<JobState, 'succeeded' | 'failed' | 'timed_out' | 'terminated'> =
      raw.status === 'completed' && raw.exitCode === 0
        ? 'succeeded'
        : raw.status === 'timeout'
          ? 'timed_out'
          : raw.status === 'terminated'
            ? 'terminated'
            : 'failed';
    this.d.queue.complete(queueId, lease, final === 'terminated' ? 'terminated' : final);
    this.patches.set(job.id, {
      outcomeStatus: raw.status.slice(0, 40),
      exitCode: raw.exitCode ?? null,
      durationMs: Math.max(0, Math.floor(raw.durationMs)),
      truncated: raw.truncated,
      artifactCount: art.accepted.length,
    });
    job.track.move(final, `port_${raw.status}`);
    this.patches.delete(job.id);
    if (job.reservation) {
      // settle on the CPU the runtime measured when it reports it (a real port does); otherwise on wall time, the conservative upper bound for a single-process run. The ledger
      // caps either at the reservation, so a runtime that over-reports cannot bill beyond what was admitted.
      const measured = raw.usage?.cpuSeconds;
      const cpuSeconds =
        typeof measured === 'number' && Number.isFinite(measured) && measured >= 0
          ? Math.ceil(measured)
          : Math.ceil(raw.durationMs / 1000);
      this.d.ledger.release(
        job.reservation.id,
        job.orgId,
        cpuSeconds,
        this.d.ceilings(job.orgId).rates,
      );
    }
    await this.emit('ai.execution.finished', ev, final === 'succeeded' ? 'success' : 'failure', {
      status: raw.status,
      exitCode: raw.exitCode ?? -1,
      durationMs: raw.durationMs,
      truncated: raw.truncated,
      ...outputByteCounts(raw),
    });
    return this.view(job);
  }

  async cancel(jobId: string, orgId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.orgId !== orgId) return false;
    if (job.track.state === 'awaiting_approval') {
      job.track.move('cancelled', 'caller_cancelled');
      if (job.approvalId) this.d.approvals.revoke(job.approvalId, orgId);
      return true;
    }
    if (job.track.state === 'queued' && job.queueId && this.d.queue.cancel(job.queueId, orgId)) {
      job.track.move('cancelled', 'caller_cancelled');
      return true;
    }
    return false;
  }

  /** the periodic housekeeping: expire waiting jobs and approvals */
  async sweep(): Promise<{ expired: string[]; requeued: string[]; failed: string[] }> {
    const s = this.d.queue.sweep();
    for (const job of this.jobs.values()) {
      const ev = { orgId: job.orgId, runId: job.runId, id: job.id };
      if (
        job.track.state === 'awaiting_approval' &&
        job.approvalId &&
        this.d.approvals.get(job.approvalId)?.state === 'expired'
      ) {
        job.track.move('expired', 'approval_expired');
        await this.emit('ai.execution.approval_expired', ev, 'failure', {
          approvalId: job.approvalId,
        });
      }
    }
    return s;
  }

  /** Emergency: mark every non-terminal job of a scope terminated and revoke approvals. (Killing live processes is `terminate()` in termination.ts through the runtime ports.) */
  async emergencyStop(
    scope: { orgId?: string },
    cause: string,
  ): Promise<{ jobs: number; approvals: number }> {
    let jobs = 0;
    for (const job of this.jobs.values()) {
      if (scope.orgId !== undefined && job.orgId !== scope.orgId) continue;
      const r = job.track.move('terminated', cause);
      if (r.ok) {
        jobs++;
        if (job.reservation)
          this.d.ledger.release(job.reservation.id, job.orgId, 0, this.d.ceilings(job.orgId).rates);
      }
    }
    this.d.queue.terminateAll(scope.orgId);
    let approvals = 0;
    if (scope.orgId !== undefined) approvals = this.d.approvals.revokeAll({ orgId: scope.orgId });
    else
      for (const o of new Set([...this.jobs.values()].map((j) => j.orgId)))
        approvals += this.d.approvals.revokeAll({ orgId: o });
    await this.d.audit(
      buildExecAudit({
        action: 'ai.execution.terminated',
        orgId: scope.orgId ?? '*',
        runId: '*',
        actorType: 'system',
        outcome: 'success',
        detail: { scope: scope.orgId ? 'org' : 'all', cause, count: jobs },
        at: new Date(this.d.now()),
      }),
    );
    return { jobs, approvals };
  }

  /** tenant-scoped view: another organization's job id is indistinguishable from a missing one */
  status(jobId: string, orgId: string): JobView | null {
    const j = this.jobs.get(jobId);
    return j && j.orgId === orgId ? this.view(j) : null;
  }
  private view(j: Job): JobView {
    return {
      jobId: j.id,
      state: j.track.state,
      profile: j.decision.profile,
      origin: this.d.port.origin,
      outcome: j.outcome,
      history: j.track.history.map((h) => ({ to: h.to, cause: h.cause })),
    };
  }
}
export type { QueueConfig };
