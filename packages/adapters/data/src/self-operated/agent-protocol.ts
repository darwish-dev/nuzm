import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, allow-listed node-agent protocol (M08 S32 task 3). The orchestrator NEVER runs arbitrary commands on a node (no SSH shell, no free-form
 * SQL): it sends one of the commands below, with strictly validated arguments, signed (HMAC-SHA256) with a key that lives in the vault, bound to ONE
 * node, valid for a short time and usable once (nonce). The agent refuses anything else. Adding a command means changing this file and its tests.
 */
export const AGENT_COMMANDS = [
  'bootstrap',
  'status',
  'create_role',
  'drop_role',
  'list_roles',
  'base_backup',
  'list_backups',
  'restore_new',
  'restore_in_place',
  'integrity_check',
  'apply_patch',
  'usage',
] as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[number];

export interface SignedCommand {
  v: 1;
  nodeRef: string;
  cmd: string;
  args: Record<string, unknown>;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  /** hex HMAC-SHA256 over the canonical form of every other field. */
  sig: string;
}
export const COMMAND_TTL_MS = 60_000;
export const CLOCK_SKEW_MS = 5_000;

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );
const body = (c: Omit<SignedCommand, 'sig'>) =>
  canonical({
    v: c.v,
    nodeRef: c.nodeRef,
    cmd: c.cmd,
    args: c.args,
    nonce: c.nonce,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
  });

export function signCommand(
  key: Uint8Array,
  nodeRef: string,
  cmd: AgentCommand,
  args: Record<string, unknown>,
  nowMs: number,
): SignedCommand {
  const c = {
    v: 1 as const,
    nodeRef,
    cmd,
    args,
    nonce: randomBytes(16).toString('hex'),
    issuedAt: nowMs,
    expiresAt: nowMs + COMMAND_TTL_MS,
  };
  return { ...c, sig: createHmac('sha256', key).update(body(c)).digest('hex') };
}

export type AgentRefusal =
  | 'bad_signature'
  | 'wrong_node'
  | 'expired'
  | 'not_yet_valid'
  | 'replayed'
  | 'not_allowed'
  | 'bad_arguments';
export class AgentRefusedError extends Error {
  constructor(
    readonly refusal: AgentRefusal,
    message?: string,
  ) {
    super(message ?? refusal);
    this.name = 'AgentRefusedError';
  }
}

const ID = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;
const SQL_UNSAFE = /[;'"`\\$\s]/;
type Validator = (a: Record<string, unknown>) => boolean;
const only = (a: Record<string, unknown>, keys: string[]) =>
  Object.keys(a).every((k) => keys.includes(k));
const idArg = (v: unknown) => typeof v === 'string' && ID.test(v);
const cidrs = (v: unknown) =>
  Array.isArray(v) &&
  v.length <= 32 &&
  v.every((c) => typeof c === 'string' && /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(c));
/** Argument schema per command: unknown keys, free-text and shell/SQL metacharacters are refused. */
export const ARG_VALIDATORS: Record<AgentCommand, Validator> = {
  bootstrap: (a) =>
    only(a, [
      'engine',
      'version',
      'listen',
      'allowCidrs',
      'tlsRequired',
      'archiveBucket',
      'dataRegion',
    ]) &&
    ['postgresql', 'mysql', 'redis'].includes(a.engine as string) &&
    typeof a.version === 'string' &&
    /^\d{1,3}(\.\d{1,3}){0,2}$/.test(a.version) &&
    (a.listen === 'private' || a.listen === 'allowlist') &&
    (a.allowCidrs === undefined || cidrs(a.allowCidrs)) &&
    a.tlsRequired === true && // TLS is not optional
    idArg(a.archiveBucket) &&
    idArg(a.dataRegion),
  status: (a) => only(a, []),
  create_role: (a) =>
    only(a, ['role', 'credentialId', 'keepPrevious']) &&
    idArg(a.role) &&
    !SQL_UNSAFE.test(String(a.role)) &&
    idArg(a.credentialId) &&
    typeof a.keepPrevious === 'boolean',
  drop_role: (a) => only(a, ['credentialId']) && idArg(a.credentialId),
  list_roles: (a) => only(a, []),
  list_backups: (a) => only(a, []),
  base_backup: (a) =>
    only(a, ['backupId', 'kind']) &&
    idArg(a.backupId) &&
    ['manual', 'scheduled', 'pre_restore', 'final'].includes(a.kind as string),
  restore_new: (a) =>
    only(a, ['backupId', 'sourceNodeRef']) && idArg(a.backupId) && idArg(a.sourceNodeRef),
  restore_in_place: (a) => only(a, ['backupId']) && idArg(a.backupId),
  integrity_check: (a) =>
    only(a, ['sampleTables']) &&
    Number.isInteger(a.sampleTables) &&
    (a.sampleTables as number) >= 1 &&
    (a.sampleTables as number) <= 1000,
  apply_patch: (a) => only(a, ['policy']) && ['minor', 'security'].includes(a.policy as string),
  usage: (a) => only(a, []),
};

/** What an agent does before it executes anything. Exported so that the real agent and the fake share one verifier (and one test-suite). */
export class CommandVerifier {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly key: Uint8Array,
    private readonly nodeRef: string,
    private readonly now: () => number,
  ) {}
  verify(c: SignedCommand): { cmd: AgentCommand; args: Record<string, unknown> } {
    const want = createHmac('sha256', this.key).update(body(c)).digest();
    const got = Buffer.from(typeof c.sig === 'string' ? c.sig : '', 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want))
      throw new AgentRefusedError('bad_signature');
    if (c.nodeRef !== this.nodeRef) throw new AgentRefusedError('wrong_node');
    const t = this.now();
    if (c.issuedAt - CLOCK_SKEW_MS > t) throw new AgentRefusedError('not_yet_valid');
    if (t >= c.expiresAt || c.expiresAt - c.issuedAt > COMMAND_TTL_MS)
      throw new AgentRefusedError('expired');
    for (const [n, e] of this.seen) if (e <= t) this.seen.delete(n);
    if (this.seen.has(c.nonce)) throw new AgentRefusedError('replayed');
    if (!(AGENT_COMMANDS as readonly string[]).includes(c.cmd))
      throw new AgentRefusedError(
        'not_allowed',
        `command ${String(c.cmd).slice(0, 40)} is not on the allow-list`,
      );
    const cmd = c.cmd as AgentCommand;
    if (
      typeof c.args !== 'object' ||
      c.args === null ||
      Array.isArray(c.args) ||
      !ARG_VALIDATORS[cmd](c.args)
    )
      throw new AgentRefusedError('bad_arguments');
    this.seen.set(c.nonce, c.expiresAt);
    return { cmd, args: c.args };
  }
}
