import { validateRuntimeSpec, type ExecutionRuntime, type RuntimeSpec } from '../runtime-spec';
import type { ProducedFile } from '../artifacts';

/**
 * S-AG6 PHASE 2 (OFFLINE): the wire-level contract of a runtime NODE (the agent that runs on a dedicated, attested Linux node) as the control plane sees it. It extends the
 * M10-era `ExecutionRuntime` (start, wait, stats, kill, destroy, health) with the workspace operations a real run needs: node identity, workspace creation with a disk quota,
 * file upload, produced-file listing and bounded artifact reads. The control plane never sends an argv of its own: `start` takes a `RuntimeSpec` built by `buildRuntimeSpec`
 * from an ALLOWED gateway decision, and the node validates it again (`validateRuntimeSpec`) because the node is the second line of defence.
 *
 * `SimulatedWorkspaceRuntime` is the only implementation in this repository. It starts NO process, opens no socket and touches no file: its "output" is what a test scripted.
 * It reports `isolation: 'simulated'` and can never be evidence for an isolation control. The real node agent (dedicated Linux node, gVisor / Kata / Firecracker) is
 * SECURITY-BLOCKED (D-21, HG-10-02) and EXTERNAL-BLOCKED (HG-05-04).
 */
export interface RuntimeIdentity {
  nodeId: string;
  endpointId: string;
  runtimeClass: string;
  imageDigests: readonly string[];
}
export interface WorkspaceSpec {
  workspaceId: string;
  orgId: string;
  runId: string;
  diskMb: number;
}
export interface WaitResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}
export interface WorkspaceRuntime extends ExecutionRuntime {
  identity(): Promise<RuntimeIdentity>;
  createWorkspace(w: WorkspaceSpec): Promise<void>;
  putFiles(workspaceId: string, files: ReadonlyMap<string, string>): Promise<void>;
  /** everything the run left in its output roots, with kinds (links and devices are reported, never followed) */
  listProduced(workspaceId: string): Promise<ProducedFile[]>;
  /** a bounded read of one regular file: the node refuses a link, a path outside the workspace and more than `maxBytes` */
  readProduced(workspaceId: string, path: string, maxBytes: number): Promise<string>;
  /** idempotent: removes the workspace and everything in it; throws only if it could not */
  destroyWorkspace(workspaceId: string): Promise<void>;
}

export interface SimulatedBehavior {
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  /** files the simulated run "produced" */
  produced?: ProducedFile[];
  /** content served by `readProduced` for a produced path */
  producedContent?: Record<string, string>;
  /** the run never ends by itself: it ends only when killed (simulates a timeout or a runaway) */
  hang?: boolean;
  /** peak figures reported by `stats` */
  stats?: Partial<{
    cpuSeconds: number;
    memoryMb: number;
    pids: number;
    diskMb: number;
    outputBytes: number;
  }>;
  /** cleanup fails (the workspace stays): the control plane must quarantine the node */
  destroyFails?: boolean;
}
export type SimulatedScript = (
  spec: RuntimeSpec,
  files: ReadonlyMap<string, string>,
) => SimulatedBehavior;

interface SimWorkspace {
  spec: WorkspaceSpec;
  files: Map<string, string>;
  produced: ProducedFile[];
  content: Record<string, string>;
  destroyFails: boolean;
}
interface SimRun {
  spec: RuntimeSpec;
  behavior: SimulatedBehavior;
  killed: 'soft' | 'hard' | null;
  release: (() => void) | null;
  finished: boolean;
}

export class SimulatedWorkspaceRuntime implements WorkspaceRuntime {
  readonly isolation = 'simulated' as const;
  readonly runtimeClass: string;
  /** every spec the node accepted (tests assert on it) */
  readonly accepted: RuntimeSpec[] = [];
  /** every spec the node refused, with the violation codes */
  readonly refusedSpecs: { workspaceId: string; violations: string[] }[] = [];
  private readonly workspaces = new Map<string, SimWorkspace>();
  private readonly runs = new Map<string, SimRun>();
  private seq = 0;
  private healthy = true;
  private script: SimulatedScript = () => ({});

