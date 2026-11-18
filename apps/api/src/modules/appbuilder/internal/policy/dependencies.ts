import { sha256 } from '../core';

/** Supply-chain policy of M10 §9: ecosystem allow-list, mandatory lockfile, install scripts off, advisory scan, typosquat check, licence check, growth cap, SBOM. */
export type Severity = 'low' | 'moderate' | 'high' | 'critical';
export interface Advisory {
  id: string;
  severity: Severity;
  summary: string;
}
/** The known-advisory database (e.g. a mirror of the npm/OSV feed). Its content and freshness are an operations concern (NOT VERIFIED: no live feed is connected). */
export abstract class AdvisoryDbPort {
  abstract lookup(ecosystem: 'npm' | 'pub', name: string, version: string): Promise<Advisory[]>;
}
export class StaticAdvisoryDb extends AdvisoryDbPort {
  constructor(private readonly table: Record<string, Advisory[]> = {}) {
    super();
  }
  async lookup(ecosystem: string, name: string, version: string): Promise<Advisory[]> {
    return this.table[`${ecosystem}:${name}@${version}`] ?? [];
  }
}

export interface LockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  license?: string;
  hasInstallScript?: boolean;
  dev?: boolean;
  link?: boolean;
}
export interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockPackage>;
}
export interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}
export interface PolicyConfig {
  /** Hosts the lockfile may resolve from: the scanning package mirror. Anything else (registry.npmjs.org directly, a git host, a CDN) is blocked. */
  mirrorHosts: string[];
  licenseAllow: string[];
  licenseDeny: RegExp[];
  /** Maximum growth of the total package count in one run before an approval is required. */
  growthCap: number;
  failAt: Severity;
  /** Packages whose install script was approved (`egress_or_dependency`), by name. */
  approvedInstallScripts: string[];
}
export const DEFAULT_POLICY: PolicyConfig = {
  mirrorHosts: ['npm-mirror.nuzm.internal'],
  licenseAllow: [
    'MIT',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'BlueOak-1.0.0',
    'Python-2.0',
    'CC-BY-4.0',
    'MIT-0',
  ],
  licenseDeny: [
    /^A?GPL/i,
    /^LGPL/i,
    /^SSPL/i,
    /^BUSL/i,
    /^CPAL/i,
    /^EUPL/i,
    /^OSL/i,
    /^Commons-Clause/i,
  ],
  growthCap: 200,
  failAt: 'high',
  approvedInstallScripts: [],
};

export type FindingCode =
  | 'lockfile_missing'
  | 'ecosystem_not_allowed'
  | 'registry_not_mirror'
  | 'integrity_missing'
  | 'install_script'
  | 'typosquat'
  | 'licence_denied'
  | 'licence_unknown'
  | 'advisory'
  | 'growth_cap'
  | 'not_pinned';
export interface Finding {
  code: FindingCode;
  /** `block` stops the pipeline; `approval` needs the `egress_or_dependency` approval; `warn` is informational. */
  level: 'block' | 'approval' | 'warn';
  pkg?: string;
  message: string;
}
export interface PolicyReport {
  ok: boolean;
  findings: Finding[];
  /** Approval payload (the exact action the approval is bound to) when `approval` findings exist. */
  approvalAction: { dependencies: string[] } | null;
  packageCount: number;
}

const POPULAR = [
  'react',
  'react-dom',
  'lodash',
  'express',
  'axios',
  'moment',
  'chalk',
  'commander',
  'debug',
  'dotenv',
  'typescript',
  'webpack',
  'eslint',
  'prettier',
  'jest',
  'mocha',
  'vitest',
  'next',
  'vue',
  'angular',
  'svelte',
  'jquery',
  'underscore',
  'request',
  'async',
  'bluebird',
  'uuid',
  'yargs',
  'minimist',
  'glob',
  'rimraf',
  'mkdirp',
  'semver',
  'tslib',
  'rxjs',
  'zod',
  'ajv',
  'pg',
  'mysql',
  'mysql2',
  'mongodb',
  'mongoose',
  'redis',
  'ioredis',
  'sequelize',
  'typeorm',
  'prisma',
  'knex',
  'fastify',
  'koa',
  'hapi',
  'nestjs',
  'socket.io',
  'ws',
  'body-parser',
  'cors',
  'helmet',
  'morgan',
  'passport',
  'jsonwebtoken',
  'bcrypt',
  'bcryptjs',
  'argon2',
  'nodemailer',
  'multer',
  'cookie-parser',
  'compression',
  'dayjs',
  'date-fns',
  'classnames',
  'prop-types',
  'redux',
  'react-redux',
  'react-router',
  'react-router-dom',
  'styled-components',
  'tailwindcss',
  'postcss',
  'autoprefixer',
  'sass',
  'babel-core',
  'core-js',
  'regenerator-runtime',
  'fs-extra',
  'node-fetch',
  'cross-env',
  'nodemon',
  'ts-node',
  'tsx',
  'esbuild',
  'vite',
  'rollup',
  'gulp',
  'grunt',
  'inquirer',
  'ora',
  'colors',
  'js-yaml',
  'yaml',
  'xml2js',
  'cheerio',
  'puppeteer',
  'playwright',
  'sharp',
  'jimp',
  'handlebars',
  'ejs',
  'pug',
  'mustache',
  'marked',
  'highlight.js',
  'ramda',
  'immer',
  'mobx',
  'lodash-es',
  'event-emitter',
  'ms',
  'qs',
  'cookie',
  'iconv-lite',
  'safe-buffer',
  'inherits',
  'readable-stream',
  'through2',
  'pino',
  'winston',
  'bunyan',
  'log4js',
  'http',
  'provider',
  'flutter_bloc',
  'riverpod',
  'dio',
  'get_it',
  'go_router',
  'intl',
  'shared_preferences',
  'path_provider',
  'sqflite',
  'hive',
];
const popular = new Set(POPULAR);

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[-_.]/g, '')
    .replace(/[01]/g, (c) => (c === '0' ? 'o' : 'l'));

