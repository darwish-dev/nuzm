import { createHash } from 'node:crypto';
import {
  collectArtifacts,
  DEFAULT_ARTIFACT_POLICY,
  type ArtifactPolicy,
  type ProducedFile,
} from '../artifacts';
import { checkRunEnv, checkWorkspaceFiles } from '../env-guard';
import {
  DEFAULT_CLEANUP_POLICY,
  planCleanup,
  type CleanupPolicy,
  type WorkspaceRecord,
} from '../cleanup';
import { ResourceMonitor } from '../monitor';
import { decideExec, type ExecContext, type ExecDecision, type ExecRequest } from '../policy';
import {
  IssuedDecisions,
  type ExecutionOutcome,
  type ExecutionPort,
  type ExecutionRunContext,
  type PortOrigin,
} from '../port';
import { buildRuntimeSpec, validateRuntimeSpec } from '../runtime-spec';
import { runTimeouts, type ExecUsage } from '../limits';
import type { TerminationPorts } from '../termination';
import {
  verifyAttestation,
  type AttestationExpectation,
  type IsolationAttestation,
  type NodeEnvironment,
  type TrustedKeys,
} from './attestation';
import {
  checkDependencyInstall,
  registryHosts,
  type DependencyPolicy,
  DEFAULT_DEPENDENCY_POLICY,
} from './dependency-policy';
import type { WorkspaceRuntime } from './workspace-runtime';

/**
 * S-AG6 PHASE 2 (OFFLINE SCAFFOLD): the REAL-RUNTIME execution service behind `ExecutionPort`.
 *
 * FAIL-CLOSED START: `RealRuntimeService.start` refuses (throws `AttestationRefused`) unless EVERY node it is given holds an isolation attestation that verifies for that node,
 * that endpoint, that environment and that mode (`verifyAttestation`), the node's own identity answers match the attestation, and (in live mode) the node reports
 * `isolation: 'verified'` and answers a health probe. There is no constructor and no bypass: no attestation, no service, no port.
 *
 * NOT REACHABLE FROM CUSTOMER ROUTES: nothing in this repository imports this module outside of tests; it is not exported from any NestJS module and has no controller. The only
 * route to a run is `ExecutionOrchestrator` (flag `ai.agent.exec_tools`, default off, gate closed, kill switch, approval), which holds an `ExecutionPort`.
 *
 * ORIGIN: the port reports `REAL` only in `live` mode with a LIVE-VERIFIED attestation. In `simulated` mode (the only mode that can run in this repository) it reports `MOCK`, so
 * the orchestrator never treats simulated results as isolation evidence and `executionGate` stays closed. Nothing here starts a process on the machine it runs on.
 */
export class AttestationRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`isolation attestation refused: ${reasons.join(',')}`);
    this.name = 'AttestationRefused';
  }
}
export interface RealRuntimeNode {
  nodeId: string;
  endpointId: string;
  runtime: WorkspaceRuntime;
  /** the attestation record (parsed JSON) held for this node; `null`/`undefined` means none and refuses the start */
  attestation: unknown;
  /** the data region of the node pool (`execution.runtime_nodes.data_region`); `undefined` = unknown, which a residency-enforcing service treats as a refusal */
  region?: string;
}
/**
 * PLACEMENT RESIDENCY (CLAUDE.md §4: call ResidencyPolicyService before placing data). Behind a flag, default OFF (`enforce: false`). When on, a run is placed only if the node has a
 * region AND the policy allows the project's `dataRegion` there. An unknown node region or an unknown data region is a refusal. The ONLY exemption is `syntheticOnly`, a property of
 * the SERVICE CONFIGURATION (set by the platform: staging qualification with synthetic fixtures, D1), never of a run, a request or a caller.
 */
