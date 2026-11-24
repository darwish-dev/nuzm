import { executionGateway as eg } from '@nuzm/domain';
import { PgExecutionStore } from './internal/store';

/**
 * P3-S02: the Postgres implementation of the orchestrator's `ExecutionJournal` and the durable kill switch (design: docs/security/sandbox/DURABLE-STORES-DESIGN.md, contract:
 * packages/domain/src/ai/execution-gateway/journal.ts). Nothing constructs it unless the flag `execution.durable_store` is on (default OFF; see `durableExecutionEnabled`), and it is
 * not registered in `app.module.ts` here (CONTRACT-P3-S02-4).
 *
 *  - `created` writes the job row (state `requested`) BEFORE the orchestrator accepts the job: a store failure refuses the submit (fail closed). A key already recorded (a replay after
 *    a restart) is refused too, because the in-memory job it would continue does not exist any more: the caller uses a new key.
 *  - `moved` is write-behind, strictly ordered per job. A failed write is COUNTED and reported through `onError` (alert `ExecutionJournalWriteFailures`), never thrown into a run.
 *  - `reconcileOnStart` terminates every job left non-terminal by a previous process (cause `restart_recovery`): the request payload is not stored, so none of them can resume, and a
 *    node-side leftover workspace is destroyed by the node's own reaper/restart recovery. Reconcile BEFORE any retry (CLAUDE.md §4).
 *  - the kill switch is restored from the store at start (`hydrateKillSwitch`): if the store cannot be read the start FAILS (no execution with an unknown kill-switch state).
 */
export const DURABLE_STORE_FLAG = 'execution.durable_store';
/** default OFF: only an explicit, exact `true` turns it on */
export const durableExecutionEnabled = (flagValue: unknown): boolean => flagValue === true;

export interface JournalErrorReport {
  op: 'created' | 'moved' | 'killswitch' | 'reconcile';
  jobId?: string;
  reason: string;
}
const TERMINAL = new Set<string>(eg.JOB_TERMINAL);
const code = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 60) || 'unspecified';

export class PgExecutionJournal implements eg.ExecutionJournal {
  /** orchestrator job id -> durable job id (dropped once the job is terminal) */
  private readonly ids = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();
  private failureCount = 0;
  constructor(
    private readonly store: PgExecutionStore,
    private readonly onError: (r: JournalErrorReport) => void = () => undefined,
  ) {}

  failures(): number {
    return this.failureCount;
  }
  private fail(r: JournalErrorReport): void {
    this.failureCount++;
    try {
      this.onError(r);
    } catch {
      /* reporting must not throw into the run */
    }
  }

  async created(j: eg.JournalJob): Promise<eg.JournalCreated> {
    try {
      const r = await this.store.enqueue(
        {
          orgId: j.orgId,
          runId: j.runId,
          idempotencyKey: j.idempotencyKey,
          profile: j.profile,
          decisionDigest: j.decisionDigest,
          origin: j.origin,
          requiresApproval: j.requiresApproval,
          dataRegion: j.dataRegion,
        },
        'requested',
      );
      if (!r.created) return { ok: false, reason: 'idempotency_key_already_recorded' };
      this.ids.set(j.jobId, r.job.id);
      return { ok: true };
    } catch {
      this.fail({ op: 'created', jobId: j.jobId, reason: 'store_error' });
      return { ok: false, reason: 'journal_unavailable' };
    }
  }

  moved(m: eg.JournalMove): void {
    const prev = this.chains.get(m.jobId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const id = this.ids.get(m.jobId);
        if (!id) return; // recorded by another process, or its creation failed: nothing to move
        const patch = m.patch ? { ...m.patch, approvalId: undefined } : {}; // the orchestrator's approval ids are in-memory ids, not durable approval rows
        const r = await this.store.transition(m.orgId, id, m.to, m.cause, patch);
        if (!r.ok) this.fail({ op: 'moved', jobId: m.jobId, reason: r.reason });
        if (TERMINAL.has(m.to)) {
          this.ids.delete(m.jobId);
          if (this.chains.get(m.jobId) === next) this.chains.delete(m.jobId);
        }
      })
      .catch(() => this.fail({ op: 'moved', jobId: m.jobId, reason: 'store_error' }));
    this.chains.set(m.jobId, next);
  }

  /** wait for the write-behind queue (tests, orderly shutdown) */
  async drain(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /** terminate the jobs a previous process left open; returns counts. A store error is reported and rethrown: the caller must not start executing on an unreconciled store. */
  async reconcileOnStart(): Promise<{ terminated: number; skipped: number }> {
    let terminated = 0;
    let skipped = 0;
    try {
      for (const j of await this.store.openJobs()) {
        const r = await this.store.transition(j.orgId, j.id, 'terminated', 'restart_recovery', {
          outcomeStatus: 'terminated',
        });
        if (r.ok) terminated++;
        else skipped++;
      }
    } catch (e) {
      this.fail({ op: 'reconcile', reason: 'store_error' });
      throw e;
    }
    return { terminated, skipped };
  }

  /** the kill switch: the in-memory flag stays the hot-path check; every change is also appended to the store (write-behind, counted on failure) */
  createKillSwitch(): eg.JournaledKillSwitch {
    return new eg.JournaledKillSwitch((c) => {
      const scope =
        c.scope === 'global'
          ? ({ kind: 'global' } as const)
          : ({ kind: 'org', orgId: c.orgId! } as const);
      void this.store
        .setKillSwitch(scope, c.engaged, null, code(c.reason))
        .catch(() => this.fail({ op: 'killswitch', reason: 'store_error' }));
    });
  }
  /** restore engaged scopes at start; throws when the store cannot be read (fail closed: no start with an unknown kill-switch state) */
  async hydrateKillSwitch(ks: eg.JournaledKillSwitch): Promise<void> {
    ks.hydrate(await this.store.engagedScopes());
  }
}
