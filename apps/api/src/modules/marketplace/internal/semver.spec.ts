import { describe, expect, it } from 'vitest';
import { compareSemver, parseSemver, satisfies, validRange } from './semver';

describe('semver ranges for entitlements', () => {
  it('parses and orders versions', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
    for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.2.3.4', '', 'x'])
      expect(parseSemver(bad), bad).toBeNull();
    const c = (a: string, b: string) => compareSemver(parseSemver(a)!, parseSemver(b)!);
    expect(c('1.2.3', '1.2.4')).toBe(-1);
    expect(c('2.0.0', '1.9.9')).toBe(1);
    expect(c('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(c('1.0.0', '1.0.0')).toBe(0);
  });
  it('matches the supported range forms', () => {
    expect(satisfies('1.4.0', '*')).toBe(true);
    expect(satisfies('1.4.0', '1.4.0')).toBe(true);
    expect(satisfies('1.4.1', '1.4.0')).toBe(false);
    expect(satisfies('1.9.0', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('1.1.9', '^1.2.0')).toBe(false);
    expect(satisfies('0.2.5', '^0.2.1')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.1')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfies('2.5.0', '>=2.0.0 <3.0.0')).toBe(true);
    expect(satisfies('3.0.0', '>=2.0.0 <3.0.0')).toBe(false);
  });
  it('fails closed: malformed versions and ranges never match; prereleases need an explicit range', () => {
    for (const r of ['', 'latest', '1.x', '^', '>=', '1.2.3 || 2', 'x'.repeat(200)])
      expect(satisfies('1.2.3', r), r).toBe(false);
    expect(satisfies('not-a-version', '*')).toBe(false);
    expect(satisfies('1.0.0-beta', '*')).toBe(false);
    expect(satisfies('1.0.0-beta', '>=1.0.0-alpha')).toBe(true);
    expect(validRange('^1.2.3')).toBe(true);
    expect(validRange('latest')).toBe(false);
  });
});