export interface PlacementResidency {
  enforce: boolean;
  /** the platform's residency decision (an adapter over `ResidencyPolicyService`); it must fail closed */
  evaluate: (i: {
    orgId: string;
    runId: string;
    dataRegion: string;
    nodeRegion: string;
  }) => Promise<{ allowed: boolean; reason: string }>;
  syntheticOnly?: boolean;
}
export type RuntimeEventType =
  | 'node_admitted'
  | 'node_quarantined'
  | 'node_dropped'
  | 'workspace_created'
  | 'run_started'
  | 'run_finished'
  | 'run_killed'
  | 'cleanup_ok'
  | 'cleanup_failed'
  | 'artifact_refused'
  | 'dependency_refused'
  | 'placement_refused'
  | 'spec_refused';
/** content-free: ids, codes and counts only */
export interface RuntimeEvent {
  type: RuntimeEventType;
  nodeId: string;
  orgId?: string;
  runId?: string;
  detail?: Record<string, string | number | boolean>;
}
export interface RunAccounting {
  orgId: string;
  runId: string;
  nodeId: string;
  runtimeClass: string;
  profile: string;
  usage: ExecUsage;
  status: ExecutionOutcome['status'];
}
export interface ArtifactSink {
  put(a: {
    orgId: string;
    runId: string;
    path: string;
    sha256: string;
    bytes: number;
    content: string;
  }): Promise<void>;
}
export interface RealRuntimeConfig {
  mode: 'live' | 'simulated';
  nodes: readonly RealRuntimeNode[];
  trust: TrustedKeys;
  environments: readonly NodeEnvironment[];
  now: () => number;
  minSuiteVersion?: string;
  minIsolatingAttempts?: number;
  maxValidityDays?: number;
  isRevoked?: (attestationId: string) => boolean;
  /** profile id -> attested image digest; default is the first attested digest */
  imageFor?: (profile: string, attested: readonly string[]) => string | undefined;
  artifactPolicy?: ArtifactPolicy;
  dependencyPolicy?: DependencyPolicy;
  artifactSink?: ArtifactSink;
  residency?: PlacementResidency;
  onEvent?: (e: RuntimeEvent) => void;
  onUsage?: (a: RunAccounting) => void;
  /** stats polling interval of a running job (ms) */
  pollMs?: number;
  /** wait after a soft kill before the hard kill (ms) */
  graceMs?: number;
}
interface NodeState {
  node: RealRuntimeNode;
  attestation: IsolationAttestation;
  quarantined: string | null;
  dropped: string | null;
  inflight: number;
}
interface Active {
  orgId: string;
  runId: string;
  node: NodeState;
  handle: string;
  workspaceId: string;
  killedBy: 'wall' | 'abort' | 'limit' | 'terminate' | 'unresponsive' | null;
  limitNote: string;
}
export const DEFAULT_MIN_SUITE_VERSION = '1.1.0';
/** the count of isolating-runtime attempts (every `requires: 'isolating-runtime'`, M10 and XR-*) in suite 1.1.0; the attestation must show at least this many, all blocked. A spec in apps/api keeps it equal to the suite. */
export const DEFAULT_MIN_ISOLATING_ATTEMPTS = 65;

const refusal = (
  why: string,
  status: ExecutionOutcome['status'] = 'refused',
): ExecutionOutcome => ({
  status,
  exitCode: null,
  stdout: '',
  stderr: `refused: ${why}\n`,
  truncated: false,
  durationMs: 0,
  artifacts: [],
});
const sha256 = (c: string) => createHash('sha256').update(c).digest('hex');
const cutUtf8 = (s: string, max: number): { text: string; cut: boolean } =>
  Buffer.byteLength(s) <= max
    ? { text: s, cut: false }
    : { text: Buffer.from(s).subarray(0, max).toString('utf8'), cut: true };

export class RealRuntimeService {
  private readonly nodes: NodeState[];
  private readonly active = new Map<string, Active>();
  private readonly revoked = new Set<string>();
  private readonly monitor: ResourceMonitor;
  private constructor(
    private readonly cfg: RealRuntimeConfig,
    nodes: NodeState[],
  ) {
    this.nodes = nodes;
    this.monitor = new ResourceMonitor(cfg.now);
  }

