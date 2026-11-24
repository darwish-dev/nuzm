import type { ExecLimits, NetworkClass } from './policy';

/**
 * S-AG6 (OFFLINE): the container/microVM runtime INTERFACE and its hardening specification. Nothing here starts a container. `buildRuntimeSpec` turns an allowed decision into the
 * complete, explicit specification a real runtime adapter must apply; `validateRuntimeSpec` is the independent check that refuses any specification weaker than the baseline
 * (privileged, host namespaces, runtime sockets, writable root, capabilities, unconfined seccomp, root user, missing cgroup limits, shared network, unlisted mounts). The
 * adapter that will implement `ExecutionRuntime` is SECURITY-BLOCKED (D-21, HG-10-02); `RefusingRuntime` is the only implementation and refuses everything.
 *
 * Runtime classes are evaluated in docs/security/sandbox/RUNTIME-EVALUATION.md; a plain `runc` container is NOT an acceptable class for customer-supplied code.
 */
export const ACCEPTABLE_RUNTIME_CLASSES = [
  'gvisor-runsc',
  'kata-qemu',
  'kata-firecracker',
  'firecracker-microvm',
] as const;
export type RuntimeClass = (typeof ACCEPTABLE_RUNTIME_CLASSES)[number];
export interface MountSpec {
  source: 'workspace' | 'scratch' | 'toolchain';
  target: string;
  readOnly: boolean;
}
export interface RuntimeSpec {
  runtimeClass: string;
  image: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  user: { uid: number; gid: number };
  privileged: boolean;
  hostNetwork: boolean;
  hostPid: boolean;
  hostIpc: boolean;
  readOnlyRootFs: boolean;
  noNewPrivileges: boolean;
  capabilitiesDrop: readonly string[];
  seccomp: 'default-deny' | 'runtime-default' | 'unconfined';
  mounts: readonly MountSpec[];
  /** paths that must never be mounted, whatever the source */
  network: { class: NetworkClass; ownNamespace: boolean; egressProxyOnly: boolean };
  /**
   * The DEFAULT-DENY egress allowlist the node's proxy applies (host names only, port 443). Empty for class `none`. For `registry-only` it is exactly the package-registry hosts
   * of the dependency policy (`registryHosts`); anything not listed is dropped. NEEDS A REAL NODE to be enforced; here it is data that is validated.
   */
  egressAllow: readonly { host: string; port: 443 }[];
  limits: ExecLimits & { swapMb: number };
  /** one workspace per run: the identifier is the run id and the spec never names another */
  workspaceId: string;
  orgId: string;
  runId: string;
}
export const FORBIDDEN_MOUNT_TARGETS = [
  '/var/run/docker.sock',
  '/run/containerd',
  '/var/run/crio',
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/root',
  '/host',
  '/var/lib',
  '/',
];
const ALLOWED_MOUNT_TARGETS = new Set(['/work', '/scratch', '/toolchain']);
export const REQUIRED_DROPPED_CAPS = ['ALL'] as const;

export function validateRuntimeSpec(s: RuntimeSpec): string[] {
  const v: string[] = [];
  if (!(ACCEPTABLE_RUNTIME_CLASSES as readonly string[]).includes(s.runtimeClass))
    v.push('runtime_class_not_isolating');
  if (s.privileged) v.push('privileged');
  if (s.hostNetwork) v.push('host_network');
  if (s.hostPid) v.push('host_pid');
  if (s.hostIpc) v.push('host_ipc');
  if (!s.readOnlyRootFs) v.push('root_fs_writable');
  if (!s.noNewPrivileges) v.push('new_privileges_allowed');
  if (!s.capabilitiesDrop.includes('ALL')) v.push('capabilities_not_dropped');
  if (s.seccomp === 'unconfined') v.push('seccomp_unconfined');
  if (s.user.uid === 0 || s.user.gid === 0) v.push('runs_as_root');
  if (!s.network.ownNamespace) v.push('network_namespace_shared');
  if (s.network.class === 'registry-only' && !s.network.egressProxyOnly)
    v.push('egress_not_via_proxy');
  if (s.network.class === 'none' && s.network.egressProxyOnly) v.push('network_none_with_proxy');
  if (s.network.class === 'none' && s.egressAllow.length > 0)
    v.push('egress_allow_on_network_none');
  if (s.network.class === 'registry-only') {
    if (s.egressAllow.length === 0) v.push('egress_allowlist_empty');
    if (s.egressAllow.length > 8) v.push('egress_allowlist_too_long');
  }
  for (const e of s.egressAllow)
    if (!isAllowableEgressHost(e.host) || e.port !== 443) v.push('egress_allow_entry_invalid');
  for (const m of s.mounts) {
    if (!ALLOWED_MOUNT_TARGETS.has(m.target) || FORBIDDEN_MOUNT_TARGETS.includes(m.target))
      v.push('mount_target_not_allowed');
    if (m.source === 'toolchain' && !m.readOnly) v.push('toolchain_writable');
  }
  if (!s.mounts.some((m) => m.source === 'scratch' && !m.readOnly)) v.push('no_writable_scratch');
  const l = s.limits;
  for (const k of ['cpuSeconds', 'wallSeconds', 'memoryMb', 'pids', 'diskMb'] as const)
    if (!Number.isFinite(l[k]) || l[k] <= 0) v.push(`limit_missing_${k}`);
  if (l.swapMb !== 0) v.push('swap_allowed');
  if (
    Object.keys(s.env).length === 0 ||
    Object.keys(s.env).some((k) => /^(LD_|DYLD_|NODE_OPTIONS)/.test(k))
  )
    v.push('env_invalid');
  if (!s.workspaceId.includes(s.runId)) v.push('workspace_not_bound_to_run');
  if (s.argv.length === 0) v.push('argv_empty');
  return [...new Set(v)];
}

