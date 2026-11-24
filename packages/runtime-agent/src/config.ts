import { executionGateway as eg } from '@nuzm/domain';

/**
 * Agent configuration: a JSON file written by the node bootstrap, owned by root, mode 0600/0640. It contains PATHS to the agent's own TLS material and PUBLIC keys only: no
 * secret value is ever inline. `parseAgentConfig` is strict and fail-closed: an unknown member, a wildcard listener, a simulated launcher on a non-loopback address, a real launcher
 * without an enforcing disk quota, or an image digest that is not `sha256:<64 hex>` is an error and the agent does not start.
 */
export interface AgentConfig {
  nodeId: string;
  endpointId: string;
  runtimeClass: 'gvisor-runsc';
  /** management-interface address the mTLS listener binds to (never a wildcard) */
  listen: { host: string; port: number };
  /** loopback-only plain-text metrics listener (Prometheus exposition) */
  metrics: { host: '127.0.0.1'; port: number };
  tls: {
    keyFile: string;
    certFile: string;
    /** CA that signs the control plane's client certificates */
    caFile: string;
    /** sha256 hex fingerprints of the control-plane client certificates that may connect (pinned; a CA alone is not enough) */
    clientFingerprints: string[];
  };
  /** control-plane token verification keys (PEM SPKI, public only), by key id */
  trustedControlKeys: Record<string, string>;
  workspaceRoot: string;
  stateDir: string;
  auditFile: string;
  /** attested image digest -> directory holding that rootfs; the digest is recomputed from the directory at start */
  images: Record<string, string>;
  toolchainDir: string;
  maxSlots: number;
  /** per-run ceilings: a spec asking for more is refused whatever the control plane says */
  ceilings: eg.ExecLimits;
  maxWorkspaceDiskMb: number;
  /** a workspace older than this with no running job is reaped */
  workspaceMaxAgeMs: number;
  outputRoots: string[];
  sandboxUid: number;
  sandboxGid: number;
  egress: { proxyAddr: string; allowHosts: string[] };
  quota: 'xfs-project' | 'accounting';
  launcher: 'runsc' | 'simulated';
  runsc: { path: string; rootDir: string; platform: 'systrap' };
  /** extra seconds after the wall limit before the agent hard-kills on its own (the control plane kills first) */
  killGraceMs: number;
  /** free space (MiB) the workspace volume must keep: `health` reports unhealthy below it */
  minFreeDiskMb: number;
}

export const AGENT_CONFIG_DEFAULTS = {
  maxSlots: 4,
  ceilings: { cpuSeconds: 600, wallSeconds: 900, memoryMb: 2048, pids: 256, outputKb: 512, diskMb: 2048 },
  maxWorkspaceDiskMb: 4096,
  workspaceMaxAgeMs: 30 * 60 * 1000,
  outputRoots: ['dist', 'build', 'out', 'coverage', 'reports'],
  sandboxUid: 10001,
  sandboxGid: 10001,
  killGraceMs: 5_000,
  minFreeDiskMb: 2048,
} as const;

const KEYS = new Set([
  'nodeId',
  'endpointId',
  'runtimeClass',
  'listen',
  'metrics',
  'tls',
  'trustedControlKeys',
  'workspaceRoot',
  'stateDir',
  'auditFile',
  'images',
  'toolchainDir',
  'maxSlots',
  'ceilings',
  'maxWorkspaceDiskMb',
  'workspaceMaxAgeMs',
  'outputRoots',
  'sandboxUid',
  'sandboxGid',
  'egress',
  'quota',
  'launcher',
  'runsc',
  'killGraceMs',
  'minFreeDiskMb',
]);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const absPath = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('/') && !v.includes('\0') && !v.split('/').includes('..');
const num = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