  /** The only way to get a service. Throws `AttestationRefused` unless every node verifies. */
  static async start(cfg: RealRuntimeConfig): Promise<RealRuntimeService> {
    const refused: string[] = [];
    if (cfg.nodes.length === 0) throw new AttestationRefused(['no_nodes']);
    if (cfg.mode !== 'live' && cfg.mode !== 'simulated')
      throw new AttestationRefused(['mode_invalid']);
    const states: NodeState[] = [];
    const seen = new Set<string>();
    for (const n of cfg.nodes) {
      if (seen.has(n.nodeId)) {
        refused.push('node_duplicate');
        continue;
      }
      seen.add(n.nodeId);
      const verdict = verifyAttestation(
        n.attestation,
        RealRuntimeService.expectation(cfg, n),
        cfg.trust,
      );
      if (!verdict.ok) {
        refused.push(...verdict.reasons.map((r) => `${n.nodeId}:${r}`));
        continue;
      }
      const why = await RealRuntimeService.identityProblems(cfg, n, verdict.attestation);
      if (why.length > 0) {
        refused.push(...why.map((r) => `${n.nodeId}:${r}`));
        continue;
      }
      states.push({
        node: n,
        attestation: verdict.attestation,
        quarantined: null,
        dropped: null,
        inflight: 0,
      });
    }
    if (refused.length > 0 || states.length === 0)
      throw new AttestationRefused(refused.length ? refused : ['no_nodes']);
    const svc = new RealRuntimeService(cfg, states);
    for (const s of states) svc.emit({ type: 'node_admitted', nodeId: s.node.nodeId });
    return svc;
  }
  private static expectation(cfg: RealRuntimeConfig, n: RealRuntimeNode): AttestationExpectation {
    return {
      nodeId: n.nodeId,
      endpointId: n.endpointId,
      mode: cfg.mode,
      environments: cfg.environments,
      minSuiteVersion: cfg.minSuiteVersion ?? DEFAULT_MIN_SUITE_VERSION,
      minIsolatingAttempts: cfg.minIsolatingAttempts ?? DEFAULT_MIN_ISOLATING_ATTEMPTS,
      maxValidityDays: cfg.maxValidityDays ?? 90,
      now: new Date(cfg.now()),
      isRevoked: cfg.isRevoked,
    };
  }
  /** The node must answer as the attested node (a wrong node behind the endpoint is refused); a live node must claim `verified` and be healthy. */
  private static async identityProblems(
    cfg: RealRuntimeConfig,
    n: RealRuntimeNode,
    a: IsolationAttestation,
  ): Promise<string[]> {
    const r: string[] = [];
    try {
      const id = await n.runtime.identity();
      if (id.nodeId !== a.node.nodeId) r.push('identity_node_mismatch');
      if (id.endpointId !== a.node.endpointId) r.push('identity_endpoint_mismatch');
      if (id.runtimeClass !== a.runtime.class || n.runtime.runtimeClass !== a.runtime.class)
        r.push('identity_runtime_class_mismatch');
      if (!id.imageDigests.every((d) => a.runtime.imageDigests.includes(d)))
        r.push('identity_image_not_attested');
      const h = await n.runtime.health();
      if (!h.ok) r.push('node_unhealthy');
      if (cfg.mode === 'live' && n.runtime.isolation !== 'verified')
        r.push('runtime_self_report_not_verified');
      if (cfg.mode === 'simulated' && n.runtime.isolation === 'none')
        r.push('runtime_isolation_none');
    } catch {
      r.push('node_unreachable');
    }
    return r;
  }

