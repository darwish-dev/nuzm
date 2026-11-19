import { describe, expect, it } from 'vitest';
import { generateFlutterProject } from '../flutter/templates';
import { SAMPLE_MOBILE_SPEC } from '../fixtures/sample-spec';
import { evaluatePubLock, evaluatePubspec, PUB_ALLOWLIST, StaticPubAdvisories, typosquatOf } from './pub-policy';

const pubspec = generateFlutterProject(SAMPLE_MOBILE_SPEC)['pubspec.yaml']!;
const withDep = (line: string) => pubspec.replace('dev_dependencies:', `${line}\n\ndev_dependencies:`);
const lock = (pkgs: { name: string; version: string; source?: string; url?: string }[]) =>
  'packages:\n' +
  pkgs.map((p) => `  ${p.name}:\n    dependency: transitive\n    description:\n      name: ${p.name}\n      url: "${p.url ?? 'https://pub.dev'}"\n    source: ${p.source ?? 'hosted'}\n    version: "${p.version}"\n`).join('');

describe('pub allow-list (S48.3, AC-M10-16)', () => {
  it('the generated pubspec has only allow-listed direct dependencies with the pinned constraints', () => {
    expect(evaluatePubspec(pubspec)).toEqual([]);
    expect(Object.keys(PUB_ALLOWLIST).length).toBeLessThan(12);
  });
  it('blocks unknown packages, wrong constraints, git/path/url sources, overrides', () => {
    expect(evaluatePubspec(withDep('  left_pad_dart: ^1.0.0')).map((i) => i.rule)).toContain('not_allow_listed');
    expect(evaluatePubspec(pubspec.replace('go_router: ^16.2.0', 'go_router: any')).map((i) => i.rule)).toContain('constraint_mismatch');
    expect(evaluatePubspec(withDep('  evil:\n    git: https://example.com/evil.git')).map((i) => i.rule)).toContain('not_allow_listed');
    expect(evaluatePubspec(pubspec.replace('http: ^1.5.0', 'http:\n    git: https://example.com/http.git')).map((i) => i.rule)).toContain('non_hosted_source');
    expect(evaluatePubspec(pubspec.replace('http: ^1.5.0', 'http:\n    path: ../http')).map((i) => i.rule)).toContain('non_hosted_source');
    expect(evaluatePubspec(pubspec + '\ndependency_overrides:\n  http: ^0.1.0\n').map((i) => i.rule)).toContain('non_hosted_source');
    expect(evaluatePubspec('::: not yaml: [').map((i) => i.rule)).toEqual(['unparseable']);
  });
  it('flags typosquats of allow-listed names', () => {
    expect(typosquatOf('go_routr')).toBe('go_router');
    expect(typosquatOf('flutter_riverpods')).toBe('flutter_riverpod');
    expect(typosquatOf('go_router')).toBeNull();
    expect(evaluatePubspec(withDep('  go_routr: ^1.0.0')).map((i) => i.rule)).toContain('typosquat');
  });
});

describe('lockfile policy', () => {
  const opts = { allowedHosts: ['pub.dev'], advisories: new StaticPubAdvisories() };
  it('a lockfile is mandatory', async () => {
    expect((await evaluatePubLock(undefined, opts)).issues[0]?.rule).toBe('lock_missing');
  });
  it('accepts hosted packages from an allowed host and sdk packages', async () => {
    const r = await evaluatePubLock(lock([{ name: 'http', version: '1.5.0' }, { name: 'flutter', version: '0.0.0', source: 'sdk' }]), opts);
    expect(r.issues).toEqual([]);
    expect(r.packages.length).toBe(2);
  });
  it('blocks git sources, foreign hosts, large graphs and high advisories', async () => {
    expect((await evaluatePubLock(lock([{ name: 'x', version: '1.0.0', source: 'git' }]), opts)).issues[0]?.rule).toBe('lock_source');
    expect((await evaluatePubLock(lock([{ name: 'x', version: '1.0.0', url: 'https://evil.example' }]), opts)).issues[0]?.rule).toBe('lock_source');
    const big = lock(Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, version: '1.0.0' })));
    expect((await evaluatePubLock(big, { ...opts, maxPackages: 5 })).issues.map((i) => i.rule)).toContain('lock_too_large');
    const adv = new StaticPubAdvisories({ 'http@1.5.0': [{ id: 'GHSA-test', severity: 'high', summary: 'test advisory' }] });
    expect((await evaluatePubLock(lock([{ name: 'http', version: '1.5.0' }]), { ...opts, advisories: adv })).issues[0]?.rule).toBe('advisory');
    const low = new StaticPubAdvisories({ 'http@1.5.0': [{ id: 'GHSA-low', severity: 'low', summary: 'minor' }] });
    expect((await evaluatePubLock(lock([{ name: 'http', version: '1.5.0' }]), { ...opts, advisories: low })).issues).toEqual([]);
  });
  it('the mirror host is enforced when configured', async () => {
    const r = await evaluatePubLock(lock([{ name: 'http', version: '1.5.0' }]), { ...opts, allowedHosts: ['pub-mirror.nuzm.internal'] });
    expect(r.issues[0]?.rule).toBe('lock_source');
  });
});
