import { describe, expect, it } from 'vitest';
import { checkDependencyInstall, registryHosts } from './dependency-policy';

const INTEG = 'sha512-' + 'A'.repeat(86) + '==';
const lock = (pk: Record<string, unknown> = {}, v: number = 3) =>
  JSON.stringify({
    lockfileVersion: v,
    packages: {
      '': {},
      'node_modules/left': {
        resolved: 'https://registry.npmjs.org/left/-/left-1.0.0.tgz',
        integrity: INTEG,
      },
      ...pk,
    },
  });
const files = (pkg: unknown, l: string | null = lock(), extra: Record<string, string> = {}) => {
  const m = new Map<string, string>(Object.entries(extra));
  if (pkg !== undefined) m.set('package.json', typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  if (l !== null) m.set('package-lock.json', l);
  return m;
};
const reasons = (m: Map<string, string>) => checkDependencyInstall(m).reasons;

describe('dependency-install policy (S-AG6 phase 2)', () => {
  it('accepts plain semver ranges with a registry lockfile and integrity hashes', () => {
    const v = checkDependencyInstall(
      files({
        dependencies: { left: '^1.0.0', b: '~2.1', c: '>=1 <3', d: '1.x', e: '*', f: 'latest' },
        devDependencies: { g: '1.0.0-beta.2' },
      }),
    );
    expect(v).toMatchObject({ ok: true, reasons: [] });
    expect(v.stats.packages).toBe(1);
  });
  const cases: [string, unknown, string][] = [
    ['git', { dependencies: { a: 'git+https://example.test/a.git' } }, 'dependency_from_git'],
    ['github shorthand', { dependencies: { a: 'user/repo' } }, 'dependency_from_git'],
    ['github: prefix', { dependencies: { a: 'github:user/repo#abc' } }, 'dependency_from_git'],
    ['url tarball', { dependencies: { a: 'https://example.test/a.tgz' } }, 'dependency_from_url'],
    ['file path', { dependencies: { a: 'file:../x' } }, 'dependency_from_local_path'],
    ['link', { devDependencies: { a: 'link:./x' } }, 'dependency_from_local_path'],
    ['relative', { dependencies: { a: './x' } }, 'dependency_from_local_path'],
    ['alias', { dependencies: { a: 'npm:other@1' } }, 'dependency_alias'],
    ['garbage', { dependencies: { a: '1.0.0; rm -rf /' } }, 'dependency_spec_unrecognised'],
    [
      'override url',
      { overrides: { a: { b: 'https://example.test/x.tgz' } } },
      'override_dependency_from_url',
    ],
    [
      'resolutions git',
      { resolutions: { a: 'git://example.test/a' } },
      'override_dependency_from_git',
    ],
    ['bundled', { bundleDependencies: ['a'] }, 'bundled_dependencies'],
    ['not an object', { dependencies: ['a'] }, 'dependency_section_invalid'],
  ];
  for (const [name, pkg, code] of cases)
    it(`refuses ${name}`, () => expect(reasons(files(pkg))).toContain(code));
  it('refuses lockfile problems: missing, bad version, foreign registry, no integrity, link, count', () => {
    expect(reasons(files({}, null))).toContain('lockfile_missing');
    expect(reasons(files({}, 'not json'))).toContain('lockfile_invalid');
    expect(reasons(files({}, lock({}, 1)))).toContain('lockfile_version_unsupported');
    expect(
      reasons(
        files(
          {},
          lock({ 'node_modules/x': { resolved: 'https://evil.test/x.tgz', integrity: INTEG } }),
        ),
      ),
    ).toContain('resolved_outside_registry');
    expect(
      reasons(
        files(
          {},
          lock({
            'node_modules/x': { resolved: 'http://registry.npmjs.org/x.tgz', integrity: INTEG },
          }),
        ),
      ),
    ).toContain('resolved_outside_registry');
    expect(
      reasons(
        files({}, lock({ 'node_modules/x': { resolved: 'https://registry.npmjs.org/x.tgz' } })),
      ),
    ).toContain('integrity_missing');
    expect(
      reasons(
        files(
          {},
          lock({
            'node_modules/x': {
              resolved: 'https://registry.npmjs.org/x.tgz',
              integrity: 'md5-abc',
            },
          }),
        ),
      ),
    ).toContain('integrity_missing');
    expect(
      reasons(files({}, lock({ 'node_modules/x': { link: true, resolved: '../x' } }))),
    ).toContain('lockfile_link');
    expect(reasons(files({}, lock({ 'node_modules/x': { integrity: INTEG } })))).toContain(
      'lockfile_unresolved',
    );
    expect(
      checkDependencyInstall(files({}), {
        registries: ['https://registry.npmjs.org/'],
        maxPackages: 0,
        maxLockfileBytes: 1e6,
      }).reasons,
    ).toContain('too_many_packages');
    expect(
      checkDependencyInstall(files({}), {
        registries: ['https://registry.npmjs.org/'],
        maxPackages: 10,
        maxLockfileBytes: 10,
      }).reasons,
    ).toContain('lockfile_too_large');
  });
  it('refuses a missing or invalid package.json, other package managers and shrinkwrap', () => {
    expect(reasons(files(undefined))).toContain('package_json_missing');
    expect(reasons(files('{bad'))).toContain('package_json_invalid');
    expect(reasons(files('[]'))).toContain('package_json_invalid');
    expect(reasons(files({}, lock(), { 'yarn.lock': '' }))).toContain(
      'other_package_manager_files',
    );
    expect(reasons(files({}, lock(), { 'npm-shrinkwrap.json': '{}' }))).toContain(
      'shrinkwrap_not_supported',
    );
  });
  it('counts install scripts (they never run: --ignore-scripts) and never names packages in reasons', () => {
    const v = checkDependencyInstall(
      files(
        { dependencies: { 'secret-pkg-name': 'git+https://x.test/y.git' } },
        lock({
          'node_modules/p': {
            resolved: 'https://registry.npmjs.org/p.tgz',
            integrity: INTEG,
            hasInstallScript: true,
          },
        }),
      ),
    );
    expect(v.stats.withInstallScript).toBe(1);
    expect(JSON.stringify(v.reasons)).not.toContain('secret-pkg-name');
  });
});

describe('registry egress hosts (default-deny allowlist for the registry-only class)', () => {
  it('are exactly the hosts of the allowed registries', () => {
    expect(registryHosts()).toEqual(['registry.npmjs.org']);
    expect(
      registryHosts({
        registries: [
          'https://npm-mirror.example.org/repo/',
          'https://Registry.Example.org/',
          'http://insecure.example.org/',
          'https://npm-mirror.example.org/',
        ],
        maxPackages: 1,
        maxLockfileBytes: 1,
      }),
    ).toEqual(['npm-mirror.example.org', 'registry.example.org']);
  });
});
