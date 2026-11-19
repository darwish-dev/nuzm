import { parse } from 'yaml';

/**
 * Supply-chain policy of the `pub` ecosystem for generated Flutter projects (M10 §9, S48.3): DIRECT dependencies must be on the allow-list with exactly the pinned constraint;
 * no git/path/url/hosted-elsewhere dependency; the lockfile must resolve every package from the configured hosted URL (the scanning mirror in production; `pub.dev` in the
 * local dev runner, which says so in the build record); a known-advisory database may block a version; a typosquat check blocks names one edit away from an allow-listed name;
 * the transitive package count is capped. Nothing here installs anything.
 */
export interface PubEntry {
  /** the only constraint a generated pubspec may use */
  constraint: string;
  kind: 'dependency' | 'dev';
  license: string;
  purpose: string;
}
export const PUB_ALLOWLIST: Readonly<Record<string, PubEntry>> = {
  flutter_localizations: {
    constraint: 'sdk: flutter',
    kind: 'dependency',
    license: 'BSD-3-Clause',
    purpose: 'Arabic/English material localisation, RTL',
  },
  intl: {
    constraint: '^0.20.2',
    kind: 'dependency',
    license: 'BSD-3-Clause',
    purpose: 'date/number formatting',
  },
  go_router: {
    constraint: '^16.2.0',
    kind: 'dependency',
    license: 'BSD-3-Clause',
    purpose: 'navigation',
  },
  flutter_riverpod: {
    constraint: '^2.6.1',
    kind: 'dependency',
    license: 'MIT',
    purpose: 'state management',
  },
  shared_preferences: {
    constraint: '^2.5.3',
    kind: 'dependency',
    license: 'BSD-3-Clause',
    purpose: 'settings (locale, theme)',
  },
  flutter_secure_storage: {
    constraint: '^9.2.4',
    kind: 'dependency',
    license: 'BSD-3-Clause',
    purpose: 'auth token storage',
  },
  http: {
    constraint: '^1.5.0',
    kind: 'dependency',
    license: 'BSD-3-Clause',
    purpose: 'API client',
  },
  flutter_lints: {
    constraint: '^6.0.0',
    kind: 'dev',
    license: 'BSD-3-Clause',
    purpose: 'lint rules',
  },
};
const SDK_DEPS = new Set(['flutter', 'flutter_test', 'flutter_localizations']);
export const MAX_PACKAGES = 200;

export type Severity = 'low' | 'moderate' | 'high' | 'critical';
export interface PubAdvisory {
  id: string;
  severity: Severity;
  summary: string;
}
export abstract class PubAdvisoryPort {
  abstract lookup(name: string, version: string): Promise<PubAdvisory[]>;
}
/** Known-advisory table (static). A live OSV/pub advisory feed is NOT connected: NOT VERIFIED. */
export class StaticPubAdvisories extends PubAdvisoryPort {
  constructor(private readonly table: Record<string, PubAdvisory[]> = {}) {
    super();
  }
  async lookup(name: string, version: string): Promise<PubAdvisory[]> {
    return this.table[`${name}@${version}`] ?? [];
  }
}

export interface PolicyIssue {
  rule:
    | 'not_allow_listed'
    | 'constraint_mismatch'
    | 'non_hosted_source'
    | 'typosquat'
    | 'lock_missing'
    | 'lock_source'
    | 'lock_too_large'
    | 'advisory'
    | 'unparseable';
  package?: string;
  detail: string;
}
const sev = { low: 0, moderate: 1, high: 2, critical: 3 } as const;

export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [
    i,
    ...new Array<number>(n).fill(0),
  ]);
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[m]![n]!;
}
/** a name within one edit of an allow-listed name (but not equal) is a typosquat candidate; names under 5 characters are exempt (too many collisions) */
export const typosquatOf = (name: string): string | null => {
  for (const known of Object.keys(PUB_ALLOWLIST))
    if (known !== name && known.length >= 5 && editDistance(name, known) <= 1) return known;
  return null;
};

