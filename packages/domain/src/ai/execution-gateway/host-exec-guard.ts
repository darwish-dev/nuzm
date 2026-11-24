/**
 * P3-S02: the ONE guard in front of every code path that starts a process on the machine the API runs on (the "host runners" that exist for local development and template tests).
 * Generated or customer-supplied code must only ever run in the qualified isolated runtime (`RealRuntimeService`); these paths are NOT isolated (`isolation: 'none'`). The guard is
 * DEFAULT-DENY and refuses unless ALL of these hold:
 *   1. `NODE_ENV` is not `production`;
 *   2. the explicit opt-in `NUZM_LOCAL_DEV_EXEC=1` is set in the environment;
 *   3. the run carries a `TemplateOriginProof`: a server-side object minted by `templateOrigin(id)` from code we author (deterministic template output). It is a class instance with a
 *      private constructor, so no JSON request body, query string, database row or model output can ever produce one; any other value (a string `'template'`, `{kind:'template'}`,
 *      `undefined`, `'model'`, `'customer'`) is refused. There is deliberately no parser from text to proof.
 * Every decision (allowed or refused) is reported to the installed auditor (`setHostExecAuditor`, wired by the application to the audit sink; a no-op by default). A refusal throws
 * `HostExecRefused` with content-free reason codes.
 */
export type HostExecPath = 'local-dev-sandbox' | 'live-preview' | 'mobile-local-build' | 'git-store';
export class TemplateOriginProof {
  private constructor(readonly templateId: string) {}
  /** @internal minted only through `templateOrigin` */
  static mint(templateId: string): TemplateOriginProof {
    return new TemplateOriginProof(templateId);
  }
}
/** server-side only: the id names a template WE author (apps/api/templates/*, or a test fixture); it is recorded in the audit event */
export function templateOrigin(templateId: string): TemplateOriginProof {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(templateId)) throw new Error('template_id_invalid');
  return TemplateOriginProof.mint(templateId);
}
export class HostExecRefused extends Error {
  constructor(
    readonly path: HostExecPath,
    readonly reasons: string[],
  ) {
    super(`host execution refused (${path}): ${reasons.join(',')}`);
    this.name = 'HostExecRefused';
  }
}
export interface HostExecDecision {
  path: HostExecPath;
  allowed: boolean;
  reasons: string[];
  templateId?: string;
}
let auditor: (d: HostExecDecision) => void = () => undefined;
/** the application installs the audit sink here; a failing auditor never changes the decision */
export function setHostExecAuditor(f: (d: HostExecDecision) => void): void {
  auditor = f;
}
export const LOCAL_DEV_EXEC_ENV = 'NUZM_LOCAL_DEV_EXEC';

/**
 * The lighter form for a host path that starts a process but NEVER runs project code (git plumbing: `git.store`): production and the explicit opt-in only, no origin rule. Same audit,
 * same refusal type. Do not use it for anything that executes project files.
 */
export function assertHostProcessAllowed(
  path: HostExecPath,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const reasons: string[] = [];
  if (env.NODE_ENV === 'production') reasons.push('production');
  if (env[LOCAL_DEV_EXEC_ENV] !== '1') reasons.push('opt_in_missing');
  const d: HostExecDecision = { path, allowed: reasons.length === 0, reasons };
  try {
    auditor(d);
  } catch {
    /* an auditor failure never changes the decision */
  }
  if (!d.allowed) throw new HostExecRefused(path, reasons);
}

export function assertHostExecAllowed(
  path: HostExecPath,
  origin: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const reasons: string[] = [];
  if (env.NODE_ENV === 'production') reasons.push('production');
  if (env[LOCAL_DEV_EXEC_ENV] !== '1') reasons.push('opt_in_missing');
  if (!(origin instanceof TemplateOriginProof)) reasons.push('origin_not_template');
  const d: HostExecDecision = {
    path,
    allowed: reasons.length === 0,
    reasons,
    ...(origin instanceof TemplateOriginProof ? { templateId: origin.templateId } : {}),
  };
  try {
    auditor(d);
  } catch {
    /* an auditor failure never changes the decision */
  }
  if (!d.allowed) throw new HostExecRefused(path, reasons);
}
