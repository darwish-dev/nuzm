import { normalizeToolDir } from '../agent-tools/paths';

/**
 * S-AG6 (OFFLINE PREPARATION): the policy core of the Execution Gateway (ADR-069, PROPOSED). Pure functions only: nothing here starts a process, touches a runtime or is wired
 * to any route, tool declaration or job. The model NEVER supplies a command line: it names a profile from a closed catalogue and gives typed parameters; this module maps
 * that to a fixed argv, a fixed environment, fixed limits and a network class, or refuses with reasons. Whether anything may run at all is decided by `executionGate`, which
 * stays closed until D-21 is decided, a runtime passed the escape suite and the owner approved (and, in production, D-AG-ROLLOUT).
 */
export type NetworkClass = 'none' | 'registry-only';
export interface ExecLimits {
  cpuSeconds: number;
  wallSeconds: number;
  memoryMb: number;
  pids: number;
  outputKb: number;
  diskMb: number;
}
export interface ExecProfile {
  id: string;
  /** the fixed program and arguments; `{script}` and `{dir}` are the only substitutions, filled from VALIDATED parameters */
  argv: readonly string[];
  network: NetworkClass;
  limits: ExecLimits;
  /** a human approves before it runs (anything that reaches a network, installs code, or is paid) */
  approval: 'none' | 'human';
  params: { script?: true; dir?: true };
}
const BASE: ExecLimits = {
  cpuSeconds: 120,
  wallSeconds: 180,
  memoryMb: 1024,
  pids: 128,
  outputKb: 256,
  diskMb: 512,
};
export const EXEC_PROFILES: Readonly<Record<string, ExecProfile>> = {
  typecheck: {
    id: 'typecheck',
    argv: ['npx', '--no-install', 'tsc', '--noEmit'],
    network: 'none',
    limits: BASE,
    approval: 'none',
    params: {},
  },
  'unit-tests': {
    id: 'unit-tests',
    argv: ['npm', 'test', '--silent'],
    network: 'none',
    limits: BASE,
    approval: 'none',
    params: {},
  },
  build: {
    id: 'build',
    argv: ['npm', 'run', 'build', '--silent'],
    network: 'none',
    limits: { ...BASE, wallSeconds: 300, memoryMb: 2048 },
    approval: 'none',
    params: {},
  },
  'run-script': {
    id: 'run-script',
    argv: ['npm', 'run', '{script}', '--silent'],
    network: 'none',
    limits: BASE,
    approval: 'human',
    params: { script: true },
  },
  'install-deps': {
    id: 'install-deps',
    argv: ['npm', 'ci', '--ignore-scripts'],
    network: 'registry-only',
    limits: { ...BASE, wallSeconds: 300, diskMb: 2048 },
    approval: 'human',
    params: {},
  },
};
/** npm lifecycle and publishing scripts are never runnable through `run-script`, whatever the project defines. */
const DENIED_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
  'prepare',
  'preuninstall',
  'uninstall',
  'postuninstall',
]);
const SCRIPT_NAME = /^[a-z][a-z0-9:_-]{0,40}$/;
/** the whole environment of a run: nothing from the request, nothing from the platform */
export const EXEC_ENV: Readonly<Record<string, string>> = {
  CI: '1',
  NODE_ENV: 'test',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/sandbox',
  NO_UPDATE_NOTIFIER: '1',
};

export interface ExecRequest {
  orgId: string;
  runId: string;
  profile: unknown;
  params?: unknown;
  /** anything else the model tried to send: refused by name */
  [extra: string]: unknown;
}
export interface ExecContext {
  orgId: string;
  runId: string;
  /** the profiles the organization's plan and the owner allow; default none */
  enabledProfiles: readonly string[];
  /** the scripts declared in the project's package.json */
  projectScripts: readonly string[];
}
export type ExecDecision =
  | { allowed: false; reasons: string[] }
  | {
      allowed: true;
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      limits: ExecLimits;
      network: NetworkClass;
      requiresApproval: boolean;
      profile: string;
    };
const KNOWN_KEYS = new Set(['orgId', 'runId', 'profile', 'params']);

