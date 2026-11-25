import { isJobTerminal, transitionJob, type JobState } from './lifecycle';

/**
 * S-AG6 (OFFLINE): the execution job queue. In memory, deterministic, injected clock. Properties the durable (BullMQ + `platform.operations`) implementation must keep:
 *  - idempotent enqueue: the same (org, idempotencyKey) returns the same job, never a second one;
 *  - fairness: workers are handed jobs round-robin ACROSS organizations (one organization's backlog cannot starve another) and FIFO within an organization;
 *  - bounded depth per organization and in total (backpressure is a refusal, not unbounded memory);
 *  - per-organization concurrency is enforced at `claim` (the quota ledger is the source of the number);
 *  - jobs expire when they wait too long; a claimed job that is never completed is returned after its lease (a crashed worker never strands a run: reconcile BEFORE retry);
 *  - a job is claimed by exactly one worker (lease token), and only the lease holder may complete it.
 */
export interface QueuedJob<P = unknown> {
  id: string;
  orgId: string;
  runId: string;
  idempotencyKey: string;
  payload: P;
  state: JobState;
  enqueuedAt: number;
  expiresAt: number;
  attempts: number;
  lease: { token: string; workerId: string; until: number } | null;
}
export interface QueueConfig {
  maxDepthPerOrg: number;
  maxDepthTotal: number;
  /** how long a queued job may wait */
  maxWaitMs: number;
  leaseMs: number;
  /** a job whose lease expired this many times is failed instead of requeued */
  maxAttempts: number;
}
export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  maxDepthPerOrg: 20,
  maxDepthTotal: 200,
  maxWaitMs: 15 * 60_000,
  leaseMs: 10 * 60_000,
  maxAttempts: 2,
};
export type EnqueueResult<P> =
  | { ok: true; job: QueuedJob<P>; duplicate: boolean }
  | { ok: false; reason: 'org_depth_ceiling' | 'total_depth_ceiling' | 'idempotency_key_invalid' };