  get origin(): PortOrigin {
    return this.cfg.mode === 'live' ? 'REAL' : 'MOCK';
  }
  revoke(attestationId: string): void {
    this.revoked.add(attestationId);
  }
  /** An unhealthy cleanup, an unresponsive node or a reviewer's call takes the node out of rotation until a human re-admits it by restarting the service. */
  quarantine(nodeId: string, reason: string): void {
    const s = this.nodes.find((x) => x.node.nodeId === nodeId);
    if (s && !s.quarantined) {
      s.quarantined = reason;
      this.emit({ type: 'node_quarantined', nodeId, detail: { reason } });
    }
  }
  status() {
    return this.nodes.map((s) => ({
      nodeId: s.node.nodeId,
      attestationId: s.attestation.attestationId,
      expiresAt: s.attestation.expiresAt,
      quarantined: s.quarantined,
      dropped: s.dropped,
      inflight: s.inflight,
    }));
  }
  private emit(e: RuntimeEvent) {
    try {
      this.cfg.onEvent?.(e);
    } catch {
      /* an observer never breaks a run */
    }
  }
  /** re-verify at the moment of use: expiry and revocation are checked before every run, not only at start */
  private stillValid(s: NodeState): string[] {
    if (this.revoked.has(s.attestation.attestationId)) return ['attestation_revoked'];
    const v = verifyAttestation(
      s.attestation,
      RealRuntimeService.expectation(this.cfg, s.node),
      this.cfg.trust,
    );
    return v.ok ? [] : v.reasons;
  }
  private async acquire(): Promise<NodeState | { refused: string }> {
    let best: { s: NodeState; free: number } | null = null;
    let sawAny = false;
    for (const s of this.nodes) {
      if (s.quarantined || s.dropped) continue;
      const bad = this.stillValid(s);
      if (bad.length > 0) {
        s.dropped = bad[0]!;
        this.emit({ type: 'node_dropped', nodeId: s.node.nodeId, detail: { reason: bad[0]! } });
        continue;
      }
      sawAny = true;
      try {
        const h = await s.node.runtime.health();
        if (!h.ok || h.freeSlots <= 0) continue;
        if (!best || h.freeSlots - s.inflight > best.free)
          best = { s, free: h.freeSlots - s.inflight };
      } catch {
        /* unreachable this time: skipped, not quarantined */
      }
    }
    if (best && best.free > 0) return best.s;
    return { refused: sawAny ? 'no_capacity' : 'no_attested_node' };
  }

  /**
   * Restart recovery and orphan reaping: ask every node (quarantined ones too: that is where leftovers are most likely) which workspaces it holds, plan with the shared cleanup
   * policy, and destroy the ones that no run of THIS process owns. A workspace of a live run is never touched. A node that cannot destroy one is quarantined.
   */
  async reapOrphans(
    policy: CleanupPolicy = DEFAULT_CLEANUP_POLICY,
  ): Promise<{ reaped: number; failed: number; unreachable: string[] }> {
    const owned = new Set([...this.active.values()].map((a) => a.workspaceId));
    let reaped = 0;
    let failed = 0;
    const unreachable: string[] = [];
    for (const s of this.nodes) {
      let held: Awaited<ReturnType<WorkspaceRuntime['listWorkspaces']>>;
      try {
        held = await s.node.runtime.listWorkspaces();
      } catch {
        unreachable.push(s.node.nodeId);
        continue;
      }
      const records: WorkspaceRecord[] = held
        .filter((w) => !owned.has(w.workspaceId))
        .map((w) => ({
          id: w.workspaceId,
          orgId: w.orgId,
          runId: w.runId,
          state: 'ready',
          createdAt: w.createdAt,
          lastActivityAt: w.createdAt,
          jobId: null,
          jobState: null,
          jobEndedAt: null,
        }));
      for (const a of planCleanup(records, this.cfg.now(), policy)) {
        try {
          await s.node.runtime.destroyWorkspace(a.workspaceId);
          reaped++;
          this.emit({
            type: 'cleanup_ok',
            nodeId: s.node.nodeId,
            orgId: a.orgId,
            runId: a.runId,
            detail: { reason: a.reason },
          });
        } catch {
          failed++;
          this.emit({
            type: 'cleanup_failed',
            nodeId: s.node.nodeId,
            orgId: a.orgId,
            runId: a.runId,
            detail: { reason: a.reason },
          });
          this.quarantine(s.node.nodeId, 'cleanup_failed');
        }
      }
    }
    return { reaped, failed, unreachable };
  }

