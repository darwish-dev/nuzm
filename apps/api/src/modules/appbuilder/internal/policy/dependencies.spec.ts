import { describe, expect, it } from 'vitest';
import {
  evaluateDependencies,
  generateSbom,
  StaticAdvisoryDb,
  typosquatOf,
  type Lockfile,
} from './dependencies';

const M = 'https://npm-mirror.nuzm.internal/pkg/-/';
const pkg = (name: string, version = '1.0.0', extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `${M}${name}-${version}.tgz`,
  integrity: 'sha512-AAAA',
  license: 'MIT',
  ...extra,
});
const lock = (entries: Record<string, ReturnType<typeof pkg>>): Lockfile => ({
  lockfileVersion: 3,
  packages: {
    '': {},
    ...Object.fromEntries(Object.entries(entries).map(([n, v]) => [`node_modules/${n}`, v])),
  },
});
const run = (
  manifest: Record<string, unknown>,
  l: Lockfile | null,
  extra: Record<string, unknown> = {},
) =>
  evaluateDependencies({
    manifest,
    lockfile: l,
    advisories: new StaticAdvisoryDb((extra.table as never) ?? {}),
    ...extra,
  } as never);

describe('dependency policy (AC-M10-16)', () => {
  it('passes a clean pinned tree resolved from the mirror', async () => {
    const r = await run({ dependencies: { pg: '^8.0.0' } }, lock({ pg: pkg('pg', '8.1.0') }));
    expect(r).toMatchObject({ ok: true, findings: [], packageCount: 1 });
  });
  it('a missing lockfile blocks', async () => {
    const r = await run({ dependencies: { pg: '^8' } }, null);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.code).toBe('lockfile_missing');
  });
  it('typosquat fixtures are blocked (direct and transitive)', async () => {
    for (const bad of [
      'lodahs',
      'expresss',
      'reqeust',
      'react-dom_',
      'axois',
      'cross-evn',
      'reactt',
    ]) {
      expect(typosquatOf(bad), bad).not.toBeNull();
      const r = await run({ dependencies: { [bad]: '1.0.0' } }, lock({ [bad]: pkg(bad) }));
      expect(r.ok, bad).toBe(false);
      expect(r.findings.some((f) => f.code === 'typosquat')).toBe(true);
    }
    const t = await run(
      { dependencies: { pg: '^8' } },
      lock({ pg: pkg('pg'), lodahs: pkg('lodahs') }),
    );
    expect(t.findings.some((f) => f.code === 'typosquat' && f.message.includes('transitive'))).toBe(
      true,
    );
    for (const ok of [
      'pg',
      'lodash',
      '@types/node',
      'react',
      'left-pad-ish-thing',
      'my-company-lib',
    ])
      expect(typosquatOf(ok), ok).toBeNull();
  });
  it('an install script is not run by default: it needs an approval bound to that package; an approved one passes', async () => {
    const l = lock({ esbuild: pkg('esbuild', '0.20.0', { hasInstallScript: true }) });
    const r = await run({ devDependencies: { esbuild: '^0.20' } }, l);
    expect(r.ok).toBe(false);
    expect(r.findings.find((f) => f.code === 'install_script')!.level).toBe('approval');
    expect(r.approvalAction).toEqual({ dependencies: ['esbuild@0.20.0:install-script'] });
    const approved = await run({ devDependencies: { esbuild: '^0.20' } }, l, {
      config: { approvedInstallScripts: ['esbuild'] },
    });
    expect(approved.ok).toBe(true);
  });
  it('git, url, file, alias and unpinned specs are not allowed', async () => {
    const r = await run(
      {
        dependencies: {
          a: 'git+https://x/y.git',
          b: 'https://x/y.tgz',
          c: 'file:../c',
          d: 'npm:other@1',
          e: '*',
          f: 'latest',
          g: 'github:u/r',
        },
      },
      lock({}),
    );
    expect(r.findings.filter((f) => f.code === 'ecosystem_not_allowed')).toHaveLength(5);
    expect(r.findings.filter((f) => f.code === 'not_pinned')).toHaveLength(2);
  });
  it('a package resolved outside the mirror or without integrity is blocked', async () => {
    const r = await run(
      { dependencies: { pg: '^8' } },
      lock({
        pg: { ...pkg('pg'), resolved: 'https://registry.npmjs.org/pg/-/pg-8.tgz' },
        ws: { ...pkg('ws'), integrity: undefined as never },
      }),
    );
    expect(r.findings.map((f) => f.code).sort()).toEqual([
      'integrity_missing',
      'registry_not_mirror',
    ]);
  });
  it('a high or critical advisory blocks; a moderate one only warns', async () => {
    const table = {
      'npm:pg@8.1.0': [{ id: 'GHSA-high', severity: 'high', summary: 'rce' }],
      'npm:ws@8.0.0': [{ id: 'GHSA-mod', severity: 'moderate', summary: 'dos' }],
    };
    const r = await run(
      { dependencies: { pg: '^8', ws: '^8' } },
      lock({ pg: pkg('pg', '8.1.0'), ws: pkg('ws', '8.0.0') }),
      { table },
    );
    expect(r.ok).toBe(false);
    expect(
      r.findings
        .filter((f) => f.code === 'advisory')
        .map((f) => f.level)
        .sort(),
    ).toEqual(['block', 'warn']);
  });
  it('licences: copyleft blocks, unknown needs approval, SPDX OR expressions are accepted when one side is allowed', async () => {
    const r = await run(
      { dependencies: { a: '1', b: '1', c: '1', d: '1' } },
      lock({
        a: pkg('a', '1.0.0', { license: 'GPL-3.0-only' }),
        b: pkg('b', '1.0.0', { license: undefined }),
        c: pkg('c', '1.0.0', { license: '(MIT OR GPL-2.0)' }),
        d: pkg('d', '1.0.0', { license: 'Proprietary-X' }),
      }),
    );
    const by = (c: string) => r.findings.filter((f) => f.code === c).map((f) => f.pkg);
    expect(by('licence_denied')).toEqual(['a']);
    expect(by('licence_unknown').sort()).toEqual(['b', 'd']);
    expect(r.approvalAction?.dependencies).toEqual(['b@1.0.0:licence', 'd@1.0.0:licence']);
  });
  it('growth beyond 200 packages in one run needs an approval', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 230 }, (_, i) => [`pkg-n${i}x`, pkg(`pkg-n${i}x`)]),
    );
    const r = await run({ dependencies: {} }, lock(many), { previousCount: 10 });
    expect(r.findings.some((f) => f.code === 'growth_cap')).toBe(true);
    expect(
      (await run({ dependencies: {} }, lock(many), { previousCount: 100 })).findings.some(
        (f) => f.code === 'growth_cap',
      ),
    ).toBe(false);
  });
  it('the SBOM is deterministic and lists every package with purl, hash and licence', () => {
    const l = lock({
      pg: pkg('pg', '8.1.0', { integrity: 'sha512-3q2+7w==' }),
      '@types/pg': pkg('@types/pg', '8.0.0'),
    });
    const a = generateSbom({ name: 'app', version: '1.0.0' }, l);
    expect(JSON.stringify(a)).toBe(
      JSON.stringify(generateSbom({ name: 'app', version: '1.0.0' }, l)),
    );
    const comps = a.components as {
      purl: string;
      hashes?: { content: string }[];
      licenses?: unknown[];
    }[];
    expect(comps.map((c) => c.purl)).toEqual(['pkg:npm/%40types/pg@8.0.0', 'pkg:npm/pg@8.1.0']);
    expect(comps[1]!.hashes![0]!.content).toBe('deadbeef');
    expect(a.bomFormat).toBe('CycloneDX');
  });
});
