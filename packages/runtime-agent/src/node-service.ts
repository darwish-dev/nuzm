import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executionGateway as eg } from '@nuzm/domain';
import type { AuditSink } from './audit';
import type { AgentConfig } from './config';
import { LaunchRefused, type Launched, type Launcher, type LaunchResult } from './launcher';
import type { Metrics } from './metrics';
import { WorkspaceError, type WorkspaceStore } from './workspace-store';

/**
 * THE AGENT CORE: one method per node-protocol operation. It is the node's SECOND LINE OF DEFENCE: it re-validates every spec (`validateRuntimeSpec`) and then holds it to the
 * node's own configuration (attested image only, the constant environment, the node's resource ceilings, its egress allow-list, its sandbox uid), binds every call to the tenant the
 * token names, enforces limits itself (a monitor plus a wall-clock backstop; the control plane kills first, the agent is the backstop), and never trusts the launcher's silence: a
 * run whose stats cannot be read is killed.
 *
 * It never starts a process itself; the `Launcher` does, and the real launcher can only act through the `CommandRunner` that refuses anywhere but the attested Linux node.
 */
export class NodeError extends Error {
  constructor(
    readonly code: eg.NodeErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}:${detail}` : code);
    this.name = 'NodeError';
  }
}
/** who is calling, as established by the verified token (never by the body) */
export interface Caller {
  orgId?: string;
}
interface Run {
  handle: string;
  orgId: string;
  runId: string;
  workspaceId: string;
  spec: eg.RuntimeSpec;
  launched: Launched;
  startedAt: number;
  result: (LaunchResult & { durationMs: number }) | null;
  resultP: Promise<LaunchResult & { durationMs: number }>;
  killedBy: string | null;
  lastStats: eg.NodeStats;
  timers: ReturnType<typeof setTimeout>[];
  monitor: ReturnType<typeof setInterval> | null;
  finalStats: eg.NodeStats | null;
}
export interface NodeServiceOptions {
  config: AgentConfig;
  store: WorkspaceStore;
  launcher: Launcher;
  /** digest -> rootfs dir, ALREADY verified (`image.ts`); the agent never starts an image outside this map */
  images: Readonly<Record<string, string>>;
  audit: AuditSink;
  metrics: Metrics;
  now?: () => number;
  /** monitor period (ms) */
  monitorMs?: number;
  /** free MiB on the workspace volume (injectable for tests) */
  freeDiskMb?: () => Promise<number>;
  agentVersion?: string;
}
const ZERO: eg.NodeStats = { cpuSeconds: 0, memoryMb: 0, pids: 0, diskMb: 0, outputBytes: 0 };
const DISABLED_FILE = 'DISABLED';

export class NodeService {
  private readonly runs = new Map<string, Run>();
  /** runs whose cleanup failed: kept so `reap` retries and `health` reports the node unhealthy */
  private readonly leaked = new Map<string, Run>();
  private readonly now: () => number;
  private readonly cfg: AgentConfig;

  constructor(private readonly o: NodeServiceOptions) {
    this.cfg = o.config;
    this.now = o.now ?? (() => Date.now());
    const m = o.metrics;
    m.gauge('nuzm_agent_runs_active', () => this.runs.size);
    m.gauge('nuzm_agent_runs_leaked', () => this.leaked.size);
    m.gauge('nuzm_agent_max_slots', () => this.cfg.maxSlots);
    m.gauge('nuzm_agent_oldest_run_age_seconds', () => {
      let oldest = 0;
      for (const r of this.runs.values()) oldest = Math.max(oldest, (this.now() - r.startedAt) / 1000);
      return Math.floor(oldest);
    });
  }

  // ---------------------------------------------------------------- state
  private disabledPath(): string {
    return join(this.cfg.stateDir, DISABLED_FILE);
  }
  async isDisabled(): Promise<boolean> {
    return (await lstat(this.disabledPath()).catch(() => null)) !== null;
  }
  /** an operator removes the node-local flag by hand (or the runbook's command) after an incident review; nothing in the agent clears it */
  private async disable(): Promise<void> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(this.disabledPath(), `disabled ${new Date(this.now()).toISOString()}\n`, { mode: 0o600 });
  }
  activeCount(): number {
    return this.runs.size;
  }

  private authorize(caller: Caller, orgId: string, cleanup = false): void {
    if (caller.orgId !== undefined) {
      if (caller.orgId !== orgId) throw new NodeError('forbidden');
    } else if (!cleanup) throw new NodeError('forbidden');
  }
  private async requireWorkspace(id: string, caller: Caller, cleanup = false) {
    const meta = await this.o.store.meta(id);
    if (!meta) throw new NodeError('unknown_workspace');
    this.authorize(caller, meta.orgId, cleanup);
    return meta;
  }
  private runOf(handle: string, caller: Caller, cleanup = false): Run {
    const r = this.runs.get(handle);
    if (!r) throw new NodeError('unknown_handle');
    this.authorize(caller, r.orgId, cleanup);
    return r;
  }
  private activeIn(workspaceId: string): Run | undefined {
    for (const r of this.runs.values()) if (r.workspaceId === workspaceId) return r;
    return undefined;
  }
  /** a run that has NOT ended: the workspace is in use and its files are in flux (a finished, not yet destroyed run leaves its files readable for artifact extraction) */
  private runningIn(workspaceId: string): Run | undefined {
    for (const r of this.runs.values()) if (r.workspaceId === workspaceId && r.result === null) return r;
    return undefined;
  }
  private event(type: Parameters<AuditSink['write']>[0]['type'], r?: Partial<Run> & { orgId?: string }, detail?: Record<string, string | number | boolean>) {
    void this.o.audit.write({ type, orgId: r?.orgId, runId: r?.runId, workspaceId: r?.workspaceId, handle: r?.handle, detail });
  }

  // ---------------------------------------------------------------- operations
  async identity() {
    return {
      nodeId: this.cfg.nodeId,
      endpointId: this.cfg.endpointId,
      runtimeClass: this.cfg.runtimeClass,
      imageDigests: Object.keys(this.o.images).sort(),
      agentVersion: this.o.agentVersion ?? '0.0.0',
      protocol: eg.NODE_PROTOCOL_VERSION,
    };
  }

  async health(): Promise<eg.NodeResponseMap['health']> {
    const t0 = this.now();
    let note = '';
    if (await this.isDisabled()) note = 'node_disabled';
    else if (this.leaked.size > 0) note = 'leaked_runs';
    else {
      const l = await this.o.launcher.health();
      if (!l.ok) note = l.note ?? 'launcher_unhealthy';
      else {
        const free = await (this.o.freeDiskMb ?? (() => this.defaultFreeMb()))().catch(() => -1);
        if (free >= 0 && free < this.cfg.minFreeDiskMb) note = 'disk_low';
        else if (free < 0) note = 'disk_unknown';
      }
    }
    const ok = note === '';
    return {
      ok,
      latencyMs: Math.max(0, this.now() - t0),
      freeSlots: ok ? Math.max(0, this.cfg.maxSlots - this.runs.size) : 0,
      ...(ok ? { note: this.o.launcher.kind === 'simulated' ? 'simulated' : undefined } : { note }),
    };
  }
  private async defaultFreeMb(): Promise<number> {
    const s = await statfs(this.cfg.workspaceRoot);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  }

  async createWorkspace(w: eg.WorkspaceSpec, caller: Caller): Promise<void> {
    if (await this.isDisabled()) throw new NodeError('node_disabled');
    this.authorize(caller, w.orgId);
    try {
      await this.o.store.create(w);
    } catch (e) {
      throw this.mapStoreError(e);
    }
    this.o.metrics.inc('nuzm_agent_workspaces_created_total');
    this.event('workspace_created', { orgId: w.orgId, runId: w.runId, workspaceId: w.workspaceId });
  }
  async putFiles(id: string, files: readonly (readonly [string, string])[], caller: Caller): Promise<void> {
    await this.requireWorkspace(id, caller);
    if (this.activeIn(id)) throw new NodeError('conflict');
    try {
      await this.o.store.putFiles(id, files);
    } catch (e) {
      throw this.mapStoreError(e);
    }
  }
  private mapStoreError(e: unknown): NodeError {
    if (e instanceof NodeError) return e;
    if (e instanceof WorkspaceError) {
      const known = new Set<string>(eg.NODE_ERROR_CODES);
      return new NodeError(known.has(e.code) ? (e.code as eg.NodeErrorCode) : 'internal');
    }
    return new NodeError('internal');
  }

  /** everything the node holds a spec to, beyond the gateway's own baseline */
  specViolations(spec: eg.RuntimeSpec, wsDiskMb: number): string[] {
    const v = eg.validateRuntimeSpec(spec);
    if (spec.runtimeClass !== this.cfg.runtimeClass) v.push('runtime_class_not_this_node');
    if (!eg.checkRunEnv(spec.env).ok) v.push('environment_not_the_constant');
    if (spec.user.uid !== this.cfg.sandboxUid || spec.user.gid !== this.cfg.sandboxGid) v.push('sandbox_user_mismatch');
    for (const k of ['cpuSeconds', 'wallSeconds', 'memoryMb', 'pids', 'outputKb', 'diskMb'] as const)
      if (spec.limits[k] > this.cfg.ceilings[k]) v.push(`limit_over_node_ceiling_${k}`);
    if (spec.limits.diskMb > wsDiskMb) v.push('limit_disk_over_workspace_quota');
    if (!(spec.cwd === '/work' || spec.cwd.startsWith('/work/')) || spec.cwd.split('/').includes('..')) v.push('cwd_invalid');
    const allow = new Set(this.cfg.egress.allowHosts);
    for (const e of spec.egressAllow) if (!allow.has(e.host)) v.push('egress_not_on_node_allowlist');
    if (spec.mounts.length !== 3 || !['workspace', 'scratch', 'toolchain'].every((s) => spec.mounts.some((m) => m.source === s)))
      v.push('mounts_not_the_standard_three');
    if (spec.argv[0] === undefined || spec.argv[0] === '' || spec.argv.some((a) => a.includes('\0'))) v.push('argv_invalid');
    return [...new Set(v)];
  }

  async start(spec: eg.RuntimeSpec, caller: Caller): Promise<{ handle: string }> {
    if (await this.isDisabled()) throw new NodeError('node_disabled');
    this.authorize(caller, spec.orgId);
    const ws = await this.o.store.meta(spec.workspaceId);
    if (!ws) throw new NodeError('unknown_workspace');
    if (ws.orgId !== spec.orgId || ws.runId !== spec.runId) throw new NodeError('workspace_tenant_mismatch');
    const violations = this.specViolations(spec, ws.diskMb);
    if (violations.length > 0) {
      this.o.metrics.inc('nuzm_agent_spec_refused_total');
      this.event('spec_refused', { orgId: spec.orgId, runId: spec.runId, workspaceId: spec.workspaceId }, { count: violations.length });
      throw new NodeError('spec_refused', violations.join(','));
    }
    const rootfs = Object.prototype.hasOwnProperty.call(this.o.images, spec.image) ? this.o.images[spec.image] : undefined;
    if (!rootfs) throw new NodeError('image_not_attested');
    if (this.activeIn(spec.workspaceId)) throw new NodeError('conflict');
    if (this.runs.size >= this.cfg.maxSlots) throw new NodeError('no_capacity');

    const handle = `h-${randomBytes(8).toString('hex')}`;
    const d = this.o.store.dirs(spec.workspaceId);
    let launched: Launched;
    try {
      launched = await this.o.launcher.launch({
        spec,
        handle,
        workDir: d.work,
        scratchDir: d.scratch,
        rootfs,
        toolchainDir: this.cfg.toolchainDir,
        maxOutputBytes: spec.limits.outputKb * 1024,
      });
    } catch (e) {
      if (e instanceof LaunchRefused) throw new NodeError(e.code);
      throw new NodeError('platform_refused');
    }
    const startedAt = this.now();
    const run: Run = {
      handle,
      orgId: spec.orgId,
      runId: spec.runId,
      workspaceId: spec.workspaceId,
      spec,
      launched,
      startedAt,
      result: null,
      resultP: null as unknown as Run['resultP'],
      killedBy: null,
      lastStats: { ...ZERO },
      timers: [],
      monitor: null,
      finalStats: null,
    };
    run.resultP = launched.done.then(async (r) => {
      const res = { ...r, durationMs: r.durationMs ?? this.now() - startedAt };
      run.result = res;
      for (const t of run.timers) clearTimeout(t);
      if (run.monitor) clearInterval(run.monitor);
      run.finalStats = await launched.stats().catch(() => run.lastStats);
      if (r.endedBy === 'output_flood') {
        run.killedBy ??= 'output_flood';
        this.o.metrics.inc('nuzm_agent_runs_killed_total', 1, 'output_flood');
        this.event('run_flood_kill', run);
      }
      this.o.metrics.inc('nuzm_agent_runs_finished_total');
      this.event('run_finished', run, { killed: run.killedBy ?? 'none' });
      return res;
    });
    this.runs.set(handle, run);
    this.o.metrics.inc('nuzm_agent_runs_started_total');
    this.event('run_started', run);

    // wall-clock BACKSTOP: the control plane kills at the wall limit; the agent kills a little later on its own (soft, then hard)
    const wallMs = spec.limits.wallSeconds * 1000 + this.cfg.killGraceMs;
    run.timers.push(setTimeout(() => this.killInternal(run, 'soft', 'wall_backstop'), wallMs));
    run.timers.push(setTimeout(() => this.killInternal(run, 'hard', 'wall_backstop'), wallMs + this.cfg.killGraceMs));
    // resource monitor: sample, and kill what crosses a limit or cannot be observed
    let blind = 0;
    run.monitor = setInterval(() => {
      void (async () => {
        if (run.result) return;
        try {
          const s = await launched.stats();
          const disk = await this.o.store.usage(spec.workspaceId).catch(() => ({ diskMb: 0, inodes: 0 }));
          run.lastStats = { ...s, diskMb: Math.max(s.diskMb, disk.diskMb) };
          blind = 0;
          const viol = eg.evaluateUsage(spec.limits, { ...run.lastStats, wallMs: 0 }).filter((x) => x.action === 'kill');
          if (viol.length > 0) {
            this.o.metrics.inc('nuzm_agent_runs_killed_total', 1, `limit_${viol[0]!.resource}`);
            this.event('run_limit_kill', run, { resource: viol[0]!.resource });
            this.killInternal(run, 'hard', `limit_${viol[0]!.resource}`);
          }
        } catch {
          // an unobservable run is not trusted: five missed samples in a row end it
          if (++blind >= 5) this.killInternal(run, 'hard', 'unobservable');
        }
      })();
    }, this.o.monitorMs ?? 1_000);
    run.monitor.unref?.();
    for (const t of run.timers) t.unref?.();
    return { handle };
  }
  private killInternal(run: Run, how: 'soft' | 'hard', why: string): void {
    if (run.result) return;
    run.killedBy ??= why;
    this.event('run_killed', run, { how, why });
    void run.launched.kill(how).catch(() => undefined);
  }

  async wait(handle: string, maxWaitMs: number, caller: Caller): Promise<eg.NodeResponseMap['wait']> {
    const run = this.runOf(handle, caller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slice = new Promise<'slice'>((resolve) => {
      timer = setTimeout(() => resolve('slice'), maxWaitMs);
    });
    try {
      const r = await Promise.race([run.resultP, slice]);
      if (r === 'slice') return { done: false };
      return {
        done: true,
        result: { exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, durationMs: r.durationMs },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async stats(handle: string, caller: Caller): Promise<eg.NodeStats> {
    const run = this.runOf(handle, caller);
    if (run.finalStats) return run.finalStats;
    try {
      const s = await run.launched.stats();
      const disk = await this.o.store.usage(run.workspaceId).catch(() => ({ diskMb: 0, inodes: 0 }));
      run.lastStats = { ...s, diskMb: Math.max(s.diskMb, disk.diskMb) };
    } catch {
      /* the last known sample stands */
    }
    return run.lastStats;
  }
  async kill(handle: string, how: 'soft' | 'hard', caller: Caller): Promise<void> {
    const run = this.runs.get(handle);
    if (!run) return; // killing an unknown run is a no-op, like the simulated node
    this.authorize(caller, run.orgId, true);
    this.killInternal(run, how, 'control_plane');
    this.o.metrics.inc('nuzm_agent_runs_killed_total', 1, 'control_plane');
  }
  async destroy(handle: string, caller: Caller): Promise<void> {
    const run = this.runs.get(handle);
    if (!run) return;
    this.authorize(caller, run.orgId, true);
    await this.teardownRun(run);
  }
  /** hard-kill if needed, wait for the end (bounded), remove everything the launcher made. On failure the run is KEPT as leaked (node unhealthy until `reap` clears it). */
  private async teardownRun(run: Run): Promise<void> {
    this.killInternal(run, 'hard', 'destroy');
    await Promise.race([run.resultP.catch(() => undefined), new Promise((r) => setTimeout(r, 10_000).unref?.())]);
    for (const t of run.timers) clearTimeout(t);
    if (run.monitor) clearInterval(run.monitor);
    try {
      await run.launched.cleanup();
    } catch {
      this.runs.delete(run.handle);
      this.leaked.set(run.handle, run);
      this.o.metrics.inc('nuzm_agent_cleanup_failed_total');
      this.event('workspace_destroy_failed', run, { stage: 'launcher' });
      throw new NodeError('destroy_failed');
    }
    this.runs.delete(run.handle);
    this.leaked.delete(run.handle);
  }

  async listProduced(id: string, caller: Caller): Promise<eg.ProducedFile[]> {
    await this.requireWorkspace(id, caller);
    if (this.runningIn(id)) throw new NodeError('conflict');
    try {
      return (await this.o.store.listProduced(id)).map((f) => ({ path: f.path, bytes: f.bytes, kind: f.kind }));
    } catch (e) {
      throw this.mapStoreError(e);
    }
  }
  async readProduced(id: string, path: string, maxBytes: number, caller: Caller): Promise<string> {
    await this.requireWorkspace(id, caller);
    if (this.runningIn(id)) throw new NodeError('conflict');
    try {
      return await this.o.store.readProduced(id, path, maxBytes);
    } catch (e) {
      throw this.mapStoreError(e);
    }
  }
  async destroyWorkspace(id: string, caller: Caller): Promise<void> {
    const meta = await this.o.store.meta(id);
    if (!meta) {
      if (await this.o.store.exists(id)) {
        // a directory without a readable record: an operator-scoped cleanup path removes it; a tenant call may not touch it
        if (caller.orgId !== undefined) throw new NodeError('forbidden');
      } else return; // already gone: idempotent
    } else this.authorize(caller, meta.orgId, true);
    const active = this.activeIn(id);
    if (active) await this.teardownRun(active);
    try {
      await this.o.store.destroy(id);
    } catch {
      this.o.metrics.inc('nuzm_agent_cleanup_failed_total');
      this.event('workspace_destroy_failed', { orgId: meta?.orgId, workspaceId: id }, { stage: 'workspace' });
      throw new NodeError('destroy_failed');
    }
    this.o.metrics.inc('nuzm_agent_workspaces_destroyed_total');
    this.event('workspace_destroyed', { orgId: meta?.orgId, runId: meta?.runId, workspaceId: id });
  }
  async listWorkspaces(): Promise<eg.NodeResponseMap['listWorkspaces']['workspaces']> {
    return (await this.o.store.list()).map((m) => ({ workspaceId: m.workspaceId, orgId: m.orgId, runId: m.runId, createdAt: m.createdAt }));
  }

  // ---------------------------------------------------------------- operator paths (admin-scoped tokens)
  /** the node's kill switch: refuse new work for good, kill every run, destroy every workspace, kill stray sandboxes. The flag stays until an operator removes it. */
  async emergencyStop(): Promise<{ killed: number; destroyed: number; failed: number }> {
    await this.disable();
    this.o.metrics.inc('nuzm_agent_emergency_stops_total');
    this.event('node_disabled');
    let killed = 0;
    let destroyed = 0;
    let failed = 0;
    for (const run of [...this.runs.values()]) {
      killed++;
      await this.teardownRun(run).catch(() => {
        failed++;
      });
    }
    for (const m of await this.o.store.list()) {
      await this.o.store.destroy(m.workspaceId).then(
        () => destroyed++,
        () => failed++,
      );
    }
    for (const n of await this.o.store.strays()) {
      await this.o.store.destroy(n).then(
        () => destroyed++,
        () => failed++,
      );
    }
    const stray = await this.o.launcher.listStray(new Set(this.runs.keys()));
    if (stray.length > 0) killed += await this.o.launcher.killStray(stray);
    this.event('emergency_stop', undefined, { killed, destroyed, failed });
    return { killed, destroyed, failed };
  }
  /** orphan and leak reaping: retry failed cleanups, destroy aged workspaces with no live run, kill stray sandboxes, remove half-created directories */
  async reap(): Promise<{ reaped: number; failed: number }> {
    let reaped = 0;
    let failed = 0;
    for (const run of [...this.leaked.values()]) {
      try {
        await run.launched.cleanup();
        this.leaked.delete(run.handle);
        reaped++;
      } catch {
        failed++;
      }
    }
    const nowMs = this.now();
    for (const m of await this.o.store.list()) {
      if (this.activeIn(m.workspaceId)) continue;
      if (nowMs - m.createdAt < this.cfg.workspaceMaxAgeMs) continue;
      await this.o.store.destroy(m.workspaceId).then(
        () => {
          reaped++;
          this.event('reaped', { orgId: m.orgId, runId: m.runId, workspaceId: m.workspaceId }, { reason: 'aged' });
        },
        () => failed++,
      );
    }
    const strayDirs = await this.o.store.strays();
    for (const n of strayDirs) {
      if (this.activeIn(n)) continue;
      // a directory without a record may be a workspace being created right now: only reap it once it is clearly abandoned
      const st = await lstat(this.o.store.dirs(n).base).catch(() => null);
      if (!st || nowMs - st.mtimeMs < 120_000) continue;
      await this.o.store.destroy(n).then(
        () => reaped++,
        () => failed++,
      );
    }
    const stray = await this.o.launcher.listStray(new Set(this.runs.keys()));
    if (stray.length > 0) {
      const n = await this.o.launcher.killStray(stray);
      reaped += n;
      failed += stray.length - n;
      this.o.metrics.inc('nuzm_agent_stray_killed_total', n);
      this.event('stray_killed', undefined, { count: n });
    }
    this.o.metrics.inc('nuzm_agent_reaped_total', reaped);
    return { reaped, failed };
  }
  /** startup recovery: no run survives an agent restart, so kill every sandbox the node still has; workspaces stay for the control plane's reaper to see */
  async recoverOnStart(): Promise<{ strayKilled: number }> {
    const stray = await this.o.launcher.listStray(new Set());
    const n = stray.length > 0 ? await this.o.launcher.killStray(stray) : 0;
    if (n > 0) this.event('stray_killed', undefined, { count: n, stage: 'startup' });
    return { strayKilled: n };
  }
  /** stop the timers of every live run (process shutdown) without destroying anything */
  shutdown(): void {
    for (const r of this.runs.values()) {
      for (const t of r.timers) clearTimeout(t);
      if (r.monitor) clearInterval(r.monitor);
    }
  }
}
// `rm` is imported for operators' manual use in tests that need to clear the DISABLED flag
export const clearDisabledFlag = async (stateDir: string): Promise<void> => {
  await rm(join(stateDir, DISABLED_FILE), { force: true });
};
