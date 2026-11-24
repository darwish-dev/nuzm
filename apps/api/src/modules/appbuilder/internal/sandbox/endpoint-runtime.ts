import { executionGateway as eg } from '@nuzm/domain';
import {
  RuntimeNoCapacity,
  SandboxRuntime,
  type ExecRequest,
  type ExecResult,
  type IsolationLevel,
  type RuntimeSpec,
  type RuntimeStats,
} from './runtime';

/**
 * S-AG6 PHASE 2 (OFFLINE): `SandboxRuntime` over a runtime NODE (`WorkspaceRuntime`), so the existing escape suite can attack a node through the same boundary. It exists for
 * QUALIFICATION RUNS ONLY (`escape-runner.ts`): it runs ARBITRARY argv (the attack payloads), which the Execution Gateway would refuse, so it must never be handed to anything that
 * serves customers. It is not registered in any module and not imported outside the qualification runner and tests.
 *
 * `isolation` is NEVER read from the node: the node is the thing being tested. It is `simulated` for a simulated node, and `verified` only when the qualification runner says it is
 * running a live qualification (the suite IS the verification; the result is a report for the human reviewer, not a verdict). The node still validates every spec it receives
 * (`validateRuntimeSpec`): the payload gets the hardened spec of an ordinary run (non-root, read-only root, no capabilities, own network namespace, egress via the proxy only).
 */
export class EndpointSandboxRuntime extends SandboxRuntime {
  readonly kind = 'isolated' as const;
  constructor(
    private readonly node: eg.WorkspaceRuntime,
    readonly isolation: IsolationLevel,
    private readonly image: string,
    private readonly runtimeClass: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    super();
  }
  private readonly orgOf = new Map<string, string>();
  async freeSlots(): Promise<number> {
    return (await this.node.health()).freeSlots;
  }
  async create(spec: RuntimeSpec): Promise<string> {
    if ((await this.freeSlots()) <= 0) throw new RuntimeNoCapacity();
    const handle = spec.sandboxId;
    await this.node.createWorkspace({
      workspaceId: `ws-${handle}`,
      orgId: spec.orgId,
      runId: handle,
      diskMb: spec.quota.diskGb * 1024,
    });
    this.orgOf.set(handle, spec.orgId);
    return handle;
  }
  async writeFiles(handle: string, files: ReadonlyMap<string, string>): Promise<void> {
    await this.node.putFiles(`ws-${handle}`, files);
  }
  async readFiles(): Promise<Map<string, string>> {
    return new Map(); // produced files are read through the artifact path, not here
  }
  async exec(handle: string, req: ExecRequest): Promise<ExecResult> {
    const orgId = this.orgOf.get(handle);
    if (!orgId) throw new Error('unknown sandbox handle');
    const wallSeconds = Math.max(1, Math.ceil(req.timeoutMs / 1000));
    const spec = eg.buildRuntimeSpec({
      decision: {
        argv: req.argv,
        cwd: req.cwd ?? '',
        env: { ...eg.EXEC_ENV },
        limits: {
          cpuSeconds: wallSeconds,
          wallSeconds,
          memoryMb: 512,
          pids: 64,
          outputKb: 256,
          diskMb: 256,
        },
        // the most permissive class the gateway can grant: attacks are qualified against the weaker configuration
        network: 'registry-only',
      },
      orgId,
      runId: handle,
      runtimeClass: this.runtimeClass,
      image: this.image,
    });
    const t0 = this.now();
    const { handle: h } = await this.node.start(spec);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.node.kill(h, 'hard').catch(() => undefined);
    }, req.timeoutMs);
    try {
      const w = await this.node.wait(h);
      const st = await this.node.stats(h).catch(() => ({ cpuSeconds: 0 }));
      return {
        exitCode: w.exitCode,
        signal: w.signal,
        stdout: w.stdout,
        stderr: w.stderr,
        durationMs: this.now() - t0,
        timedOut,
        truncated: w.truncated,
        cpuSeconds: st.cpuSeconds,
      };
    } finally {
      clearTimeout(timer);
      await this.node.destroy(h).catch(() => undefined);
    }
  }
  async stats(handle: string): Promise<RuntimeStats> {
    void handle;
    return { cpuSeconds: 0, memoryMb: 0, diskMb: 0, pids: 0 };
  }
  async destroy(handle: string): Promise<void> {
    this.orgOf.delete(handle);
    await this.node.destroyWorkspace(`ws-${handle}`);
  }
}
