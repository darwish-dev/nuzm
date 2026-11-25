import { chown, mkdir } from 'node:fs/promises';
import { executionGateway as eg } from '@nuzm/domain';
import { FileAuditSink, type AuditSink } from './audit';
import {
  DEFAULT_BINARIES,
  NodeCommandRunner,
  RefusedCommandRunner,
  type CommandRunner,
} from './command-runner';
import type { AgentConfig } from './config';
import { createRequestHandler } from './http-handler';
import { verifyImages } from './image';
import { SimulatedLauncher, type Launcher } from './launcher';
import { Metrics } from './metrics';
import { NodeService } from './node-service';
import {
  AccountingQuotaDriver,
  quotaStateFile,
  XfsProjectQuotaDriver,
  type QuotaDriver,
} from './quota';
import { RunscLauncher } from './runsc-launcher';
import { WorkspaceStore } from './workspace-store';

/**
 * Assembles an agent from a validated configuration. FAIL-CLOSED start-up, in this order, each step a hard stop:
 *   1. every configured image's tree digest must equal its configured digest (`image_mismatch`);
 *   2. for the real launcher: the host must prove it is the attested Linux node (`NodeCommandRunner.create`), otherwise the agent does not start;
 *   3. `recoverOnStart`: kill sandboxes a previous agent process left behind.
 * A simulated launcher needs none of the host proof (it starts nothing) and can only be configured on a loopback listener.
 */
export interface AssembledAgent {
  service: NodeService;
  handler: eg.NodeRequestHandler;
  metrics: Metrics;
  audit: AuditSink;
  launcher: Launcher;
  replay: eg.ReplayCache;
}
export class AgentStartRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`agent start refused: ${reasons.join(',')}`);
    this.name = 'AgentStartRefused';
  }
}
export interface AssembleOptions {
  /** tests inject these; production passes none */
  audit?: AuditSink;
  runner?: CommandRunner;
  platform?: string;
  now?: () => number;
  monitorMs?: number;
  freeDiskMb?: () => Promise<number>;
  launcher?: Launcher;
  quota?: QuotaDriver;
  /** skip the (slow) rootfs tree hashing in tests that use a synthetic image map */
  verifiedImages?: Record<string, string>;
}
export async function assembleAgent(
  cfg: AgentConfig,
  opts: AssembleOptions = {},
): Promise<AssembledAgent> {
  const audit = opts.audit ?? new FileAuditSink(cfg.auditFile, cfg.nodeId, opts.now);
  const metrics = new Metrics();
  let images: Record<string, string>;
  if (opts.verifiedImages) images = opts.verifiedImages;
  else {
    const chk = await verifyImages(cfg.images);
    if (chk.mismatched.length > 0) {
      for (const d of chk.mismatched)
        await audit.write({ type: 'image_mismatch', detail: { digest: d } });
      throw new AgentStartRefused(chk.mismatched.map((d) => `image_mismatch:${d.slice(0, 19)}`));
    }
    images = chk.verified;
  }

  let runner: CommandRunner =
    opts.runner ?? new RefusedCommandRunner('simulated_launcher_has_no_runner');
  let launcher: Launcher;
  let quota: QuotaDriver;
  if (cfg.launcher === 'runsc') {
    if (!opts.runner) {
      try {
        runner = await NodeCommandRunner.create({
          platform: opts.platform ?? process.platform,
          nodeId: cfg.nodeId,
        });
      } catch (e) {
        throw new AgentStartRefused([
          `not_the_attested_node:${(e as { code?: string }).code ?? 'unknown'}`,
        ]);
      }
    }
    quota =
      opts.quota ??
      new XfsProjectQuotaDriver(
        runner,
        DEFAULT_BINARIES.xfsQuota,
        cfg.workspaceRoot,
        quotaStateFile(cfg.stateDir),
      );
    launcher =
      opts.launcher ??
      new RunscLauncher({
        runner,
        binaries: DEFAULT_BINARIES,
        runscRoot: cfg.runsc.rootDir,
        stateDir: cfg.stateDir,
        maxSlots: cfg.maxSlots,
        proxyAddr: cfg.egress.proxyAddr,
        platform: cfg.runsc.platform,
      });
  } else {
    quota = opts.quota ?? new AccountingQuotaDriver();
    launcher = opts.launcher ?? new SimulatedLauncher(cfg.maxSlots);
  }
  await mkdir(cfg.workspaceRoot, { recursive: true, mode: 0o700 });
  await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const store = new WorkspaceStore({
    root: cfg.workspaceRoot,
    outputRoots: cfg.outputRoots,
    sandboxUid: cfg.sandboxUid,
    sandboxGid: cfg.sandboxGid,
    maxWorkspaceDiskMb: cfg.maxWorkspaceDiskMb,
    quota,
    now: opts.now ?? (() => Date.now()),
    chown: cfg.launcher === 'runsc' && asRoot ? (p, u, g) => chown(p, u, g) : undefined,
  });
  const service = new NodeService({
    config: cfg,
    store,
    launcher,
    images,
    audit,
    metrics,
    now: opts.now,
    monitorMs: opts.monitorMs,
    freeDiskMb: opts.freeDiskMb,
  });
  await service.recoverOnStart();
  await audit.write({
    type: 'agent_started',
    detail: { launcher: cfg.launcher, images: Object.keys(images).length },
  });
  const replay = new eg.ReplayCache();
  const handler = createRequestHandler({
    service,
    nodeId: cfg.nodeId,
    trusted: cfg.trustedControlKeys,
    replay,
    metrics,
    audit,
    now: opts.now,
  });
  return { service, handler, metrics, audit, launcher, replay };
}
