import type { ProducedFile } from '../artifacts';
import type { RuntimeSpec, MountSpec } from '../runtime-spec';
import type { NetworkClass } from '../policy';
import type { RuntimeIdentity, WaitResult, WorkspaceSpec } from '../real-runtime/workspace-runtime';

/**
 * P3-S02: the NODE PROTOCOL, i.e. the wire format between the control plane's node client (`RemoteWorkspaceRuntime`) and the node agent (`packages/runtime-agent`).
 *
 * One JSON document per request, `POST /v1/<op>`, authenticated by (a) mutual TLS at the transport and (b) a short-lived signed request token bound to the operation, the body hash,
 * the node and (where the body names them) the organization and workspace (`token.ts`). Parsing here is STRICT and total: an unknown operation, an unknown member, a wrong type or
 * an oversize value is a refusal with a content-free code; nothing is coerced. The agent parses with the same functions the tests use, so the two sides cannot drift.
 *
 * Nothing in this file starts a process, opens a socket or touches the file system.
 */
export const NODE_PROTOCOL_VERSION = 1 as const;
export const NODE_OPS = [
  'identity',
  'health',
  'createWorkspace',
  'putFiles',
  'start',
  'wait',
  'stats',
  'kill',
  'destroy',
  'listProduced',
  'readProduced',
  'destroyWorkspace',
  'listWorkspaces',
  'emergencyStop',
  'reap',
] as const;
export type NodeOp = (typeof NODE_OPS)[number];
/** operations only an operator-scoped token may call (the control plane's emergency path) */
export const ADMIN_OPS: ReadonlySet<NodeOp> = new Set(['emergencyStop', 'reap']);

export const NODE_LIMITS = {
  /** whole request body */
  maxBodyBytes: 8 * 1024 * 1024,
  maxFiles: 5_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxPathLength: 300,
  maxIdLength: 120,
  /** the agent answers a `wait` after at most this long with `{done:false}`; the client loops (no connection idles for a whole build) */
  maxWaitSliceMs: 25_000,
  maxReadBytes: 5 * 1024 * 1024,
} as const;

export type NodeRequestMap = {
  identity: Record<string, never>;
  health: Record<string, never>;
  createWorkspace: WorkspaceSpec;
  putFiles: { workspaceId: string; files: [string, string][] };
  start: { spec: RuntimeSpec };
  wait: { handle: string; maxWaitMs: number };
  stats: { handle: string };
  kill: { handle: string; how: 'soft' | 'hard' };
  destroy: { handle: string };
  listProduced: { workspaceId: string };
  readProduced: { workspaceId: string; path: string; maxBytes: number };
  destroyWorkspace: { workspaceId: string };
  listWorkspaces: Record<string, never>;
  emergencyStop: Record<string, never>;
  reap: Record<string, never>;
};
export interface NodeStats {
  cpuSeconds: number;
  memoryMb: number;
  pids: number;
  diskMb: number;
  outputBytes: number;
}
export type NodeResponseMap = {
  identity: RuntimeIdentity & { agentVersion: string; protocol: number };
  health: { ok: boolean; latencyMs: number; freeSlots: number; note?: string };
  createWorkspace: Record<string, never>;
  putFiles: Record<string, never>;
  start: { handle: string };
  wait: { done: false } | { done: true; result: WaitResult };
  stats: NodeStats;
  kill: Record<string, never>;
  destroy: Record<string, never>;
  listProduced: { files: ProducedFile[] };
  readProduced: { content: string };
  destroyWorkspace: Record<string, never>;
  listWorkspaces: {
    workspaces: { workspaceId: string; orgId: string; runId: string; createdAt: number }[];
  };
  emergencyStop: { killed: number; destroyed: number; failed: number };
  reap: { reaped: number; failed: number };
};
export type NodeResponse<O extends NodeOp> =
  | { ok: true; result: NodeResponseMap[O] }
  | {
      ok: false;
      error: {
        code: string;
        /** content-free: violation codes only (for `spec_refused`) */ detail?: string;
      };
    };