export function parseAgentConfig(
  raw: unknown,
): { ok: true; config: AgentConfig } | { ok: false; errors: string[] } {
  const e: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['config_not_an_object'] };
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) e.push(`unknown_member:${k}`);
  const d = AGENT_CONFIG_DEFAULTS;
  const get = <T>(k: string, dflt: T): unknown => (raw[k] === undefined ? dflt : raw[k]);

  if (typeof raw.nodeId !== 'string' || !/^[a-z0-9-]{3,40}$/.test(raw.nodeId)) e.push('nodeId_invalid');
  if (typeof raw.endpointId !== 'string' || !/^[a-z0-9-]{3,60}$/.test(raw.endpointId)) e.push('endpointId_invalid');
  if (raw.runtimeClass !== 'gvisor-runsc') e.push('runtimeClass_not_gvisor_runsc');
  const launcher = raw.launcher;
  if (launcher !== 'runsc' && launcher !== 'simulated') e.push('launcher_invalid');
  const quota = get('quota', launcher === 'runsc' ? 'xfs-project' : 'accounting');
  if (quota !== 'xfs-project' && quota !== 'accounting') e.push('quota_invalid');
  if (launcher === 'runsc' && quota !== 'xfs-project') e.push('real_launcher_requires_xfs_project_quota');

  const l = raw.listen;
  if (!isObj(l) || typeof l.host !== 'string' || !num(l.port, 1, 65535)) e.push('listen_invalid');
  else {
    if (['0.0.0.0', '::', '', '*'].includes(l.host)) e.push('listen_wildcard_refused');
    if (launcher === 'simulated' && !LOOPBACK.has(l.host)) e.push('simulated_launcher_requires_loopback_listener');
  }
  const m = raw.metrics;
  if (!isObj(m) || m.host !== '127.0.0.1' || !num(m.port, 1, 65535)) e.push('metrics_must_be_loopback');

  const t = raw.tls;
  if (!isObj(t) || !absPath(t.keyFile) || !absPath(t.certFile) || !absPath(t.caFile)) e.push('tls_paths_invalid');
  else if (
    !Array.isArray(t.clientFingerprints) ||
    t.clientFingerprints.length === 0 ||
    !t.clientFingerprints.every((f) => typeof f === 'string' && /^[0-9a-f]{64}$/.test(f))
  )
    e.push('tls_client_fingerprints_required');

  const k = raw.trustedControlKeys;
  if (!isObj(k) || Object.keys(k).length === 0) e.push('trusted_control_keys_required');
  else
    for (const [id, pem] of Object.entries(k))
      if (!/^[A-Za-z0-9._-]{1,60}$/.test(id) || typeof pem !== 'string' || !/^-----BEGIN PUBLIC KEY-----/.test(pem.trim()) || /PRIVATE/.test(pem))
        e.push(`trusted_control_key_invalid:${id.slice(0, 20)}`);

  for (const p of ['workspaceRoot', 'stateDir', 'auditFile', 'toolchainDir'] as const)
    if (!absPath(raw[p])) e.push(`${p}_invalid`);
  const im = raw.images;
  if (!isObj(im) || Object.keys(im).length === 0) e.push('images_required');
  else
    for (const [dg, dir] of Object.entries(im))
      if (!/^sha256:[0-9a-f]{64}$/.test(dg) || !absPath(dir)) e.push('image_entry_invalid');

  if (!num(get('maxSlots', d.maxSlots), 1, 64)) e.push('maxSlots_invalid');
  const c = get('ceilings', d.ceilings);
  if (!isObj(c) || !['cpuSeconds', 'wallSeconds', 'memoryMb', 'pids', 'outputKb', 'diskMb'].every((x) => num(c[x], 1, 10_000_000)) || Object.keys(c).length !== 6)
    e.push('ceilings_invalid');
  if (!num(get('maxWorkspaceDiskMb', d.maxWorkspaceDiskMb), 1, 1_000_000)) e.push('maxWorkspaceDiskMb_invalid');
  if (!num(get('workspaceMaxAgeMs', d.workspaceMaxAgeMs), 60_000, 24 * 3600_000)) e.push('workspaceMaxAgeMs_invalid');
  const roots = get('outputRoots', [...d.outputRoots]);
  if (!Array.isArray(roots) || roots.length === 0 || !roots.every((r) => eg.isWorkspaceRelativePath(r) && !String(r).includes('/')))
    e.push('outputRoots_invalid');
  if (!num(get('sandboxUid', d.sandboxUid), 10_000, 60_000) || !num(get('sandboxGid', d.sandboxGid), 10_000, 60_000))
    e.push('sandbox_ids_invalid');
  if (!num(get('killGraceMs', d.killGraceMs), 100, 60_000)) e.push('killGraceMs_invalid');
  if (!num(get('minFreeDiskMb', d.minFreeDiskMb), 0, 10_000_000)) e.push('minFreeDiskMb_invalid');

  const eo = raw.egress;
  if (!isObj(eo) || typeof eo.proxyAddr !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(eo.proxyAddr)) e.push('egress_proxyAddr_invalid');
  else if (!Array.isArray(eo.allowHosts) || !eo.allowHosts.every((h) => eg.isAllowableEgressHost(h)))
    e.push('egress_allowHosts_invalid');
  const r = raw.runsc;
  if (!isObj(r) || !absPath(r.path) || !absPath(r.rootDir) || r.platform !== 'systrap') e.push('runsc_invalid');

  if (e.length > 0) return { ok: false, errors: e };
  const out = {
    ...(raw as unknown as AgentConfig),
    maxSlots: get('maxSlots', d.maxSlots) as number,
    ceilings: { ...(get('ceilings', d.ceilings) as eg.ExecLimits) },
    maxWorkspaceDiskMb: get('maxWorkspaceDiskMb', d.maxWorkspaceDiskMb) as number,
    workspaceMaxAgeMs: get('workspaceMaxAgeMs', d.workspaceMaxAgeMs) as number,
    outputRoots: [...(roots as string[])],
    sandboxUid: get('sandboxUid', d.sandboxUid) as number,
    sandboxGid: get('sandboxGid', d.sandboxGid) as number,
    killGraceMs: get('killGraceMs', d.killGraceMs) as number,
    minFreeDiskMb: get('minFreeDiskMb', d.minFreeDiskMb) as number,
    quota: quota as AgentConfig['quota'],
  } satisfies AgentConfig;
  return { ok: true, config: out };
}
