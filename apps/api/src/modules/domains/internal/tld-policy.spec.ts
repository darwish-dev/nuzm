import { describe, expect, it } from 'vitest';
import type { TldSupport } from '@nuzm/registrar-contracts';
import { evaluateTld, loadTldPolicy, parseTldPolicy } from './tld-policy';

const sup = (o: Partial<TldSupport> = {}): TldSupport => ({
  tld: 'com',
  register: 'supported',
  transfer: 'supported',
  renew: 'supported',
  dns: 'unknown',
  privacy: 'unknown',
  dnssec: 'unknown',
  eligibilityRules: 'unknown',
  restricted: false,
  minYears: 1,
  maxYears: 10,
  requiredContactFields: [],
  ...o,
});

describe('TLD policy (S30 task 5, AC-M07-04)', () => {
  const p = loadTldPolicy();
  it('the baseline file lists no Saudi suffix: every one is blocked as unsupported', () => {
    for (const t of [
      'sa',
      'com.sa',
      'net.sa',
      'org.sa',
      'edu.sa',
      'gov.sa',
      'med.sa',
      'pub.sa',
      'id.sa',
      'sch.sa',
      'xn--mgberp4a5d4ar',
    ]) {
      expect(p.entries.has(t)).toBe(false);
      const r = evaluateTld(p, t, 'register', sup({ tld: t }));
      expect(r.result).toBe('blocked');
      expect(r.result === 'blocked' && r.errorCode).toBe('unsupported_capability');
    }
  });
  it('a generic enabled TLD supported by the registrar is allowed; a registrar that does not list it is not', () => {
    expect(evaluateTld(p, 'com', 'register', sup()).result).toBe('allowed');
    expect(evaluateTld(p, 'com', 'register', undefined).result).toBe('blocked');
    expect(evaluateTld(p, 'com', 'transfer_in', sup({ transfer: 'unknown' })).result).toBe(
      'blocked',
    );
    expect(evaluateTld(p, 'xyz', 'register', sup({ tld: 'xyz' })).result).toBe('blocked'); // not in portfolio
  });
  it('a restricted TLD needs an evidence_ref even when enabled', () => {
    const pol = parseTldPolicy(
      'version: 1\nstatus: T\nalways_restricted_suffixes: [sa]\ntlds:\n  - {tld: ae, enabled: true}\n  - {tld: nl, enabled: true, evidence_ref: docs/x.md}\n',
    );
    expect(evaluateTld(pol, 'ae', 'register', sup({ tld: 'ae', restricted: true })).result).toBe(
      'blocked',
    );
    expect(evaluateTld(pol, 'nl', 'register', sup({ tld: 'nl', restricted: true })).result).toBe(
      'allowed',
    );
    expect(
      evaluateTld(pol, 'ae', 'register', sup({ tld: 'ae', eligibilityRules: 'registry' })).result,
    ).toBe('blocked');
  });
  it('the loader refuses to enable a Saudi TLD without evidence, and accepts it with evidence (still needs the registrar)', () => {
    expect(() =>
      parseTldPolicy(
        'version: 1\nstatus: T\nalways_restricted_suffixes: [sa, com.sa]\ntlds:\n  - {tld: sa, enabled: true}\n',
      ),
    ).toThrow(/HG-07-02/);
    expect(() =>
      parseTldPolicy(
        'version: 1\nstatus: T\nalways_restricted_suffixes: [sa]\ntlds:\n  - {tld: com.sa, enabled: true}\n',
      ),
    ).toThrow(/evidence_ref/);
    const ok = parseTldPolicy(
      'version: 1\nstatus: T\nalways_restricted_suffixes: [sa]\ntlds:\n  - {tld: sa, enabled: true, evidence_ref: docs/reports/HG-07-02.md}\n',
    );
    expect(evaluateTld(ok, 'sa', 'register', undefined).result).toBe('blocked');
    expect(evaluateTld(ok, 'sa', 'register', sup({ tld: 'sa' })).result).toBe('allowed');
  });
  it('disabled entries and malformed files fail closed', () => {
    const off = parseTldPolicy(
      'version: 1\nstatus: T\nalways_restricted_suffixes: []\ntlds:\n  - {tld: com, enabled: false}\n',
    );
    expect(evaluateTld(off, 'com', 'register', sup()).result).toBe('blocked');
    expect(() => parseTldPolicy('version: 1\nstatus: T\ntlds: []\n')).toThrow();
    expect(() =>
      parseTldPolicy(
        'version: 1\nstatus: T\nalways_restricted_suffixes: []\ntlds:\n  - {tld: com}\n',
      ),
    ).toThrow(/enabled/);
    expect(() => parseTldPolicy('not: yaml: [')).toThrow();
  });
  it('the rule set version changes with the content', () => {
    const a = parseTldPolicy(
      'version: 1\nstatus: T\nalways_restricted_suffixes: []\ntlds:\n  - {tld: com, enabled: true}\n',
    );
    const b = parseTldPolicy(
      'version: 1\nstatus: T\nalways_restricted_suffixes: []\ntlds:\n  - {tld: com, enabled: false}\n',
    );
    expect(a.ruleSetVersion).not.toBe(b.ruleSetVersion);
  });
});