/** the codes an agent may answer with; the client turns each into `Error(code)` so the existing control plane (`real-runtime.ts`) keeps matching on them */
export const NODE_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'too_large',
  'conflict',
  'no_capacity',
  'unknown_workspace',
  'unknown_handle',
  'workspace_exists',
  'workspace_not_bound_to_run',
  'workspace_tenant_mismatch',
  'disk_quota_missing',
  'path_escapes_workspace',
  'not_a_regular_file',
  'image_not_attested',
  'spec_refused',
  'node_disabled',
  'platform_refused',
  'destroy_failed',
  'internal',
] as const;
export type NodeErrorCode = (typeof NODE_ERROR_CODES)[number];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).every((k) => keys.includes(k));
const id = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= NODE_LIMITS.maxIdLength &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v);
const posInt = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const strArr = (v: unknown, maxLen: number, maxItems: number): v is string[] =>
  Array.isArray(v) &&
  v.length <= maxItems &&
  v.every((x) => typeof x === 'string' && x.length <= maxLen);

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; code: 'bad_request' | 'too_large' };
const bad = <T>(): ParseResult<T> => ({ ok: false, code: 'bad_request' });

/** a relative, normalised path inside a workspace: no absolute path, no `..`, no empty or `.` segment, no NUL or backslash */
export function isWorkspaceRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > NODE_LIMITS.maxPathLength) return false;
  if (p.startsWith('/') || p.includes('\0') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const NETWORK_CLASSES: readonly NetworkClass[] = ['none', 'registry-only'];
const SPEC_KEYS = [
  'runtimeClass',
  'image',
  'argv',
  'cwd',
  'env',
  'user',
  'privileged',
  'hostNetwork',
  'hostPid',
  'hostIpc',
  'readOnlyRootFs',
  'noNewPrivileges',
  'capabilitiesDrop',
  'seccomp',
  'mounts',
  'network',
  'egressAllow',
  'limits',
  'workspaceId',
  'orgId',
  'runId',
] as const;
/**
 * Shape check only (types and sizes). It deliberately does NOT judge the spec: `validateRuntimeSpec` does, on the node and again in the control plane, so a weak spec arrives
 * here as a well-formed object and is refused for the right reason. A spec that is not even well formed is `bad_request`.
 */
export function parseRuntimeSpec(v: unknown): RuntimeSpec | null {
  if (!isObj(v) || !onlyKeys(v, SPEC_KEYS)) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.runtimeClass !== 'string' || s.runtimeClass.length > 60) return null;
  if (typeof s.image !== 'string' || s.image.length > 200) return null;
  if (!strArr(s.argv, 1_000, 64)) return null;
  if (typeof s.cwd !== 'string' || s.cwd.length > NODE_LIMITS.maxPathLength) return null;
  if (!isObj(s.env) || Object.keys(s.env).length > 64) return null;
  if (!Object.values(s.env).every((x) => typeof x === 'string' && x.length <= 2_000)) return null;
  const u = s.user;
  if (!isObj(u) || !onlyKeys(u, ['uid', 'gid']) || !num(u.uid) || !num(u.gid)) return null;
  for (const k of [
    'privileged',
    'hostNetwork',
    'hostPid',
    'hostIpc',
    'readOnlyRootFs',
    'noNewPrivileges',
  ])
    if (!bool(s[k])) return null;
  if (!strArr(s.capabilitiesDrop, 40, 64)) return null;
  if (!['default-deny', 'runtime-default', 'unconfined'].includes(s.seccomp as string)) return null;
  if (!Array.isArray(s.mounts) || s.mounts.length > 8) return null;
  for (const m of s.mounts) {
    if (!isObj(m) || !onlyKeys(m, ['source', 'target', 'readOnly'])) return null;
    if (!['workspace', 'scratch', 'toolchain'].includes(m.source as string)) return null;
    if (typeof m.target !== 'string' || m.target.length > 100 || !bool(m.readOnly)) return null;
  }
  const n = s.network;
  if (!isObj(n) || !onlyKeys(n, ['class', 'ownNamespace', 'egressProxyOnly'])) return null;
  if (
    !NETWORK_CLASSES.includes(n.class as NetworkClass) ||
    !bool(n.ownNamespace) ||
    !bool(n.egressProxyOnly)
  )
    return null;
  if (!Array.isArray(s.egressAllow) || s.egressAllow.length > 64) return null;
  for (const e of s.egressAllow)
    if (
      !isObj(e) ||
      !onlyKeys(e, ['host', 'port']) ||
      typeof e.host !== 'string' ||
      e.host.length > 260 ||
      !num(e.port)
    )
      return null;
  const l = s.limits;
  if (
    !isObj(l) ||
    !onlyKeys(l, [
      'cpuSeconds',
      'wallSeconds',
      'memoryMb',
      'pids',
      'outputKb',
      'diskMb',
      'swapMb',
    ]) ||
    !['cpuSeconds', 'wallSeconds', 'memoryMb', 'pids', 'outputKb', 'diskMb', 'swapMb'].every((k) =>
      num(l[k]),
    )
  )
    return null;
  if (!id(s.workspaceId) || !id(s.orgId) || !id(s.runId)) return null;
  return s as unknown as RuntimeSpec;
}

