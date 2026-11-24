import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executionGateway as eg } from '@nuzm/domain';
import type { BinaryAllowList, CommandRunner, SpawnedProcess } from './command-runner';
import { forceRemoveTree } from './fs-safe';
import { LaunchRefused, type Launched, type Launcher, type LaunchRequest, type LaunchResult } from './launcher';
import { planNetwork } from './network';
import { buildOciBundle } from './oci';

/**
 * The REAL launcher: runs each workload in gVisor (`runsc`, systrap platform). It builds an OCI bundle (`oci.ts`), wires the network (`network.ts`) and starts
 * `runsc run` through the `CommandRunner`, which refuses on any machine that is not the attested Linux node (so constructing this class on a Mac is harmless and starting
 * a run there is impossible).
 *
 * STATUS: written and unit-tested against a recording runner only. Every `runsc` flag, the `events` JSON shape and the `list` output format are marked (V): they are verified against
 * the pinned release on the node at qualification, never assumed. Nothing here is LIVE-VERIFIED.
 */
export interface RunscLauncherOptions {
  runner: CommandRunner;
  binaries: BinaryAllowList;
  /** `runsc --root` state directory */
  runscRoot: string;
  /** agent state dir: bundles live under `<stateDir>/bundles/<handle>` */
  stateDir: string;
  maxSlots: number;
  proxyAddr: string;
  platform: 'systrap';
  /** the agent's hard cap on bytes drained from one run before it ends the run (a flood is killed, not tolerated) */
  floodFactor?: number;
}
const CONTAINER_PREFIX = 'nz-';

/** the global `runsc` flags: V = verify each against the pinned release's `runsc --help` at qualification */
export function runscGlobalFlags(o: { root: string; platform: string; network: 'none' | 'sandbox' }): string[] {
  return [
    '--root',
    o.root,
    `--platform=${o.platform}`, // (V) systrap needs no KVM
    `--network=${o.network}`, // (V) none | sandbox (netstack)
    '--file-access=shared', // (V) coherent view of the bind-mounted workspace for artifact extraction
    '--overlay2=none', // (V) the rootfs is read-only; no host-backed overlay
    '--strace=false',
    '--debug=false',
    '--log-format=json',
  ];
}

/** `runsc events --stats <id>` JSON → NodeStats. The shape is OCI-runtime-events (cgroup stats); (V) on the pinned release. Unparseable → null (the caller treats it as a missed sample). */
export function parseRunscStats(stdout: string, outputBytes: number, diskMb: number): eg.NodeStats | null {
  try {
    const j = JSON.parse(stdout) as {
      data?: {
        cpu?: { usage?: { total?: number } };
        memory?: { usage?: { usage?: number; max?: number } };
        pids?: { current?: number };
      };
    };
    const d = j.data;
    if (!d) return null;
    const cpuNs = Number(d.cpu?.usage?.total ?? 0);
    const mem = Number(d.memory?.usage?.max ?? d.memory?.usage?.usage ?? 0);
    const pids = Number(d.pids?.current ?? 0);
    if (![cpuNs, mem, pids].every(Number.isFinite)) return null;
    return { cpuSeconds: cpuNs / 1e9, memoryMb: Math.ceil(mem / (1024 * 1024)), pids, diskMb, outputBytes };
  } catch {
    return null;
  }
}
/** `runsc list --format json` → ids of containers this agent created (prefix `nz-`) */
export function parseRunscList(stdout: string): string[] {
  try {
    const j = JSON.parse(stdout) as unknown;
    if (!Array.isArray(j)) return [];
    return j.map((x) => (x as { id?: unknown }).id).filter((id): id is string => typeof id === 'string' && id.startsWith(CONTAINER_PREFIX));
  } catch {
    return [];
  }
}

export class RunscLauncher implements Launcher {
  readonly kind = 'runsc' as const;
  readonly enforcesLimits = true;
  private readonly slots = new Set<number>();
  constructor(private readonly o: RunscLauncherOptions) {}

  private takeSlot(): number {
    for (let s = 1; s <= Math.min(this.o.maxSlots, 250); s++)
      if (!this.slots.has(s)) {
        this.slots.add(s);
        return s;
      }
    throw new LaunchRefused('no_capacity');
  }