/** The direct dependencies of a pubspec.yaml. Anything that is not a plain version string or `sdk: flutter` is a non-hosted source (git, path, url). */
export function pubspecDependencies(
  yamlText: string,
): { name: string; spec: unknown; dev: boolean }[] | null {
  let doc: unknown;
  try {
    doc = parse(yamlText, { strict: true, uniqueKeys: true });
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  const out: { name: string; spec: unknown; dev: boolean }[] = [];
  for (const [key, dev] of [
    ['dependencies', false],
    ['dev_dependencies', true],
    ['dependency_overrides', false],
  ] as const) {
    const m = d[key];
    if (m === undefined || m === null) continue;
    if (typeof m !== 'object' || Array.isArray(m)) return null;
    for (const [name, spec] of Object.entries(m as object)) {
      out.push({ name: key === 'dependency_overrides' ? `override:${name}` : name, spec, dev });
    }
  }
  return out;
}

export function evaluatePubspec(yamlText: string): PolicyIssue[] {
  const deps = pubspecDependencies(yamlText);
  if (!deps) return [{ rule: 'unparseable', detail: 'pubspec.yaml is not valid YAML' }];
  const out: PolicyIssue[] = [];
  for (const { name, spec } of deps) {
    if (name.startsWith('override:')) {
      out.push({
        rule: 'non_hosted_source',
        package: name.slice(9),
        detail: 'dependency_overrides are not allowed',
      });
      continue;
    }
    if (name === 'flutter' || name === 'flutter_test') {
      if (!(spec && typeof spec === 'object' && (spec as { sdk?: unknown }).sdk === 'flutter'))
        out.push({ rule: 'non_hosted_source', package: name, detail: 'must be `sdk: flutter`' });
      continue;
    }
    const entry = PUB_ALLOWLIST[name];
    if (!entry) {
      const near = typosquatOf(name);
      out.push(
        near
          ? {
              rule: 'typosquat',
              package: name,
              detail: `one edit away from the allow-listed package ${near}`,
            }
          : { rule: 'not_allow_listed', package: name, detail: 'not on the pub allow-list' },
      );
      continue;
    }
    if (typeof spec === 'string') {
      if (spec !== entry.constraint)
        out.push({
          rule: 'constraint_mismatch',
          package: name,
          detail: `constraint must be ${entry.constraint}`,
        });
    } else if (
      spec &&
      typeof spec === 'object' &&
      (spec as { sdk?: unknown }).sdk === 'flutter' &&
      SDK_DEPS.has(name)
    ) {
      // flutter_localizations: sdk: flutter
    } else {
      out.push({
        rule: 'non_hosted_source',
        package: name,
        detail: 'git, path, url and custom hosted sources are not allowed',
      });
    }
  }
  return out;
}

interface LockPackage {
  dependency?: string;
  source?: string;
  version?: string;
  description?: unknown;
}
/**
 * The resolved lock. Every package must come from `hosted` (or the SDK) and from `allowedHosts` (the scanning mirror; `pub.dev` for the local dev runner, recorded in the
 * build); the package count is capped; advisories at or above `failAt` block. `names` returns every resolved package for the SBOM.
 */
export async function evaluatePubLock(
  lockText: string | undefined,
  o: {
    allowedHosts: string[];
    advisories: PubAdvisoryPort;
    failAt?: Severity;
    maxPackages?: number;
  },
): Promise<{ issues: PolicyIssue[]; packages: { name: string; version: string }[] }> {
  if (!lockText)
    return {
      issues: [{ rule: 'lock_missing', detail: 'pubspec.lock is mandatory' }],
      packages: [],
    };
  let doc: { packages?: Record<string, LockPackage> };
  try {
    doc = parse(lockText) as typeof doc;
  } catch {
    return {
      issues: [{ rule: 'unparseable', detail: 'pubspec.lock is not valid YAML' }],
      packages: [],
    };
  }
  const pk = doc?.packages ?? {};
  const issues: PolicyIssue[] = [];
  const packages: { name: string; version: string }[] = [];
  const names = Object.keys(pk);
  if (names.length > (o.maxPackages ?? MAX_PACKAGES))
    issues.push({
      rule: 'lock_too_large',
      detail: `${names.length} packages exceed the cap ${o.maxPackages ?? MAX_PACKAGES}`,
    });
  const failAt = sev[o.failAt ?? 'high'];
  for (const name of names) {
    const p = pk[name]!;
    const version = String(p.version ?? '');
    packages.push({ name, version });
    if (p.source === 'sdk') continue;
    if (p.source !== 'hosted') {
      issues.push({
        rule: 'lock_source',
        package: name,
        detail: `source ${String(p.source)} is not allowed`,
      });
      continue;
    }
    const url = (p.description as { url?: string } | undefined)?.url ?? '';
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      /* host stays empty */
    }
    if (!o.allowedHosts.includes(host))
      issues.push({
        rule: 'lock_source',
        package: name,
        detail: `resolved from ${host || 'an unknown host'}, not the allowed host`,
      });
    for (const a of await o.advisories.lookup(name, version))
      if (sev[a.severity] >= failAt)
        issues.push({
          rule: 'advisory',
          package: name,
          detail: `${a.id} (${a.severity}): ${a.summary}`,
        });
  }
  return { issues, packages };
}