/** Name-similarity check: a package that is NOT popular but is one edit (or a separator/homoglyph variant) away from a popular name. Returns the name it imitates. */
export function typosquatOf(name: string): string | null {
  const bare = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  if (name.startsWith('@types/') || popular.has(bare)) return null;
  for (const p of popular) {
    if (p === bare) return null;
    const limit = p.length >= 9 ? 2 : 1;
    if (p.length >= 4 && (distance(bare, p) <= limit || norm(bare) === norm(p))) return p;
  }
  return null;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, moderate: 1, high: 2, critical: 3 };
const FORBIDDEN_SPEC =
  /^(git(\+[a-z]+)?:|github:|gitlab:|bitbucket:|https?:|file:|link:|npm:|workspace:|portal:)/i;
const pkgName = (path: string) =>
  path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);

export async function evaluateDependencies(input: {
  manifest: PackageManifest;
  lockfile: Lockfile | null;
  previousCount?: number;
  advisories: AdvisoryDbPort;
  config?: Partial<PolicyConfig>;
  /** false at generation time: the lockfile is created later in the sandbox, so its absence is reported as pending, not blocking (it still blocks install and deploy). */ lockfileRequired?: boolean;
}): Promise<PolicyReport> {
  const cfg = { ...DEFAULT_POLICY, ...(input.config ?? {}) };
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  const direct = {
    ...(input.manifest.dependencies ?? {}),
    ...(input.manifest.devDependencies ?? {}),
    ...(input.manifest.optionalDependencies ?? {}),
  };
  for (const [name, spec] of Object.entries(direct)) {
    if (FORBIDDEN_SPEC.test(spec))
      add({
        code: 'ecosystem_not_allowed',
        level: 'block',
        pkg: name,
        message: `${name}: "${spec}" does not resolve from the package registry (git, URL, file, link and alias sources are not allowed)`,
      });
    else if (spec === '*' || spec === 'latest' || spec === '')
      add({
        code: 'not_pinned',
        level: 'block',
        pkg: name,
        message: `${name}: "${spec || '(empty)'}" is not a version range`,
      });
    const sq = typosquatOf(name);
    if (sq)
      add({
        code: 'typosquat',
        level: 'block',
        pkg: name,
        message: `${name} looks like "${sq}" (possible typosquat)`,
      });
  }
  if (!input.lockfile || !input.lockfile.packages) {
    add({
      code: 'lockfile_missing',
      level: input.lockfileRequired === false ? 'warn' : 'block',
      message:
        'a lockfile is mandatory: run the install in the sandbox through the package mirror and commit package-lock.json',
    });
    return {
      ok: !findings.some((f) => f.level === 'block'),
      findings,
      approvalAction: null,
      packageCount: 0,
    };
  }
  const entries = Object.entries(input.lockfile.packages).filter(
    ([p]) => p !== '' && p.includes('node_modules/'),
  );
  const approvalDeps: string[] = [];
  for (const [path, p] of entries) {
    const name = pkgName(path);
    const version = p.version ?? '';
    if (p.link) continue;
    if (!p.integrity)
      add({
        code: 'integrity_missing',
        level: 'block',
        pkg: name,
        message: `${name}@${version}: no integrity hash in the lockfile`,
      });
    if (p.resolved) {
      let host = '';
      try {
        host = new URL(p.resolved).host;
      } catch {
        host = '';
      }
      if (!cfg.mirrorHosts.includes(host))
        add({
          code: 'registry_not_mirror',
          level: 'block',
          pkg: name,
          message: `${name}@${version}: resolved from "${host || p.resolved}", not from the package mirror`,
        });
    } else
      add({
        code: 'registry_not_mirror',
        level: 'block',
        pkg: name,
        message: `${name}@${version}: no resolved source in the lockfile`,
      });
    if (p.hasInstallScript && !cfg.approvedInstallScripts.includes(name)) {
      add({
        code: 'install_script',
        level: 'approval',
        pkg: name,
        message: `${name}@${version} runs an install script (disabled by default; an approval enables it for this exact package)`,
      });
      approvalDeps.push(`${name}@${version}:install-script`);
    }
    if (!input.manifest.dependencies?.[name] && !input.manifest.devDependencies?.[name]) {
      const sq = typosquatOf(name);
      if (sq)
        add({
          code: 'typosquat',
          level: 'block',
          pkg: name,
          message: `${name} looks like "${sq}" (possible typosquat, transitive)`,
        });
    }
    const lic = p.license;
    if (!lic) {
      add({
        code: 'licence_unknown',
        level: 'approval',
        pkg: name,
        message: `${name}@${version}: no licence declared`,
      });
      approvalDeps.push(`${name}@${version}:licence`);
    } else if (cfg.licenseDeny.some((re) => re.test(lic)))
      add({
        code: 'licence_denied',
        level: 'block',
        pkg: name,
        message: `${name}@${version}: licence ${lic} is not allowed by policy`,
      });
    else if (
      !lic
        .split(/\s+(?:OR|AND)\s+|[()]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .some((x) => cfg.licenseAllow.includes(x))
    ) {
      add({
        code: 'licence_unknown',
        level: 'approval',
        pkg: name,
        message: `${name}@${version}: licence ${lic} is not on the allow-list`,
      });
      approvalDeps.push(`${name}@${version}:licence`);
    }
    for (const a of await input.advisories.lookup('npm', name, version))
      if (SEVERITY_RANK[a.severity] >= SEVERITY_RANK[cfg.failAt])
        add({
          code: 'advisory',
          level: 'block',
          pkg: name,
          message: `${name}@${version}: ${a.id} (${a.severity}): ${a.summary}`,
        });
      else
        add({
          code: 'advisory',
          level: 'warn',
          pkg: name,
          message: `${name}@${version}: ${a.id} (${a.severity})`,
        });
  }
  if (input.previousCount !== undefined && entries.length - input.previousCount > cfg.growthCap) {
    add({
      code: 'growth_cap',
      level: 'approval',
      message: `the dependency tree grew by ${entries.length - input.previousCount} packages (cap ${cfg.growthCap})`,
    });
    approvalDeps.push(`growth:${entries.length - input.previousCount}`);
  }
  const blocked = findings.some((f) => f.level === 'block');
  const approvals = [...new Set(approvalDeps)].sort();
  return {
    ok: !blocked && approvals.length === 0,
    findings,
    approvalAction: approvals.length ? { dependencies: approvals } : null,
    packageCount: entries.length,
  };
}

/** CycloneDX 1.5 SBOM of a lockfile (one component per package, with purl, hash and licence). Deterministic: no timestamps or random ids, so the same lockfile gives the same bytes. */
export function generateSbom(
  manifest: PackageManifest,
  lock: Lockfile | null,
): Record<string, unknown> {
  const components = Object.entries(lock?.packages ?? {})
    .filter(([p]) => p !== '' && p.includes('node_modules/'))
    .map(([p, v]) => {
      const name = pkgName(p);
      const comp: Record<string, unknown> = {
        type: 'library',
        'bom-ref': `pkg:npm/${name}@${v.version ?? ''}`,
        name,
        version: v.version ?? '',
        purl: `pkg:npm/${name.replace(/^@/, '%40')}@${v.version ?? ''}`,
        scope: v.dev ? 'optional' : 'required',
      };
      if (v.integrity) {
        const m = /^sha(\d+)-(.+)$/.exec(v.integrity);
        if (m)
          comp['hashes'] = [
            { alg: `SHA-${m[1]}`, content: Buffer.from(m[2]!, 'base64').toString('hex') },
          ];
      }
      if (v.license) comp['licenses'] = [{ expression: v.license }];
      return comp;
    })
    .sort((a, b) => String(a['bom-ref']).localeCompare(String(b['bom-ref'])));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    serialNumber: `urn:uuid:${sha256(JSON.stringify([manifest.name, manifest.version, components.map((c) => c['bom-ref'])])).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5')}`,
    metadata: {
      component: {
        type: 'application',
        name: manifest.name ?? 'app',
        version: manifest.version ?? '0.0.0',
      },
      tools: [{ vendor: 'Nuzm', name: 'app-builder-sbom', version: '1' }],
    },
    components,
  };
}