export class ExecutionQueue<P = unknown> {
  private readonly jobs = new Map<string, QueuedJob<P>>();
  private readonly byKey = new Map<string, string>();
  /** round-robin cursor over organizations that have waiting jobs */
  private cursor = 0;
  private seq = 0;
  constructor(
    private readonly cfg: QueueConfig = DEFAULT_QUEUE_CONFIG,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** every state change goes through the lifecycle table; an illegal one is a programming error, not a runtime condition */
  private set(j: QueuedJob<P>, to: JobState): void {
    const r = transitionJob(j.state, to);
    if (!r.ok) throw new Error(`execution queue invariant: ${r.reason}`);
    j.state = to;
  }
  get(id: string): QueuedJob<P> | undefined {
    return this.jobs.get(id);
  }
  depth(orgId?: string): number {
    let n = 0;
    for (const j of this.jobs.values())
      if (j.state === 'queued' && (orgId === undefined || j.orgId === orgId)) n++;
    return n;
  }
  running(orgId: string): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.state === 'running' && j.orgId === orgId) n++;
    return n;
  }
  enqueue(i: {
    orgId: string;
    runId: string;
    idempotencyKey: string;
    payload: P;
    /** starts in `queued`; a job that still waits for a human is enqueued by the workflow only after approval */
  }): EnqueueResult<P> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(i.idempotencyKey))
      return { ok: false, reason: 'idempotency_key_invalid' };
    const key = `${i.orgId}\u0000${i.idempotencyKey}`;
    const existing = this.byKey.get(key);
    if (existing) return { ok: true, job: this.jobs.get(existing)!, duplicate: true };
    if (this.depth(i.orgId) >= this.cfg.maxDepthPerOrg)
      return { ok: false, reason: 'org_depth_ceiling' };
    if (this.depth() >= this.cfg.maxDepthTotal) return { ok: false, reason: 'total_depth_ceiling' };
    const t = this.now();
    const job: QueuedJob<P> = {
      id: `job-${++this.seq}`,
      orgId: i.orgId,
      runId: i.runId,
      idempotencyKey: i.idempotencyKey,
      payload: i.payload,
      state: 'queued',
      enqueuedAt: t,
      expiresAt: t + this.cfg.maxWaitMs,
      attempts: 0,
      lease: null,
    };
    this.jobs.set(job.id, job);
    this.byKey.set(key, job.id);
    return { ok: true, job, duplicate: false };
  }

  /** Expire jobs that waited too long and requeue (or fail) jobs whose lease ran out. Call before `claim`; returns what changed. */
  sweep(): { expired: string[]; requeued: string[]; failed: string[] } {
    const t = this.now();
    const out = { expired: [] as string[], requeued: [] as string[], failed: [] as string[] };
    for (const j of this.jobs.values()) {
      if (j.state === 'queued' && t >= j.expiresAt) {
        this.set(j, 'expired');
        out.expired.push(j.id);
      } else if (j.state === 'running' && j.lease && t >= j.lease.until) {
        j.lease = null;
        if (j.attempts >= this.cfg.maxAttempts) {
          this.set(j, 'failed');

          out.failed.push(j.id);
        } else {
          this.set(j, 'queued');
          j.expiresAt = t + this.cfg.maxWaitMs;
          out.requeued.push(j.id);
        }
      }
    }
    return out;
  }

  /**
   * Hand the next job to a worker. `orgLimit(orgId)` returns the organization's concurrent-run allowance (from the quota ledger); an organization at its limit is skipped, so a
   * saturated tenant never blocks the others. Fair across organizations: round-robin over those with waiting jobs, FIFO inside.
   */
  claim(workerId: string, orgLimit: (orgId: string) => number): QueuedJob<P> | null {
    this.sweep();
    const waiting = [...this.jobs.values()]
      .filter((j) => j.state === 'queued')
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt || (a.id < b.id ? -1 : 1));
    const orgs = [...new Set(waiting.map((j) => j.orgId))];
    if (orgs.length === 0) return null;
    for (let k = 0; k < orgs.length; k++) {
      const orgId = orgs[(this.cursor + k) % orgs.length]!;
      if (this.running(orgId) >= orgLimit(orgId)) continue;
      const job = waiting.find((j) => j.orgId === orgId)!;
      this.cursor = (this.cursor + k + 1) % Math.max(1, orgs.length);
      this.set(job, 'running');
      job.attempts += 1;
      job.lease = {
        token: `lease-${job.id}-${job.attempts}`,
        workerId,
        until: this.now() + this.cfg.leaseMs,
      };
      return job;
    }
    return null;
  }
  /** Only the current lease holder may finish a job; a stale worker (its lease expired and the job was requeued) is refused. */
  complete(
    id: string,
    leaseToken: string,
    final: Extract<JobState, 'succeeded' | 'failed' | 'timed_out' | 'terminated'>,
  ): { ok: true } | { ok: false; reason: string } {
    const j = this.jobs.get(id);
    if (!j) return { ok: false, reason: 'unknown_job' };
    if (j.state !== 'running' || !j.lease || j.lease.token !== leaseToken)
      return { ok: false, reason: 'not_the_lease_holder' };
    this.set(j, final);
    j.lease = null;
    return { ok: true };
  }
  /** a worker extends its lease while the run is alive (heartbeat) */
  heartbeat(id: string, leaseToken: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state !== 'running' || j.lease?.token !== leaseToken) return false;
    j.lease.until = this.now() + this.cfg.leaseMs;
    return true;
  }
  /** cancel a QUEUED job (a running one is cancelled through emergency termination) */
  cancel(id: string, orgId: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.orgId !== orgId || j.state !== 'queued') return false;
    this.set(j, 'cancelled');
    return true;
  }
  /** terminate every non-terminal job of an organization (or all with no argument): the queue half of the kill switch */
  terminateAll(orgId?: string): string[] {
    const ids: string[] = [];
    for (const j of this.jobs.values()) {
      if (isJobTerminal(j.state) || (orgId !== undefined && j.orgId !== orgId)) continue;
      this.set(j, 'terminated');
      j.lease = null;
      ids.push(j.id);
    }
    return ids;
  }
}