  async launch(req: LaunchRequest): Promise<Launched> {
    const slot = this.takeSlot();
    const id = `${CONTAINER_PREFIX}${req.handle}`;
    const bundle = join(this.o.stateDir, 'bundles', req.handle);
    const net = planNetwork(slot, req.spec.network.class, this.o.proxyAddr, this.o.binaries);
    let netUp = false;
    let started = false;
    let cleaned = false;
    const release = () => this.slots.delete(slot);
    const teardown = async (): Promise<boolean> => {
      let ok = true;
      for (const cmd of net.teardown) {
        const r = await this.o.runner.run(cmd, { timeoutMs: 15_000 }).catch(() => null);
        // deleting something that is already gone is fine; anything else is a leak
        if (netUp && r && r.code !== 0 && !/(Cannot find|No such|does not exist)/i.test(r.stderr)) ok = false;
      }
      return ok;
    };
    try {
      await mkdir(bundle, { recursive: true, mode: 0o700 });
      const oci = buildOciBundle({
        spec: req.spec,
        rootfs: req.rootfs,
        workDir: req.workDir,
        scratchDir: req.scratchDir,
        toolchainDir: req.toolchainDir,
        netnsPath: net.netnsPath ?? undefined,
        cgroupsPath: `/nuzm/${req.handle}`,
      });
      await writeFile(join(bundle, 'config.json'), JSON.stringify(oci), { mode: 0o600 });
      for (const cmd of net.setup) {
        netUp = true;
        const r = await this.o.runner.run(cmd, { timeoutMs: 15_000 });
        if (r.code !== 0) throw new LaunchRefused('platform_refused');
      }
    } catch (e) {
      await teardown();
      await forceRemoveTree(bundle);
      release();
      throw e instanceof LaunchRefused ? e : new LaunchRefused('platform_refused');
    }

    // output is captured here, capped at the source
    const cap = req.maxOutputBytes;
    const floodAt = cap * (this.o.floodFactor ?? 8);
    let out = '';
    let err = '';
    let seen = 0;
    let truncated = false;
    let flooded = false;
    const t0 = Date.now();
    let proc: SpawnedProcess;
    const feed = (which: 'out' | 'err') => (c: Buffer) => {
      seen += c.length;
      const cur = which === 'out' ? out : err;
      if (Buffer.byteLength(cur) + c.length <= cap) {
        if (which === 'out') out += c.toString('utf8');
        else err += c.toString('utf8');
      } else truncated = true;
      if (seen > floodAt && !flooded) {
        flooded = true;
        void this.signal(id, 'SIGKILL', req.spec.network.class === 'none');
        proc?.kill('SIGKILL');
      }
    };
    try {
      proc = this.o.runner.spawn(
        [
          this.o.binaries.runsc,
          ...runscGlobalFlags({ root: this.o.runscRoot, platform: this.o.platform, network: net.runscNetwork }),
          'run',
          '--bundle',
          bundle,
          id,
        ],
        { onStdout: feed('out'), onStderr: feed('err') },
      );
      started = true;
    } catch {
      await teardown();
      await forceRemoveTree(bundle);
      release();
      throw new LaunchRefused('platform_refused');
    }
    const done: Promise<LaunchResult> = proc.wait().then((r) => ({
      exitCode: r.code,
      signal: r.signal,
      stdout: out,
      stderr: err,
      truncated,
      durationMs: Date.now() - t0,
      ...(flooded ? { endedBy: 'output_flood' as const } : {}),
    }));
    const base = req.workDir;
    return {
      done,
      kill: async (how) => {
        await this.signal(id, how === 'soft' ? 'SIGTERM' : 'SIGKILL', true);
        if (how === 'hard') proc.kill('SIGKILL');
      },
      stats: async () => {
        const r = await this.o.runner.run([this.o.binaries.runsc, '--root', this.o.runscRoot, 'events', '--stats', id], { timeoutMs: 10_000 }).catch(() => null);
        const parsed = r && r.code === 0 ? parseRunscStats(r.stdout, seen, 0) : null;
        if (!parsed) throw new Error('stats_unavailable');
        return parsed;
      },
      cleanup: async () => {
        if (cleaned) return;
        // 1. make sure nothing runs: kill all processes of the sandbox, then delete the container (state, cgroup)
        if (started) {
          await this.signal(id, 'SIGKILL', true);
          proc.kill('SIGKILL');
          await Promise.race([proc.wait(), new Promise((r) => setTimeout(r, 10_000))]);
          const del = await this.o.runner.run([this.o.binaries.runsc, '--root', this.o.runscRoot, 'delete', '--force', id], { timeoutMs: 20_000 }).catch(() => null);
          if (!del || (del.code !== 0 && !/(does not exist|not found)/i.test(del.stderr))) throw new Error('destroy_failed');
        }
        // 2. the network, then the bundle
        if (!(await teardown())) throw new Error('destroy_failed');
        if (!(await forceRemoveTree(bundle))) throw new Error('destroy_failed');
        void base;
        cleaned = true;
        release();
      },
    };
  }
  private async signal(id: string, sig: 'SIGTERM' | 'SIGKILL', all: boolean): Promise<void> {
    await this.o.runner
      .run([this.o.binaries.runsc, '--root', this.o.runscRoot, 'kill', ...(all ? ['--all'] : []), id, sig], { timeoutMs: 10_000 })
      .catch(() => undefined);
  }
  async listStray(owned: ReadonlySet<string>): Promise<string[]> {
    const r = await this.o.runner.run([this.o.binaries.runsc, '--root', this.o.runscRoot, 'list', '--format', 'json'], { timeoutMs: 15_000 }).catch(() => null);
    if (!r || r.code !== 0) return [];
    return parseRunscList(r.stdout).filter((id) => !owned.has(id.slice(CONTAINER_PREFIX.length)));
  }
  async killStray(ids: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      if (!id.startsWith(CONTAINER_PREFIX)) continue;
      await this.signal(id, 'SIGKILL', true);
      const d = await this.o.runner.run([this.o.binaries.runsc, '--root', this.o.runscRoot, 'delete', '--force', id], { timeoutMs: 20_000 }).catch(() => null);
      if (d && d.code === 0) n++;
    }
    return n;
  }
  async health(): Promise<{ ok: boolean; note?: string }> {
    const r = await this.o.runner.run([this.o.binaries.runsc, '--version'], { timeoutMs: 5_000 }).catch(() => null);
    return r && r.code === 0 ? { ok: true, note: r.stdout.split('\n')[0]?.slice(0, 80) } : { ok: false, note: 'runsc_unavailable' };
  }
}
