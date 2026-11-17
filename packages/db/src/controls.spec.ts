import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonical, COLLECTORS, evidenceHash } from './collectors';
import { COLLECTOR_NAMES, parseControls } from './controls';

const good = (over: Record<string, unknown> = {}) => ({
  id: 'CTL-TST-001',
  title: 'A test control',
  description: 'what it is',
  frameworks: [],
  applicability: 'to_confirm',
  owner_role: 'security',
  implementation: { status: 'partial', modules: ['x'], milestone: 'M04' },
  evidence: [
    { type: 'automated', collector: 'db.ownership-rls-check' },
    { type: 'manual', description: 'Quarterly review' },
  ],
  review_cadence_days: 90,
  claims_compliance: false,
  ...over,
});
const yaml = (controls: unknown[]) => JSON.stringify({ version: 1, controls }); // JSON is YAML

describe('control catalog validation (M04 task 12, AC-M04-10)', () => {
  it('accepts a valid control', () => {
    const c = parseControls(yaml([good()]));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      id: 'CTL-TST-001',
      claimsCompliance: false,
      applicability: 'to_confirm',
    });
  });
  it('rejects claims_compliance true, missing or truthy-looking', () => {
    for (const v of [true, 'false', 0, null, undefined]) {
      const c = good({ claims_compliance: v });
      if (v === undefined) delete (c as Record<string, unknown>).claims_compliance;
      expect(() => parseControls(yaml([c])), String(v)).toThrow(/claims_compliance/);
    }
  });
  it('rejects a control that decides its own applicability', () => {
    expect(() => parseControls(yaml([good({ applicability: 'applicable' })]))).toThrow(
      /applicability/,
    );
    expect(() => parseControls(yaml([good({ applicability: 'not_applicable' })]))).toThrow(
      /applicability/,
    );
  });
  it('rejects unknown collectors, bad ids, repeated ids, bad owner, bad implementation, bad cadence', () => {
    expect(() =>
      parseControls(yaml([good({ evidence: [{ type: 'automated', collector: 'made.up' }] })])),
    ).toThrow(/collector/);
    expect(() => parseControls(yaml([good({ id: 'ctl-1' })]))).toThrow(/id/);
    expect(() => parseControls(yaml([good(), good()]))).toThrow(/repeated/);
    expect(() => parseControls(yaml([good({ owner_role: 'intern' })]))).toThrow(/owner_role/);
    expect(() => parseControls(yaml([good({ implementation: { status: 'done' } })]))).toThrow(
      /implementation/,
    );
    expect(() => parseControls(yaml([good({ review_cadence_days: 0 })]))).toThrow(
      /review_cadence_days/,
    );
    expect(() => parseControls(yaml([good({ evidence: [{ type: 'oracle' }] })]))).toThrow(/type/);
  });
  it('reports every problem at once', () => {
    try {
      parseControls(yaml([good({ title: 'x', claims_compliance: true })]));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/2 problem/);
    }
  });
  it('the committed catalog is valid, claims nothing and uses only existing collectors', () => {
    const defs = parseControls(
      readFileSync(join(__dirname, '../../../spec/compliance/controls.yaml'), 'utf8'),
    );
    expect(defs.length).toBeGreaterThanOrEqual(10);
    for (const d of defs) {
      expect(d.claimsCompliance).toBe(false);
      expect(d.applicability).toBe('to_confirm');
      expect(d.frameworks).toEqual([]); // references come from the compliance owner (HG-04-02)
    }
    const used = new Set(
      defs.flatMap((d) => d.evidence.flatMap((e) => (e.type === 'automated' ? [e.collector] : []))),
    );
    expect([...used].sort()).toEqual([...COLLECTOR_NAMES].sort()); // every collector serves at least one control
  });
});

describe('collectors', () => {
  it('there are at least six, each with a distinct name and a version', () => {
    expect(COLLECTORS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(COLLECTORS.map((c) => c.name)).size).toBe(COLLECTORS.length);
    expect(COLLECTORS.map((c) => c.name).sort()).toEqual([...COLLECTOR_NAMES].sort());
    for (const c of COLLECTORS) expect(c.version).toMatch(/^\d+$/);
  });
  it('the hash depends on the content only, not on key order', () => {
    expect(canonical({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[2,{"x":2,"y":1}]},"b":1}',
    );
    expect(evidenceHash('c', '1', { a: 1, b: 2 })).toBe(evidenceHash('c', '1', { b: 2, a: 1 }));
  });
  it('a different result, collector or version gives a different hash', () => {
    const base = evidenceHash('c', '1', { ok: true });
    expect(evidenceHash('c', '1', { ok: false })).not.toBe(base);
    expect(evidenceHash('d', '1', { ok: true })).not.toBe(base);
    expect(evidenceHash('c', '2', { ok: true })).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});
