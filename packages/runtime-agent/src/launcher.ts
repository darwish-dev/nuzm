import { mkdir, symlink, link, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { executionGateway as eg } from '@nuzm/domain';

/**
 * The seam between the agent's bookkeeping and "something that runs a workload". The agent core (`node-service.ts`) never starts a process itself: it asks a `Launcher`.
 *   - `RunscLauncher` (`runsc-launcher.ts`) runs the workload in gVisor, through the `CommandRunner` (which refuses anywhere but the attested Linux node).
 *   - `SimulatedLauncher` (here) STARTS NOTHING: it replays a scripted `SimulatedBehavior`, writing the scripted "produced" files into the workspace so listing, confinement and
 *     artifact extraction run for real. Everything it yields is SIMULATED and proves nothing about isolation.
 */
export interface LaunchRequest {
  spec: eg.RuntimeSpec;
  /** opaque id the agent gave this run */
  handle: string;
  workDir: string;
  scratchDir: string;
  /** rootfs directory of the (verified) image */
  rootfs: string;
  toolchainDir: string;
  /** stdout/stderr are kept up to this many bytes each; the rest is counted and dropped */
  maxOutputBytes: number;
}
export interface LaunchResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs?: number;
  /** the launcher itself ended the run (output flood): the service records the reason */
  endedBy?: 'output_flood';
}
export interface Launched {
  /** resolves once, when the workload has ended (by itself or because it was killed) */
  done: Promise<LaunchResult>;
  kill(how: 'soft' | 'hard'): Promise<void>;
  stats(): Promise<eg.NodeStats>;
  /** removes everything the launch created (container, namespace, bundle, cgroup); idempotent; throws only if something remains */
  cleanup(): Promise<void>;
}
export interface Launcher {
  readonly kind: 'runsc' | 'simulated';
  /** true when the launcher itself enforces cpu/memory/pids/disk/network (only the real one) */
  readonly enforcesLimits: boolean;
  launch(req: LaunchRequest): Promise<Launched>;
  /** ids of sandboxes the node still has that this agent process does not own (after a crash) */
  listStray(owned: ReadonlySet<string>): Promise<string[]>;
  killStray(ids: readonly string[]): Promise<number>;
  health(): Promise<{ ok: boolean; note?: string }>;
}

export class LaunchRefused extends Error {
  constructor(readonly code: 'no_capacity' | 'platform_refused') {
    super(code);
    this.name = 'LaunchRefused';
  }
}

/** a scripted workload: nothing is executed */
export class SimulatedLauncher implements Launcher {
  readonly kind = 'simulated' as const;
  readonly enforcesLimits = false;
  /** every launch the simulated launcher saw (tests assert on it) */
  readonly launched: LaunchRequest[] = [];
  private script: eg.SimulatedScript = () => ({});
  private readonly live = new Set<string>();
  constructor(private readonly maxSlots = 4) {}
  setScript(s: eg.SimulatedScript): this {
    this.script = s;
    return this;
  }
  async launch(req: LaunchRequest): Promise<Launched> {
    if (this.live.size >= this.maxSlots) throw new LaunchRefused('no_capacity');
    this.launched.push(req);
    const b = this.script(req.spec, new Map());
    this.live.add(req.handle);
    // the produced files are written for real (under the workspace's own work dir) so listing, hard-link detection and bounded reads are exercised
    for (const p of b.produced ?? []) {
      const abs = join(req.workDir, p.path);
      await mkdir(dirname(abs), { recursive: true });
      if (p.kind === 'file')
        await writeFile(abs, b.producedContent?.[p.path] ?? 'x'.repeat(Math.max(0, p.bytes)));
      else if (p.kind === 'symlink')
        await symlink('/nonexistent-target', abs).catch(() => undefined);
      else if (p.kind === 'hardlink') {
        const base = join(req.workDir, `${p.path}.base`);
        await writeFile(base, 'x');
        await link(base, abs).catch(() => undefined);
      }
    }
    let release: (() => void) | null = null;
    let killed: 'soft' | 'hard' | null = null;
    let finished = false;
    const done = new Promise<LaunchResult>((resolve) => {
      const finish = () => {
        finished = true;
        this.live.delete(req.handle);
        if (killed)
          resolve({
            exitCode: null,
            signal: killed === 'hard' ? 'SIGKILL' : 'SIGTERM',
            stdout: b.stdout ?? '',
            stderr: b.stderr ?? '',
            truncated: false,
            durationMs: b.durationMs ?? 0,
          });
        else
          resolve({
            exitCode: b.exitCode === undefined ? 0 : b.exitCode,
            signal: b.signal ?? null,
            stdout: b.stdout ?? '',
            stderr: b.stderr ?? '',
            truncated: false,
            durationMs: b.durationMs ?? 1,
          });
      };
      if (b.hang) release = finish;
      else queueMicrotask(finish);
    });
    return {
      done,
      kill: async (how) => {
        killed = how === 'hard' || killed === 'hard' ? 'hard' : 'soft';
        release?.();
      },
      stats: async () => ({
        cpuSeconds: b.stats?.cpuSeconds ?? 0,
        memoryMb: b.stats?.memoryMb ?? 0,
        pids: b.stats?.pids ?? 0,
        diskMb: b.stats?.diskMb ?? 0,
        outputBytes: b.stats?.outputBytes ?? 0,
      }),
      cleanup: async () => {
        if (b.destroyFails) throw new Error('destroy_failed');
        killed ??= 'hard';
        release?.();
        if (!finished) this.live.delete(req.handle);
      },
    };
  }
  async listStray(): Promise<string[]> {
    return [];
  }
  async killStray(): Promise<number> {
    return 0;
  }
  async health() {
    return { ok: true, note: 'simulated' };
  }
  liveCount(): number {
    return this.live.size;
  }
}