/** a plain DNS name: no IP literal (v4 or v6), no wildcard, no single label, no internal-looking suffix, no port, no credentials */
export function isAllowableEgressHost(h: unknown): boolean {
  if (typeof h !== 'string' || h.length > 253 || h !== h.toLowerCase()) return false;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) return false;
  if (/^\d+(?:\.\d+)*$/.test(h)) return false;
  return !/\.(internal|local|localhost|lan|corp|intranet|home|arpa)$/.test(h);
}

export interface RuntimeBuildInput {
  decision: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    limits: ExecLimits;
    network: NetworkClass;
  };
  orgId: string;
  runId: string;
  runtimeClass: string;
  image: string;
  /** registry hosts the proxy may reach for class `registry-only` (from the dependency policy); ignored for class `none` */
  egressAllow?: readonly string[];
}
export function buildRuntimeSpec(i: RuntimeBuildInput): RuntimeSpec {
  return {
    runtimeClass: i.runtimeClass,
    image: i.image,
    argv: [...i.decision.argv],
    cwd: i.decision.cwd === '' ? '/work' : `/work/${i.decision.cwd}`,
    env: { ...i.decision.env },
    user: { uid: 10001, gid: 10001 },
    privileged: false,
    hostNetwork: false,
    hostPid: false,
    hostIpc: false,
    readOnlyRootFs: true,
    noNewPrivileges: true,
    capabilitiesDrop: ['ALL'],
    seccomp: 'default-deny',
    mounts: [
      { source: 'workspace', target: '/work', readOnly: false },
      { source: 'scratch', target: '/scratch', readOnly: false },
      { source: 'toolchain', target: '/toolchain', readOnly: true },
    ],
    network: {
      class: i.decision.network,
      ownNamespace: true,
      egressProxyOnly: i.decision.network === 'registry-only',
    },
    egressAllow:
      i.decision.network === 'registry-only'
        ? [...(i.egressAllow ?? [])].map((host) => ({ host, port: 443 as const }))
        : [],
    limits: { ...i.decision.limits, swapMb: 0 },
    workspaceId: `ws-${i.runId}`,
    orgId: i.orgId,
    runId: i.runId,
  };
}

/** The interface the real adapter (container / microVM) will implement. Every call carries the spec's own org and run; the handle is opaque and never reaches a model. */
export interface ExecutionRuntime {
  readonly isolation: 'none' | 'simulated' | 'verified';
  readonly runtimeClass: string;
  start(spec: RuntimeSpec): Promise<{ handle: string }>;
  wait(handle: string): Promise<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    durationMs: number;
  }>;
  stats(handle: string): Promise<{
    cpuSeconds: number;
    memoryMb: number;
    pids: number;
    diskMb: number;
    outputBytes: number;
  }>;
  kill(handle: string, how: 'soft' | 'hard'): Promise<void>;
  destroy(handle: string): Promise<void>;
  health(): Promise<{ ok: boolean; latencyMs: number; freeSlots: number; note?: string }>;
}
/** The only implementation in this repository: it starts nothing. */
export class RefusingRuntime implements ExecutionRuntime {
  readonly isolation = 'none' as const;
  readonly runtimeClass = 'none';
  private no(): never {
    throw new Error('no execution runtime: D-21 / HG-10-02 are not decided (ADR-067)');
  }
  async start(): Promise<{ handle: string }> {
    return this.no();
  }
  async wait(): Promise<never> {
    return this.no();
  }
  async stats(): Promise<never> {
    return this.no();
  }
  async kill(): Promise<void> {
    return this.no();
  }
  async destroy(): Promise<void> {
    return this.no();
  }
  async health(): Promise<{ ok: boolean; latencyMs: number; freeSlots: number; note?: string }> {
    return { ok: false, latencyMs: 0, freeSlots: 0, note: 'no_runtime' };
  }
}