/** parse and validate the body of one operation. `body` is the already JSON-parsed value. */
export function parseNodeRequest<O extends NodeOp>(
  op: O,
  body: unknown,
): ParseResult<NodeRequestMap[O]> {
  const ok = (value: unknown): ParseResult<NodeRequestMap[O]> => ({
    ok: true,
    value: value as NodeRequestMap[O],
  });
  if (!isObj(body)) return bad();
  switch (op) {
    case 'identity':
    case 'health':
    case 'listWorkspaces':
    case 'emergencyStop':
    case 'reap':
      return Object.keys(body).length === 0 ? ok({}) : bad();
    case 'createWorkspace':
      if (!onlyKeys(body, ['workspaceId', 'orgId', 'runId', 'diskMb'])) return bad();
      if (!id(body.workspaceId) || !id(body.orgId) || !id(body.runId)) return bad();
      if (!posInt(body.diskMb, 64 * 1024)) return bad();
      return ok({
        workspaceId: body.workspaceId,
        orgId: body.orgId,
        runId: body.runId,
        diskMb: body.diskMb,
      });
    case 'putFiles': {
      if (!onlyKeys(body, ['workspaceId', 'files']) || !id(body.workspaceId)) return bad();
      if (!Array.isArray(body.files) || body.files.length > NODE_LIMITS.maxFiles) return bad();
      const files: [string, string][] = [];
      const seen = new Set<string>();
      for (const f of body.files) {
        if (!Array.isArray(f) || f.length !== 2) return bad();
        const [p, c] = f as [unknown, unknown];
        if (!isWorkspaceRelativePath(p) || typeof c !== 'string') return bad();
        if (Buffer.byteLength(c) > NODE_LIMITS.maxFileBytes)
          return { ok: false, code: 'too_large' };
        if (seen.has(p)) return bad();
        seen.add(p);
        files.push([p, c]);
      }
      return ok({ workspaceId: body.workspaceId, files });
    }
    case 'start': {
      if (!onlyKeys(body, ['spec'])) return bad();
      const spec = parseRuntimeSpec(body.spec);
      return spec ? ok({ spec }) : bad();
    }
    case 'wait':
      if (!onlyKeys(body, ['handle', 'maxWaitMs']) || !id(body.handle)) return bad();
      if (!posInt(body.maxWaitMs, NODE_LIMITS.maxWaitSliceMs)) return bad();
      return ok({ handle: body.handle, maxWaitMs: body.maxWaitMs });
    case 'stats':
    case 'destroy':
      return onlyKeys(body, ['handle']) && id(body.handle) ? ok({ handle: body.handle }) : bad();
    case 'kill':
      return onlyKeys(body, ['handle', 'how']) &&
        id(body.handle) &&
        (body.how === 'soft' || body.how === 'hard')
        ? ok({ handle: body.handle, how: body.how })
        : bad();
    case 'listProduced':
    case 'destroyWorkspace':
      return onlyKeys(body, ['workspaceId']) && id(body.workspaceId)
        ? ok({ workspaceId: body.workspaceId })
        : bad();
    case 'readProduced':
      if (!onlyKeys(body, ['workspaceId', 'path', 'maxBytes']) || !id(body.workspaceId))
        return bad();
      if (!isWorkspaceRelativePath(body.path) || !posInt(body.maxBytes, NODE_LIMITS.maxReadBytes))
        return bad();
      return ok({ workspaceId: body.workspaceId, path: body.path, maxBytes: body.maxBytes });
    default:
      return bad();
  }
}

/** the workspace (and organization, when the body carries one) an operation addresses: the token must be bound to exactly these */
export function requestBinding(
  op: NodeOp,
  req: unknown,
): { workspaceId?: string; orgId?: string; handle?: string } {
  const r = req as Record<string, unknown>;
  switch (op) {
    case 'createWorkspace':
      return { workspaceId: r.workspaceId as string, orgId: r.orgId as string };
    case 'start': {
      const s = r.spec as RuntimeSpec;
      return { workspaceId: s.workspaceId, orgId: s.orgId };
    }
    case 'putFiles':
    case 'listProduced':
    case 'readProduced':
    case 'destroyWorkspace':
      return { workspaceId: r.workspaceId as string };
    case 'wait':
    case 'stats':
    case 'kill':
    case 'destroy':
      return { handle: r.handle as string };
    default:
      return {};
  }
}

export type { MountSpec };
