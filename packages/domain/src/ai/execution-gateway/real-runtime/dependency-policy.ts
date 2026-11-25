/**
 * S-AG6 PHASE 2 (OFFLINE): the dependency-install policy for the `install-deps` profile (`npm ci --ignore-scripts`, network class `registry-only`, human approval). The check
 * runs on the CONTROL PLANE over the project's `package.json` and `package-lock.json` BEFORE any install, so a request that could pull code from anywhere but the allowed
 * registry (git, a URL, a tarball, a local path, an alias) or that has no integrity hash is refused without a network call. It does not replace the runtime controls (the
 * egress proxy allows only the registry hosts; lifecycle scripts never run); it is the cheap early refusal and the audit-friendly reason list.
 *
 * Reasons carry kinds and counts, never package names from the project or file content.
 */
export interface DependencyPolicy {
  /** `https://host/` prefixes a lockfile `resolved` URL may start with */
  registries: readonly string[];
  maxPackages: number;
  maxLockfileBytes: number;
}
export const DEFAULT_DEPENDENCY_POLICY: DependencyPolicy = {
  registries: ['https://registry.npmjs.org/'],
  maxPackages: 1500,
  maxLockfileBytes: 8 * 1024 * 1024,
};
export interface DependencyVerdict {
  ok: boolean;
  reasons: string[];
  stats: { packages: number; withInstallScript: number };
}
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const OVERRIDE_SECTIONS = ['overrides', 'resolutions'];
/** a plain semver range or dist-tag-free version: digits, operators, x, ||, spaces, hyphen ranges, pre-release tags */
const PLAIN_RANGE = /^[\^~<>=v0-9xX*|.\s-]+(?:[0-9A-Za-z.+-]*)$/;
const INTEGRITY = /^sha(512|384|256)-[A-Za-z0-9+/=]{20,}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function specReason(spec: unknown): string | null {
  if (typeof spec !== 'string') return isObj(spec) ? null : 'dependency_spec_not_a_string';
  const s = spec.trim();
  if (s === '' || s === '*' || s === 'latest') return s === '' ? 'dependency_spec_empty' : null;
  if (
    /^(file|link|workspace|portal|patch):/i.test(s) ||
    s.startsWith('.') ||
    s.startsWith('/') ||
    s.startsWith('~/')
  )
    return 'dependency_from_local_path';
  if (
    /^(git|git\+[a-z]+|github|gitlab|bitbucket|gist):/i.test(s) ||
    /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)
  )
    return 'dependency_from_git';
  if (/^https?:\/\//i.test(s)) return 'dependency_from_url';
  if (/^npm:/i.test(s)) return 'dependency_alias';
  if (!PLAIN_RANGE.test(s)) return 'dependency_spec_unrecognised';
  return null;
}
function collectOverrideSpecs(v: unknown, out: unknown[], depth = 0): void {
  if (depth > 6) return;
  if (typeof v === 'string') out.push(v);
  else if (isObj(v)) for (const x of Object.values(v)) collectOverrideSpecs(x, out, depth + 1);
}

export function checkDependencyInstall(
  files: ReadonlyMap<string, string>,
  policy: DependencyPolicy = DEFAULT_DEPENDENCY_POLICY,
): DependencyVerdict {
  const reasons = new Set<string>();
  const stats = { packages: 0, withInstallScript: 0 };
  const pkgText = files.get('package.json');
  const lockText = files.get('package-lock.json');
  if (files.has('npm-shrinkwrap.json')) reasons.add('shrinkwrap_not_supported');
  for (const f of ['yarn.lock', 'pnpm-lock.yaml', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs'])
    if (files.has(f)) reasons.add('other_package_manager_files');
  if (pkgText === undefined) reasons.add('package_json_missing');
  if (lockText === undefined) reasons.add('lockfile_missing');
  let pkg: unknown;
  let lock: unknown;
  try {
    if (pkgText !== undefined) pkg = JSON.parse(pkgText);
  } catch {
    reasons.add('package_json_invalid');
  }
  if (lockText !== undefined) {
    if (Buffer.byteLength(lockText) > policy.maxLockfileBytes) reasons.add('lockfile_too_large');
    else
      try {
        lock = JSON.parse(lockText);
      } catch {
        reasons.add('lockfile_invalid');
      }
  }
  if (isObj(pkg)) {
    for (const sec of SECTIONS) {
      const d = pkg[sec];
      if (d === undefined) continue;
      if (!isObj(d)) {
        reasons.add('dependency_section_invalid');
        continue;
      }
      for (const v of Object.values(d)) {
        const r = specReason(v);
        if (r) reasons.add(r);
      }
    }
    for (const sec of OVERRIDE_SECTIONS) {
      const specs: unknown[] = [];
      collectOverrideSpecs(pkg[sec], specs);
      for (const v of specs) {
        const r = specReason(v);
        if (r) reasons.add(`override_${r}`);
      }
    }
    if (pkg.bundleDependencies !== undefined || pkg.bundledDependencies !== undefined)
      reasons.add('bundled_dependencies');
  } else if (pkgText !== undefined && !reasons.has('package_json_invalid'))
    reasons.add('package_json_invalid');

  if (isObj(lock)) {
    const v = lock.lockfileVersion;
    if (v !== 2 && v !== 3) reasons.add('lockfile_version_unsupported');
    const packages = isObj(lock.packages) ? lock.packages : null;
    if (!packages) reasons.add('lockfile_packages_missing');
    else {
      for (const [key, entry] of Object.entries(packages)) {
        if (key === '') continue;
        stats.packages++;
        if (!isObj(entry)) {
          reasons.add('lockfile_entry_invalid');
          continue;
        }
        if (entry.link === true) reasons.add('lockfile_link');
        if (entry.hasInstallScript === true) stats.withInstallScript++;
        const resolved = entry.resolved;
        if (entry.link !== true) {
          if (typeof resolved !== 'string') reasons.add('lockfile_unresolved');
          else if (!policy.registries.some((p) => resolved.startsWith(p)))
            reasons.add('resolved_outside_registry');
          if (typeof entry.integrity !== 'string' || !INTEGRITY.test(entry.integrity))
            reasons.add('integrity_missing');
        }
      }
      if (stats.packages > policy.maxPackages) reasons.add('too_many_packages');
    }
  }
  return { ok: reasons.size === 0, reasons: [...reasons], stats };
}

/** the hosts of the allowed registries (the egress allowlist of the `registry-only` class is exactly these, port 443, and nothing else) */
export function registryHosts(policy: DependencyPolicy = DEFAULT_DEPENDENCY_POLICY): string[] {
  const out: string[] = [];
  for (const r of policy.registries) {
    const m = /^https:\/\/([^/:@?#]+)\/?/.exec(r);
    if (m && !out.includes(m[1]!.toLowerCase())) out.push(m[1]!.toLowerCase());
  }
  return out;
}