export function decideExec(req: ExecRequest, ctx: ExecContext): ExecDecision {
  const reasons: string[] = [];
  // the model-supplied surface is closed: any other member (argv, command, env, shell, cwd, args...) is refused by name
  for (const k of Object.keys(req))
    if (!KNOWN_KEYS.has(k))
      reasons.push(`model_supplied_${/^[A-Za-z_]{1,20}$/.test(k) ? k : 'member'}`);
  if (req.orgId !== ctx.orgId || req.runId !== ctx.runId) reasons.push('another_tenant_or_run');
  // own properties only: `__proto__`, `constructor` and `toString` are inherited names and must read as an UNKNOWN profile, not as an object
  const profile =
    typeof req.profile === 'string' &&
    Object.prototype.hasOwnProperty.call(EXEC_PROFILES, req.profile)
      ? EXEC_PROFILES[req.profile]
      : undefined;
  if (!profile) reasons.push('unknown_profile');
  else if (!ctx.enabledProfiles.includes(profile.id)) reasons.push('profile_not_enabled');
  const p = req.params;
  if (p !== undefined && (typeof p !== 'object' || p === null || Array.isArray(p)))
    reasons.push('params_not_an_object');
  const params = (typeof p === 'object' && p !== null && !Array.isArray(p) ? p : {}) as Record<
    string,
    unknown
  >;
  let script: string | undefined;
  let cwd = '';
  if (profile) {
    for (const k of Object.keys(params))
      if (k !== 'dir' && !(k === 'script' && profile.params.script))
        reasons.push(`unexpected_param_${/^[A-Za-z_]{1,20}$/.test(k) ? k : 'member'}`);
    if (profile.params.script) {
      const s = params.script;
      if (typeof s !== 'string' || !SCRIPT_NAME.test(s)) reasons.push('script_name_invalid');
      else if (DENIED_SCRIPTS.has(s)) reasons.push('script_denied');
      else if (!ctx.projectScripts.includes(s)) reasons.push('script_not_in_project');
      else script = s;
    }
    if (params.dir !== undefined) {
      const d = normalizeToolDir(params.dir);
      if (!d.ok) reasons.push('dir_outside_project');
      else cwd = d.dir;
    }
  }
  if (reasons.length > 0 || !profile) return { allowed: false, reasons: [...new Set(reasons)] };
  return {
    allowed: true,
    argv: profile.argv.map((a) => (a === '{script}' ? script! : a)),
    cwd,
    env: { ...EXEC_ENV },
    limits: { ...profile.limits },
    network: profile.network,
    requiresApproval: profile.approval === 'human',
    profile: profile.id,
  };
}

export interface ExecGateState {
  /** D-21 decided (the isolation technology and its security review HG-10-02) */
  d21Decided: boolean;
  /** the runtime in use is `isolation: verified` and passed the escape suite (every isolating attempt BLOCKED, none ESCAPED) */
  runtimeVerified: boolean;
  escapeSuitePassed: boolean;
  /** the Execution Gateway ADR accepted */
  adrAccepted: boolean;
  ownerApproved: boolean;
  /** the process is production */
  production: boolean;
  /** D-AG-ROLLOUT (production rollout of executable capabilities) decided. Formerly called D-42, an id that docs/07 gives to the platform object store. */
  rolloutDecided: boolean;
}
/** Execution is open only when every condition holds. Default state (all false) is closed: that is today's state. */
export function executionGate(s: ExecGateState): { open: boolean; blockers: string[] } {
  const b: string[] = [];
  if (!s.d21Decided) b.push('D-21 (isolation technology and its security review) is not decided');
  if (!s.runtimeVerified) b.push('no runtime is isolation-verified');
  if (!s.escapeSuitePassed) b.push('the escape suite has not passed on a verified runtime');
  if (!s.adrAccepted) b.push('the Execution Gateway ADR is not accepted');
  if (!s.ownerApproved) b.push('the owner has not approved execution');
  if (s.production && !s.rolloutDecided) b.push('D-AG-ROLLOUT (production rollout) is not decided');
  return { open: b.length === 0, blockers: b };
}
export const CLOSED_GATE: ExecGateState = {
  d21Decided: false,
  runtimeVerified: false,
  escapeSuitePassed: false,
  adrAccepted: false,
  ownerApproved: false,
  production: false,
  rolloutDecided: false,
};
