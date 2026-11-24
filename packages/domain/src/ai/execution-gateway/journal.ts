import type { JobState } from './lifecycle';
import { ExecutionKillSwitch } from './termination';

/**
 * P3-S02: the DURABLE JOURNAL port of the orchestrator. The orchestrator keeps running on its in-memory components (queue, ledger, approvals: fast, deterministic, fully tested);
 * with a journal attached it ALSO records every job and every state change to a durable store (the `execution` schema, `apps/api/src/modules/execution/internal/store.ts`), so job
 * history, outcomes and the kill switch survive a restart. Off by default: with no journal nothing changes.
 *
 * Contract (what the orchestrator relies on, what an implementation must keep):
 *  - `created` is AWAITED and FAIL-CLOSED: if the durable record cannot be written, the submit is refused (`journal_unavailable`); no unrecorded job ever runs.
 *  - `moved` is WRITE-BEHIND and must not throw: a transition is recorded in order per job; a failure is counted by the implementation (metric + audit), never blocks a run that already
 *    started (killing a live run because the audit database blinked would be worse), and is repaired by `reconcileOnStart`.
 *  - the journal never holds the request payload, command arguments, environment or output: only identifiers, the profile, the decision digest, state names, causes and outcome numbers.
 *
 * What this is NOT: a durable work queue. The queue payload (the request) is not stored, so a job that was queued or running when the process died cannot be resumed from the journal:
 * on start the implementation moves every non-terminal job to `terminated` (cause `restart_recovery`), after which the caller must submit again with a NEW idempotency key. That is the
 * restrictive, reversible choice (CLAUDE.md §11); a resumable queue needs the request stored under a vault-backed envelope and is a separate decision.
 */
export interface JournalJob {
  /** the orchestrator's own id for the job (`ej-<n>`); the journal maps it to its durable id */
  jobId: string;
  orgId: string;
  runId: string;
  idempotencyKey: string;
  profile: string;
  /** sha256 of the canonical decision (the approval binds to it) */
  decisionDigest: string;
  origin: 'MOCK' | 'REAL';
  requiresApproval: boolean;
  dataRegion: string;
}
export interface JournalPatch {
  outcomeStatus?: string;
  exitCode?: number | null;
  durationMs?: number;
  truncated?: boolean;
  artifactCount?: number;
  approvalId?: string;
}
export interface JournalMove {
  jobId: string;
  orgId: string;
  from: JobState;
  to: JobState;
  cause: string;
  at: string;
  patch?: JournalPatch;
}
export type JournalCreated = { ok: true } | { ok: false; reason: string };
export interface ExecutionJournal {
  created(j: JournalJob): Promise<JournalCreated>;
  moved(m: JournalMove): void;
}
/** the orchestrator's journal dependency: the sink and the organization's data region (residency: every journaled row carries it) */
export interface JournalDeps {
  sink: ExecutionJournal;
  dataRegion: (orgId: string) => string;
}

export interface KillSwitchChange {
  scope: 'global' | 'org';
  orgId?: string;
  engaged: boolean;
  reason: string;
}
/**
 * The same kill switch the orchestrator already uses, plus a change callback so the durable store records every engage/release (append-only history). The in-memory flag stays the
 * hot-path check; at start `hydrate` restores the latest durable state so a restart never silently releases a kill switch (CLAUDE.md §4: after an uncertain result, fail closed).
 */
export class JournaledKillSwitch extends ExecutionKillSwitch {
  constructor(private readonly onChange: (c: KillSwitchChange) => void) {
    super();
  }
  override engageGlobal(reason: string): void {
    super.engageGlobal(reason);
    this.onChange({ scope: 'global', engaged: true, reason });
  }
  override engageOrg(orgId: string, reason: string): void {
    super.engageOrg(orgId, reason);
    this.onChange({ scope: 'org', orgId, engaged: true, reason });
  }
  override releaseGlobal(): void {
    super.releaseGlobal();
    this.onChange({ scope: 'global', engaged: false, reason: 'released' });
  }
  override releaseOrg(orgId: string): void {
    super.releaseOrg(orgId);
    this.onChange({ scope: 'org', orgId, engaged: false, reason: 'released' });
  }
  /** restore engaged scopes from the durable store WITHOUT writing them back (no callback) */
  hydrate(state: { global: boolean; orgs: readonly string[] }): void {
    if (state.global) ExecutionKillSwitch.prototype.engageGlobal.call(this, 'restored_from_store');
    for (const o of state.orgs)
      ExecutionKillSwitch.prototype.engageOrg.call(this, o, 'restored_from_store');
  }
}
