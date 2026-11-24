import {
  planCleanup,
  type CleanupAction,
  type CleanupPolicy,
  type WorkspaceRecord,
  DEFAULT_CLEANUP_POLICY,
} from './cleanup';
import { StateTrack, transitionWorkspace, type JobState, type WorkspaceState } from './lifecycle';

/**
 * S-AG6 (OFFLINE): the per-run workspace registry. One workspace per RUN: a run id is never given a second workspace, not even after the first was destroyed, and a workspace
 * belongs to one organization for its whole life (nothing is reused across runs or organizations). State changes go through the lifecycle table; `reap` executes a cleanup plan
 * through a port, retrying failures on the next pass (a workspace that cannot be destroyed stays `failed` and is reported, never silently dropped).
 */
export interface WorkspaceReapPorts {
  destroy(w: { id: string; orgId: string; runId: string }): Promise<void>;
  audit?(e: {
    workspaceId: string;
    orgId: string;
    runId: string;
    reason: string;
    ok: boolean;
  }): void | Promise<void>;
}
interface Entry {
  rec: WorkspaceRecord;
  track: StateTrack<WorkspaceState>;
}
export class WorkspaceRegistry {
  private readonly byId = new Map<string, Entry>();
  private readonly runs = new Set<string>();
  private seq = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}

  create(
    orgId: string,
    runId: string,
    jobId: string | null = null,
  ): { ok: true; id: string } | { ok: false; reason: string } {
    const key = `${orgId}\u0000${runId}`;
    if (this.runs.has(key)) return { ok: false, reason: 'workspace_already_created_for_run' };
    this.runs.add(key);
    const id = `ws-${runId}-${++this.seq}`;
    const t = this.now();
    this.byId.set(id, {
      rec: {
        id,
        orgId,
        runId,
        state: 'creating',
        createdAt: t,
        lastActivityAt: t,
        jobId,
        jobState: null,
        jobEndedAt: null,
      },
      track: new StateTrack<WorkspaceState>(
        'creating',
        transitionWorkspace,
        () => new Date(this.now()),
      ),
    });
    return { ok: true, id };
  }
  /** tenant-scoped: another organization's workspace id is "unknown" */
  private entry(id: string, orgId: string): Entry | undefined {
    const e = this.byId.get(id);
    return e && e.rec.orgId === orgId ? e : undefined;
  }
  move(
    id: string,
    orgId: string,
    to: WorkspaceState,
    cause: string,
  ): { ok: boolean; reason?: string } {
    const e = this.entry(id, orgId);
    if (!e) return { ok: false, reason: 'unknown_workspace' };
    const r = e.track.move(to, cause);
    if (!r.ok) return { ok: false, reason: r.reason };
    e.rec.state = to;
    e.rec.lastActivityAt = this.now();
    return { ok: true };
  }
  /** the owning job's state, so the cleanup planner can tell an ended job from a live one */
  setJob(id: string, orgId: string, jobId: string, jobState: JobState, ended: boolean): void {
    const e = this.entry(id, orgId);
    if (!e) return;
    e.rec.jobId = jobId;
    e.rec.jobState = jobState;
    if (ended && e.rec.jobEndedAt === null) e.rec.jobEndedAt = this.now();
  }
  get(id: string, orgId: string): WorkspaceRecord | undefined {
    return this.entry(id, orgId)?.rec;
  }
  records(): WorkspaceRecord[] {
    return [...this.byId.values()].map((e) => ({ ...e.rec }));
  }
  plan(policy: CleanupPolicy = DEFAULT_CLEANUP_POLICY): CleanupAction[] {
    return planCleanup(this.records(), this.now(), policy);
  }
  /** Execute the plan: destroying -> destroyed on success; a failure leaves the workspace `failed` (retried by the next pass). */
  async reap(
    ports: WorkspaceReapPorts,
    policy: CleanupPolicy = DEFAULT_CLEANUP_POLICY,
  ): Promise<{ destroyed: number; failed: number }> {
    let destroyed = 0;
    let failed = 0;
    for (const a of this.plan(policy)) {
      const e = this.byId.get(a.workspaceId)!;
      if (e.rec.state !== 'destroying') e.track.move('destroying', a.reason);
      e.rec.state = e.track.state;
      let ok = true;
      try {
        await ports.destroy({ id: a.workspaceId, orgId: a.orgId, runId: a.runId });
        e.track.move('destroyed', a.reason);
      } catch {
        ok = false;
        e.track.move('failed', 'destroy_failed');
      }
      e.rec.state = e.track.state;
      if (ok) destroyed++;
      else failed++;
      await ports.audit?.({
        workspaceId: a.workspaceId,
        orgId: a.orgId,
        runId: a.runId,
        reason: a.reason,
        ok,
      });
    }
    return { destroyed, failed };
  }
}
