import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * The refusal rule of the mobile build engine (P3-S06, owner approval B-Android / B-iOS).
 *
 * Generated project code and its native build scripts (Gradle, Podfile, Xcode build phases, plugin code) execute during a build. They must therefore NEVER run as the owner's normal
 * user, with the owner's environment, or next to the owner's credentials. A build runs only inside an environment that DECLARES itself disposable and passes every check below;
 * otherwise the runner refuses with `build_env_refused` BEFORE anything is written or executed.
 *
 * The declaration is made by whoever creates the environment (the image recipe in `infra/mobile/android/`, or the dedicated macOS user in `docs/mobile/ios-build-host.md`):
 *   NUZM_BUILD_ENV=disposable            the environment was created for builds and holds nothing else
 *   NUZM_BUILD_ISOLATION=container|vm|dedicated-user
 *   NUZM_BUILD_USER=<the account the build runs as>   must equal the current user
 *   NUZM_REGISTRY_MIRROR=<url>           the only registry the environment may reach (container/vm: egress is enforced outside the process; dedicated-user: NOT enforced)
 * The declaration alone proves nothing; the guard cross-checks what it can observe and reports what it cannot (`warnings`, recorded in the build's toolchain record).
 * A dedicated macOS/Linux user is NOT sandbox-class isolation (it shares the kernel, the disk and the network with the owner's session): its runs are labelled `isolation: none`
 * in the build record and are never presented as isolation evidence.
 */
export type DeclaredIsolation = 'container' | 'vm' | 'dedicated-user';
export interface EnvAssessment {
  ok: boolean;
  isolation: DeclaredIsolation | null;
  /** why the environment was refused; empty when ok */
  reasons: string[];
  /** facts the guard could not verify (network egress, disk wipe): recorded, never hidden */
  warnings: string[];
}
export interface EnvProbe {
  env: NodeJS.ProcessEnv;
  user: string;
  home: string;
  platform: NodeJS.Platform;
  exists(path: string): boolean;
}
export const defaultProbe = (): EnvProbe => ({
  env: process.env,
  user: userInfo().username,
  home: homedir(),
  platform: process.platform,
  exists: existsSync,
});

/** environment variable names that indicate a credential of the host or the platform; none may be present in a build environment */
const SECRET_NAME =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIALS?|COOKIE)(_|$)|^(DATABASE_URL|PG(PASSWORD|URI)|REDIS_URL|AWS_|GOOGLE_APPLICATION_CREDENTIALS|GH_|GITHUB_|NPM_TOKEN|ANTHROPIC_|OPENAI_|STRIPE_|SSH_AUTH_SOCK|VAULT_|NUZM_[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD|DSN|URL))/i;
/** the ONLY NUZM_/runtime variables a build environment may carry; anything else matching SECRET_NAME is refused */
const ALLOWED_NAMES = new Set([
  'NUZM_BUILD_ENV',
  'NUZM_BUILD_ISOLATION',
  'NUZM_BUILD_USER',
  'NUZM_REGISTRY_MIRROR',
  'NUZM_OWNER_USER',
]);
/** files and folders of a person's home that hold credentials; their presence means this is somebody's personal account, not a build account */
const PERSONAL_PATHS = [
  '.ssh',
  '.aws',
  '.config/gh',
  '.config/gcloud',
  '.azure',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.docker/config.json',
  '.gnupg',
  'Library/Messages',
  'Library/Mail',
  'Library/Application Support/Google/Chrome',
  'Library/Safari',
];
const DEDICATED_USER_NAME = /^nuzm[-_]?build[-_a-z0-9]*$/i;

export function assessBuildEnvironment(probe: EnvProbe = defaultProbe()): EnvAssessment {
  const e = probe.env;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const declared = e.NUZM_BUILD_ISOLATION;
  const isolation: DeclaredIsolation | null =
    declared === 'container' || declared === 'vm' || declared === 'dedicated-user'
      ? declared
      : null;

  if (e.NUZM_BUILD_ENV !== 'disposable')
    reasons.push('NUZM_BUILD_ENV is not "disposable": this is not a declared build environment');
  if (!isolation) reasons.push('NUZM_BUILD_ISOLATION must be one of container, vm, dedicated-user');
  if (!e.NUZM_BUILD_USER) reasons.push('NUZM_BUILD_USER is not set');
  else if (e.NUZM_BUILD_USER !== probe.user)
    reasons.push('NUZM_BUILD_USER is not the current user');
  if (e.NUZM_OWNER_USER && e.NUZM_OWNER_USER === probe.user)
    reasons.push('the current user is the declared owner account');
  if (isolation === 'dedicated-user' && !DEDICATED_USER_NAME.test(probe.user))
    reasons.push('a dedicated build user must be named nuzm-build*');
  if (isolation === 'dedicated-user' && probe.platform !== 'darwin' && probe.platform !== 'linux')
    reasons.push('dedicated-user isolation is only defined for macOS and Linux');
  if (
    (isolation === 'container' || isolation === 'vm') &&
    probe.user === 'root' &&
    !e.NUZM_BUILD_USER
  )
    reasons.push('running as root without a declared build user');

  // production secrets and tokens must not exist in the environment, whatever the declaration says
  const leaked = Object.keys(e)
    .filter((k) => !ALLOWED_NAMES.has(k) && SECRET_NAME.test(k) && e[k])
    .sort();
  if (leaked.length)
    reasons.push(
      `secret-looking environment variables are present (${leaked.join(', ')}); a build environment carries none`,
    );

  // a personal account holds personal files and credentials; a build account must not
  const personal = PERSONAL_PATHS.filter((p) => probe.exists(join(probe.home, p)));
  if (personal.length)
    reasons.push(
      `the home directory contains personal or credential locations (${personal.join(', ')}); a build account holds none`,
    );

  // network: for container/vm the egress allow-list is enforced OUTSIDE this process, so the guard can only require that a mirror is declared and the proxy points at it
  if (!e.NUZM_REGISTRY_MIRROR)
    warnings.push(
      'NUZM_REGISTRY_MIRROR is not set: the build may reach the public internet (pub.dev, Maven); acceptable only for the pre-approval template runs',
    );
  else {
    const proxy = e.https_proxy ?? e.HTTPS_PROXY ?? '';
    if ((isolation === 'container' || isolation === 'vm') && !proxy)
      warnings.push(
        'no https_proxy: egress restriction relies entirely on the container/VM network policy',
      );
  }
  if (isolation === 'dedicated-user') {
    warnings.push(
      'dedicated-user isolation: the build shares the kernel, disk and network of the host; network egress is NOT enforced (NOT VERIFIED)',
    );
    warnings.push(
      'the build user home is not wiped between builds unless the host wipes it (see infra/mobile/android/README.md "wipe")',
    );
  }
  return {
    ok: reasons.length === 0,
    isolation: reasons.length === 0 ? isolation : null,
    reasons,
    warnings,
  };
}

export class BuildEnvRefused extends Error {
  readonly code = 'build_env_refused';
  constructor(readonly assessment: EnvAssessment) {
    super(`build refused: not a disposable build environment: ${assessment.reasons.join('; ')}`);
  }
}
/** throws `BuildEnvRefused` unless the environment passes; returns the assessment (with warnings) otherwise */
export function requireDisposableEnvironment(probe: EnvProbe = defaultProbe()): EnvAssessment {
  const a = assessBuildEnvironment(probe);
  if (!a.ok) throw new BuildEnvRefused(a);
  return a;
}