  /** the runtime part of the emergency-termination ports (the rest - queue, approvals, marking - belongs to the orchestrator side) */
  terminationPorts(): Pick<
    TerminationPorts,
    'listRunning' | 'signal' | 'isGone' | 'destroyWorkspace'
  > {
    const find = (h: { runId: string; handle: string }) => this.active.get(h.handle);
    return {
      listRunning: async () =>
        [...this.active.entries()].map(([handle, a]) => ({
          orgId: a.orgId,
          runId: a.runId,
          jobId: a.runId,
          handle,
        })),
      signal: async (h, how) => {
        const a = find(h);
        if (!a) return;
        a.killedBy ??= 'terminate';
        await a.node.node.runtime.kill(a.handle, how);
      },
      isGone: async (h) => !this.active.has(h.handle),
      destroyWorkspace: async (h) => {
        const a = find(h);
        if (!a) return;
        await a.node.node.runtime.destroy(a.handle);
        await a.node.node.runtime.destroyWorkspace(a.workspaceId);
      },
    };
  }

  /** One port per run (like the sandbox port): it serves exactly the organization and run of `ctx`. */
  portFor(ctx: ExecContext, run: RunInputs): ExecutionPort {
    return new RealRuntimePort(this, ctx, run);
  }

  /** @internal used by the port */
  async execute(
    decision: Extract<ExecDecision, { allowed: true }>,
    ctx: ExecutionRunContext,
    run: RunInputs,
  ): Promise<ExecutionOutcome> {
    const picked = await this.acquire();
    if ('refused' in picked) return refusal(picked.refused);
    const s = picked;
    const rt = s.node.runtime;
    const image =
      this.cfg.imageFor?.(decision.profile, s.attestation.runtime.imageDigests) ??
      s.attestation.runtime.imageDigests[0];
    if (!image || !s.attestation.runtime.imageDigests.includes(image))
      return refusal('image_not_attested');
    const spec = buildRuntimeSpec({
      decision,
      orgId: ctx.orgId,
      runId: ctx.runId,
      runtimeClass: s.attestation.runtime.class,
      image,
      egressAllow: registryHosts(this.cfg.dependencyPolicy ?? DEFAULT_DEPENDENCY_POLICY),
    });
    const violations = validateRuntimeSpec(spec);
    if (violations.length > 0) {
      this.emit({
        type: 'spec_refused',
        nodeId: s.node.nodeId,
        orgId: ctx.orgId,
        runId: ctx.runId,
        detail: { count: violations.length },
      });
      return refusal(`runtime_spec_invalid:${violations.join(',')}`);
    }
    const files = run.seedFiles(ctx.source);
    const screened = checkWorkspaceFiles(
      [...files].map(([path, content]) => ({ path, content })),
      run.canaries(),
    );
    if (!screened.ok)
      return refusal(`workspace_refused:${screened.refused.map((r) => r.reason).join(',')}`);
    if (decision.profile === 'install-deps') {
      const dep = checkDependencyInstall(
        files,
        this.cfg.dependencyPolicy ?? DEFAULT_DEPENDENCY_POLICY,
      );
      if (!dep.ok) {
        this.emit({
          type: 'dependency_refused',
          nodeId: s.node.nodeId,
          orgId: ctx.orgId,
          runId: ctx.runId,
          detail: { count: dep.reasons.length },
        });
        return refusal(`dependency_policy:${dep.reasons.join(',')}`);
      }
    }
    if (ctx.signal?.aborted) return refusal('terminated', 'terminated');
    const placement = await this.checkPlacement(s, ctx, run);
    if (placement) return refusal(placement);

    s.inflight++;
    const workspaceId = spec.workspaceId;
    let handle: string | null = null;
    let created = false;
    let act: Active | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let poll: ReturnType<typeof setInterval> | null = null;
    let onAbort: (() => void) | null = null;
    let outcome: ExecutionOutcome;
    const started = this.cfg.now();
    let finalUsage: ExecUsage = {
      cpuSeconds: 0,
      wallMs: 0,
      memoryMb: 0,
      pids: 0,
      outputBytes: 0,
      diskMb: 0,
    };
    try {
      await rt.createWorkspace({
        workspaceId,
        orgId: ctx.orgId,
        runId: ctx.runId,
        diskMb: decision.limits.diskMb,
      });
      created = true;
      this.emit({
        type: 'workspace_created',
        nodeId: s.node.nodeId,
        orgId: ctx.orgId,
        runId: ctx.runId,
      });
      await rt.putFiles(workspaceId, files);
      const started1 = await rt.start(spec);
      handle = started1.handle;
      const h = handle;
      const key = `${s.node.nodeId}/${h}`;
      act = {
        orgId: ctx.orgId,
        runId: ctx.runId,
        node: s,
        handle: h,
        workspaceId,
        killedBy: null,
        limitNote: '',
      };
      this.active.set(key, act);
      this.monitor.start(ctx.runId, decision.limits);
      this.emit({
        type: 'run_started',
        nodeId: s.node.nodeId,
        orgId: ctx.orgId,
        runId: ctx.runId,
        detail: { profile: decision.profile },
      });
      const t = runTimeouts(decision.limits, this.cfg.graceMs ?? 5_000);
      const grace = Math.max(1, t.hardMs - t.softMs);
      const A = act;
      const kill = (why: NonNullable<Active['killedBy']>, how: 'soft' | 'hard') => {
        A.killedBy ??= why;
        this.emit({
          type: 'run_killed',
          nodeId: s.node.nodeId,
          orgId: ctx.orgId,
          runId: ctx.runId,
          detail: { why, how },
        });
        void rt.kill(h, how).catch(() => undefined);
      };
      timers.push(setTimeout(() => kill('wall', 'soft'), t.softMs));
      timers.push(setTimeout(() => kill('wall', 'hard'), t.hardMs));
      let unresponsive: (() => void) | null = null;
      const giveUp = new Promise<'unresponsive'>((resolve) => {
        unresponsive = () => resolve('unresponsive');
      });
      timers.push(setTimeout(() => unresponsive?.(), t.hardMs + grace));
      onAbort = () => {
        kill('abort', 'soft');
        timers.push(setTimeout(() => kill('abort', 'hard'), grace));
      };
      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
      poll = setInterval(() => {
        void (async () => {
          try {
            const st = await rt.stats(h);
            const u: ExecUsage = { ...st, wallMs: this.cfg.now() - started };
            finalUsage = { ...finalUsage, ...u };
            const act2 = this.monitor.observe(ctx.runId, u);
            if (act2.kind === 'kill') {
              A.limitNote = act2.violations.map((v) => v.resource).join(',');
              kill('limit', 'hard');
            }
          } catch {
            /* a missed sample is handled by the monitor's stale rule on the next tick */
          }
          for (const x of this.monitor.tick())
            if (x.runId === ctx.runId && x.action.kind === 'kill')
              kill(x.action.reason === 'wall' ? 'wall' : 'limit', 'hard');
        })();
      }, this.cfg.pollMs ?? 2_000);

      const waited = await Promise.race([rt.wait(h), giveUp]);
      if (waited === 'unresponsive') {
        A.killedBy = 'unresponsive';
        this.quarantine(s.node.nodeId, 'run_unresponsive_after_hard_kill');
        outcome = {
          ...refusal('node_unresponsive', 'terminated'),
          durationMs: this.cfg.now() - started,
        };
      } else {
        try {
          finalUsage = { ...finalUsage, ...(await rt.stats(h)), wallMs: waited.durationMs };
        } catch {
          finalUsage = { ...finalUsage, wallMs: waited.durationMs };
        }
        const limits = decision.limits;
        const out = cutUtf8(waited.stdout, limits.outputKb * 1024);
        const err = cutUtf8(waited.stderr, limits.outputKb * 1024);
        const wasKilled = A.killedBy;
        const status: ExecutionOutcome['status'] =
          wasKilled === 'wall'
            ? 'timeout'
            : wasKilled === 'abort' || wasKilled === 'terminate' || wasKilled === 'unresponsive'
              ? 'terminated'
              : wasKilled === 'limit' || waited.exitCode !== 0
                ? 'failed'
                : 'completed';
        outcome = {
          status,
          exitCode: wasKilled ? null : waited.exitCode,
          stdout: out.text,
          stderr: err.text + (wasKilled === 'limit' ? `[limit] ${A.limitNote}\n` : ''),
          truncated: waited.truncated || out.cut || err.cut,
          durationMs: waited.durationMs,
          artifacts: [],
        };
        outcome.usage = {
          cpuSeconds: finalUsage.cpuSeconds,
          peakMemoryMb: finalUsage.memoryMb,
          peakPids: finalUsage.pids,
          diskMb: finalUsage.diskMb,
        };
        if (status === 'completed' || status === 'failed')
          outcome.artifacts = await this.extractArtifacts(s, workspaceId, ctx, run);
      }
    } catch (e) {
      outcome = refusal(`runtime_error:${(e as Error).message.slice(0, 80)}`, 'failed');
      outcome.exitCode = null;
    } finally {
      for (const t of timers) clearTimeout(t);
      if (poll) clearInterval(poll);
      if (onAbort && ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      this.monitor.stop(ctx.runId);
      if (act && handle) this.active.delete(`${s.node.nodeId}/${handle}`);
      let clean = true;
      if (handle)
        clean =
          (await rt.destroy(handle).then(
            () => true,
            () => false,
          )) && clean;
      if (created)
        clean =
          (await rt.destroyWorkspace(workspaceId).then(
            () => true,
            () => false,
          )) && clean;
      s.inflight--;
      if (clean)
        this.emit({
          type: 'cleanup_ok',
          nodeId: s.node.nodeId,
          orgId: ctx.orgId,
          runId: ctx.runId,
        });
      else {
        this.emit({
          type: 'cleanup_failed',
          nodeId: s.node.nodeId,
          orgId: ctx.orgId,
          runId: ctx.runId,
        });
        this.quarantine(s.node.nodeId, 'cleanup_failed');
      }
    }
    this.emit({
      type: 'run_finished',
      nodeId: s.node.nodeId,
      orgId: ctx.orgId,
      runId: ctx.runId,
      detail: { status: outcome.status },
    });
    try {
      this.cfg.onUsage?.({
        orgId: ctx.orgId,
        runId: ctx.runId,
        nodeId: s.node.nodeId,
        runtimeClass: s.attestation.runtime.class,
        profile: decision.profile,
        usage: finalUsage,
        status: outcome.status,
      });
    } catch {
      /* accounting observer failure never changes the outcome */
    }
    return outcome;
  }

  /** null = placement allowed; otherwise the refusal reason. Evaluated BEFORE any workspace exists on the node. */
  private async checkPlacement(
    s: NodeState,
    ctx: ExecutionRunContext,
    run: RunInputs,
  ): Promise<string | null> {
    const r = this.cfg.residency;
    if (!r || !r.enforce) return null;
    const refuse = (why: string) => {
      this.emit({
        type: 'placement_refused',
        nodeId: s.node.nodeId,
        orgId: ctx.orgId,
        runId: ctx.runId,
        detail: { reason: why },
      });
      return `placement_refused:${why}`;
    };
    const dataRegion = run.dataRegion;
    if (!s.node.region || !dataRegion)
      return r.syntheticOnly === true
        ? null
        : refuse(!s.node.region ? 'node_region_unknown' : 'data_region_unknown');
    try {
      const d = await r.evaluate({
        orgId: ctx.orgId,
        runId: ctx.runId,
        dataRegion,
        nodeRegion: s.node.region,
      });
      return d.allowed ? null : refuse(`residency_${d.reason}`.slice(0, 60));
    } catch {
      return refuse('residency_check_failed'); // fail closed
    }
  }

  /** read bounded content of each candidate, let the artifact policy judge and hash it, and hand accepted content to the sink; only verified metadata leaves */
  private async extractArtifacts(
    s: NodeState,
    workspaceId: string,
    ctx: ExecutionRunContext,
    run: RunInputs,
  ): Promise<ExecutionOutcome['artifacts']> {
    const policy = this.cfg.artifactPolicy ?? DEFAULT_ARTIFACT_POLICY;
    let listed: ProducedFile[];
    try {
      listed = await s.node.runtime.listProduced(workspaceId);
    } catch {
      return [];
    }
    const withContent: ProducedFile[] = [];
    const contents = new Map<string, string>();
    for (const f of listed.slice(0, policy.maxFiles + 50)) {
      if (
        f.kind === 'file' &&
        Number.isInteger(f.bytes) &&
        f.bytes >= 0 &&
        f.bytes <= policy.maxFileBytes
      ) {
        try {
          const c = await s.node.runtime.readProduced(workspaceId, f.path, policy.maxFileBytes);
          contents.set(f.path, c);
          withContent.push({ ...f, bytes: Buffer.byteLength(c), content: c, sha256: undefined });
          continue;
        } catch {
          /* unreadable: reported as refused by the policy below */
        }
      }
      withContent.push({ ...f, content: undefined });
    }
    const decision = collectArtifacts(withContent, policy);
    for (const r of decision.refused)
      this.emit({
        type: 'artifact_refused',
        nodeId: s.node.nodeId,
        orgId: ctx.orgId,
        runId: ctx.runId,
        detail: { reason: r.reason },
      });
    const out: ExecutionOutcome['artifacts'] = [];
    for (const a of decision.accepted) {
      const content = contents.get(a.path);
      if (content === undefined || sha256(content) !== a.sha256) continue;
      try {
        await (run.artifactSink ?? this.cfg.artifactSink)?.put({
          orgId: ctx.orgId,
          runId: ctx.runId,
          path: a.path,
          sha256: a.sha256,
          bytes: a.bytes,
          content,
        });
      } catch {
        continue;
      }
      out.push({ path: a.path, bytes: a.bytes, sha256: a.sha256 });
    }
    return out;
  }
}

export interface RunInputs {
  /**
   * a snapshot of the project at the version the caller names in `ctx.source` (the repair loop builds a NEW version each round); screened for secrets before it leaves the
   * control plane. Called once per run, never cached across runs.
   */
  seedFiles: (source?: ExecutionRunContext['source']) => ReadonlyMap<string, string>;
  canaries: () => readonly string[];
  artifactSink?: ArtifactSink;
  /** the project's data region, from the platform's project record (never from the model or the request) */
  dataRegion?: string;
}

class RealRuntimePort implements ExecutionPort {
  constructor(
    private readonly svc: RealRuntimeService,
    private readonly ectx: ExecContext,
    private readonly run_: RunInputs,
  ) {}
  get origin(): PortOrigin {
    return this.svc.origin;
  }
  private readonly issued = new IssuedDecisions();
  async request(req: ExecRequest): Promise<ExecDecision> {
    const d = decideExec(req, this.ectx);
    this.issued.record(d, this.ectx.orgId, this.ectx.runId);
    return d;
  }
  async run(decision: ExecDecision, ctx: ExecutionRunContext): Promise<ExecutionOutcome> {
    if (!decision.allowed) return refusal(`request refused: ${decision.reasons.join(',')}`);
    if (ctx.orgId !== this.ectx.orgId || ctx.runId !== this.ectx.runId)
      return refusal('another_tenant_or_run');
    if (!this.issued.has(decision, this.ectx.orgId, this.ectx.runId))
      return refusal('decision_not_issued_by_gateway');
    if (decision.requiresApproval && !ctx.approvalId) return refusal('approval_required');
    if (ctx.signal?.aborted) return refusal('terminated', 'terminated');
    const env = checkRunEnv(decision.env);
    if (!env.ok) return refusal('environment_not_the_constant');
    return this.svc.execute(decision, ctx, this.run_);
  }
}