  constructor(
    private readonly ident: RuntimeIdentity,
    private readonly maxSlots = 4,
  ) {
    this.runtimeClass = ident.runtimeClass;
  }
  /** what the next runs do (default: exit 0, no output) */
  setScript(s: SimulatedScript): this {
    this.script = s;
    return this;
  }
  setHealthy(ok: boolean): this {
    this.healthy = ok;
    return this;
  }
  liveWorkspaces(): string[] {
    return [...this.workspaces.keys()];
  }
  liveRuns(): string[] {
    return [...this.runs.entries()].filter(([, r]) => !r.finished).map(([h]) => h);
  }
  async identity(): Promise<RuntimeIdentity> {
    return { ...this.ident, imageDigests: [...this.ident.imageDigests] };
  }
  async createWorkspace(w: WorkspaceSpec): Promise<void> {
    if (this.workspaces.has(w.workspaceId)) throw new Error('workspace_exists');
    if (!w.workspaceId.includes(w.runId)) throw new Error('workspace_not_bound_to_run');
    if (!(w.diskMb > 0)) throw new Error('disk_quota_missing');
    this.workspaces.set(w.workspaceId, {
      spec: w,
      files: new Map(),
      produced: [],
      content: {},
      destroyFails: false,
    });
  }
  async putFiles(workspaceId: string, files: ReadonlyMap<string, string>): Promise<void> {
    const ws = this.mustWorkspace(workspaceId);
    for (const [p, c] of files) {
      if (p.startsWith('/') || p.split('/').includes('..'))
        throw new Error('path_escapes_workspace');
      ws.files.set(p, c);
    }
  }
  async start(spec: RuntimeSpec): Promise<{ handle: string }> {
    const ws = this.mustWorkspace(spec.workspaceId);
    const violations = validateRuntimeSpec(spec);
    if (ws.spec.orgId !== spec.orgId || ws.spec.runId !== spec.runId)
      violations.push('workspace_tenant_mismatch');
    if (violations.length > 0) {
      this.refusedSpecs.push({ workspaceId: spec.workspaceId, violations });
      throw new Error(`spec_refused:${violations.join(',')}`);
    }
    if (this.liveRuns().length >= this.maxSlots) throw new Error('no_capacity');
    const handle = `sim-${++this.seq}`;
    const behavior = this.script(spec, ws.files);
    ws.produced = behavior.produced ?? [];
    ws.content = behavior.producedContent ?? {};
    ws.destroyFails = behavior.destroyFails === true;
    this.accepted.push(spec);
    this.runs.set(handle, { spec, behavior, killed: null, release: null, finished: false });
    return { handle };
  }
  async wait(handle: string): Promise<WaitResult> {
    const run = this.mustRun(handle);
    if (run.behavior.hang && !run.killed)
      await new Promise<void>((resolve) => {
        run.release = resolve;
      });
    run.finished = true;
    if (run.killed)
      return {
        exitCode: null,
        signal: run.killed === 'hard' ? 'SIGKILL' : 'SIGTERM',
        stdout: run.behavior.stdout ?? '',
        stderr: run.behavior.stderr ?? '',
        truncated: false,
        durationMs: run.behavior.durationMs ?? 0,
      };
    const b = run.behavior;
    return {
      exitCode: b.exitCode === undefined ? 0 : b.exitCode,
      signal: b.signal ?? null,
      stdout: b.stdout ?? '',
      stderr: b.stderr ?? '',
      truncated: false,
      durationMs: b.durationMs ?? 1,
    };
  }
  async stats(handle: string) {
    const s = this.mustRun(handle).behavior.stats ?? {};
    return {
      cpuSeconds: s.cpuSeconds ?? 0,
      memoryMb: s.memoryMb ?? 0,
      pids: s.pids ?? 0,
      diskMb: s.diskMb ?? 0,
      outputBytes: s.outputBytes ?? 0,
    };
  }
  async kill(handle: string, how: 'soft' | 'hard'): Promise<void> {
    const run = this.runs.get(handle);
    if (!run) return;
    run.killed = how === 'hard' || run.killed === 'hard' ? 'hard' : 'soft';
    run.release?.();
  }
  async destroy(handle: string): Promise<void> {
    const run = this.runs.get(handle);
    if (run) {
      run.killed = 'hard';
      run.finished = true;
      run.release?.();
    }
    this.runs.delete(handle);
  }
  async health() {
    return {
      ok: this.healthy,
      latencyMs: 1,
      freeSlots: this.healthy ? Math.max(0, this.maxSlots - this.liveRuns().length) : 0,
      note: 'simulated',
    };
  }
  async listProduced(workspaceId: string): Promise<ProducedFile[]> {
    return this.mustWorkspace(workspaceId).produced.map((p) => ({ ...p }));
  }
  async readProduced(workspaceId: string, path: string, maxBytes: number): Promise<string> {
    const ws = this.mustWorkspace(workspaceId);
    const f = ws.produced.find((p) => p.path === path);
    if (!f || f.kind !== 'file') throw new Error('not_a_regular_file');
    const c = ws.content[path] ?? '';
    if (Buffer.byteLength(c) > maxBytes) throw new Error('too_large');
    return c;
  }
  async destroyWorkspace(workspaceId: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return;
    if (ws.destroyFails) throw new Error('destroy_failed');
    this.workspaces.delete(workspaceId);
  }
  private mustWorkspace(id: string): SimWorkspace {
    const w = this.workspaces.get(id);
    if (!w) throw new Error('unknown_workspace');
    return w;
  }
  private mustRun(h: string): SimRun {
    const r = this.runs.get(h);
    if (!r) throw new Error('unknown_handle');
    return r;
  }
}
