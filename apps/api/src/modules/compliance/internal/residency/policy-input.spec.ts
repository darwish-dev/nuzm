import { describe, expect, it } from 'vitest';
import { ProblemException } from '../../../../common/errors';
import { parseAssessmentRequest } from './assessment.service';
import { CLASSES, type Floor } from './evaluator';
import { belowFloor, parsePolicyBody } from './policy-input';
import { parseResidencyDefaults, loadResidencyDefaults } from './defaults';

const fields = (fn: () => unknown) => {
  try {
    fn();
    return [];
  } catch (e) {
    return ((e as ProblemException).errors as { field: string }[]).map((x) => x.field);
  }
};
const A1 = '0194a1b2-1111-7222-8333-444455556666';
const A2 = '0194a1b2-2222-7222-8333-444455556666';
const FLOOR: Floor = {
  version: 1,
  byClass: Object.fromEntries(
    CLASSES.map((c) => [
      c,
      c === 'credentials' ? 'in_kingdom_only' : 'unrestricted_with_assessment',
    ]),
  ) as Floor['byClass'],
};

describe('residency policy body', () => {
  it('accepts a policy and normalizes exception ids', () => {
    const b = parsePolicyBody({
      mode: 'allow_listed',
      allowedCountriesByClass: { personal: ['AE', 'DE'] },
      exceptions: [A1.toUpperCase()],
      changeNote: ' tighten ',
    });
    expect(b).toMatchObject({ mode: 'allow_listed', exceptions: [A1], changeNote: 'tighten' });
  });
  it('defaults to no countries and no exceptions', () => {
    expect(parsePolicyBody({ mode: 'in_kingdom_only' })).toMatchObject({
      allowedCountriesByClass: {},
      exceptions: [],
      changeNote: null,
    });
  });
  it.each([
    ['an unknown mode', { mode: 'anywhere' }, 'mode'],
    ['a missing mode', {}, 'mode'],
    [
      'an unknown data class in the allow-list',
      { mode: 'allow_listed', allowedCountriesByClass: { secrets: ['AE'] } },
      'allowedCountriesByClass.secrets',
    ],
    [
      'a lowercase country',
      { mode: 'allow_listed', allowedCountriesByClass: { personal: ['ae'] } },
      'allowedCountriesByClass.personal',
    ],
    [
      'a repeated country',
      { mode: 'allow_listed', allowedCountriesByClass: { personal: ['AE', 'AE'] } },
      'allowedCountriesByClass.personal',
    ],
    [
      'a non-list allow-list',
      { mode: 'allow_listed', allowedCountriesByClass: { personal: 'AE' } },
      'allowedCountriesByClass.personal',
    ],
    [
      'an allow-list that is not an object',
      { mode: 'allow_listed', allowedCountriesByClass: [] },
      'allowedCountriesByClass',
    ],
    [
      'an exception that is not an id',
      { mode: 'in_kingdom_only', exceptions: ['x'] },
      'exceptions',
    ],
    ['a repeated exception', { mode: 'in_kingdom_only', exceptions: [A1, A1] }, 'exceptions'],
    ['an empty change note', { mode: 'in_kingdom_only', changeNote: '' }, 'changeNote'],
  ])('rejects %s', (_n, body, field) =>
    expect(fields(() => parsePolicyBody(body))).toContain(field),
  );
});

describe('an organization may only tighten the platform floor', () => {
  const body = (over: Record<string, unknown>) =>
    parsePolicyBody({ mode: 'allow_listed', ...over });
  it('countries for a class the floor keeps in the Kingdom are refused', () => {
    expect(
      belowFloor(body({ allowedCountriesByClass: { credentials: ['AE'] } }), FLOOR, []).map(
        (x) => x.field,
      ),
    ).toEqual(['allowedCountriesByClass.credentials']);
  });
  it('an assessment for such a class cannot be used as an exception', () => {
    expect(belowFloor(body({}), FLOOR, ['credentials']).map((x) => x.field)).toEqual([
      'exceptions',
    ]);
  });
  it('countries and exceptions for the other classes are fine', () => {
    expect(
      belowFloor(
        body({ allowedCountriesByClass: { personal: ['AE'], financial: ['DE'] } }),
        FLOOR,
        ['personal'],
      ),
    ).toEqual([]);
  });
  it('an empty list for a strict class is fine, and a looser mode alone is not an error (the stricter of mode and floor always applies)', () => {
    expect(
      belowFloor(
        parsePolicyBody({
          mode: 'unrestricted_with_assessment',
          allowedCountriesByClass: { credentials: [] },
        }),
        FLOOR,
        [],
      ),
    ).toEqual([]);
  });
  it('a tighter floor refuses more', () => {
    const f: Floor = { version: 2, byClass: { ...FLOOR.byClass, personal: 'in_kingdom_only' } };
    expect(
      belowFloor(body({ allowedCountriesByClass: { personal: ['AE'] } }), f, []).map(
        (x) => x.field,
      ),
    ).toEqual(['allowedCountriesByClass.personal']);
  });
});

describe('transfer assessment request', () => {
  const NOW = new Date('2026-11-17T12:00:00Z');
  const create = (over: Record<string, unknown> = {}) => ({
    dataClass: 'personal',
    region: 'AE',
    risk: 'medium',
    mitigations: 'Contractual clauses and encryption in transit',
    expiresAt: '2027-03-01T00:00:00Z',
    ...over,
  });
  it('parses a create and a decision', () => {
    expect(parseAssessmentRequest(create(), NOW)).toMatchObject({
      kind: 'create',
      dataClass: 'personal',
      region: 'AE',
      processorId: null,
      orgId: null,
    });
    expect(parseAssessmentRequest({ assessmentId: A2, decision: 'approve' }, NOW)).toMatchObject({
      kind: 'decide',
      decision: 'approve',
      note: null,
    });
  });
  it.each([
    ['public data', { dataClass: 'public' }, 'dataClass'],
    ['an unknown class', { dataClass: 'secret' }, 'dataClass'],
    ['an in-Kingdom region', { region: 'SA' }, 'region'],
    ['the in_kingdom group', { region: 'in_kingdom' }, 'region'],
    ['a lowercase country', { region: 'ae' }, 'region'],
    ['no risk', { risk: 'huge' }, 'risk'],
    ['thin mitigations', { mitigations: 'none' }, 'mitigations'],
    ['a past expiry', { expiresAt: '2026-01-01T00:00:00Z' }, 'expiresAt'],
    ['an unparsable expiry', { expiresAt: 'soon' }, 'expiresAt'],
    ['a bad organization id', { orgId: 'x' }, 'orgId'],
    ['an empty processor', { processorId: '' }, 'processorId'],
  ])('rejects a create with %s', (_n, over, field) =>
    expect(fields(() => parseAssessmentRequest(create(over), NOW))).toContain(field),
  );
  it('rejects a bad decision and a bad id', () => {
    expect(
      fields(() => parseAssessmentRequest({ assessmentId: A2, decision: 'maybe' }, NOW)),
    ).toContain('decision');
    expect(
      fields(() => parseAssessmentRequest({ assessmentId: 'x', decision: 'approve' }, NOW)),
    ).toContain('assessmentId');
  });
});

describe('residency defaults file', () => {
  it('loads the committed proposal', () => {
    const d = loadResidencyDefaults();
    expect(d.defaultMode).toBe('in_kingdom_only');
    expect(d.floor.credentials).toBe('in_kingdom_only');
    expect(d.maxAssessmentDays).toBe(730);
    expect(d.cacheTtlMs).toBe(5000);
  });
  it('refuses a file with a missing class, an unknown mode or a bad number', () => {
    const base = `residency:\n  floor: { public: unrestricted_with_assessment, internal: unrestricted_with_assessment, customer-content: unrestricted_with_assessment, personal: unrestricted_with_assessment, financial: unrestricted_with_assessment, credentials: in_kingdom_only }\n  default_mode: in_kingdom_only\n  max_assessment_days: 365\n  cache_ttl_seconds: 5\n`;
    expect(() => parseResidencyDefaults(base)).not.toThrow();
    expect(() =>
      parseResidencyDefaults(base.replace('credentials: in_kingdom_only', 'credentials: nowhere')),
    ).toThrow(/floor.credentials/);
    expect(() =>
      parseResidencyDefaults(base.replace('default_mode: in_kingdom_only', 'default_mode: all')),
    ).toThrow(/default_mode/);
    expect(() => parseResidencyDefaults(base.replace('365', '5000'))).toThrow(
      /max_assessment_days/,
    );
    expect(() =>
      parseResidencyDefaults(base.replace('cache_ttl_seconds: 5', 'cache_ttl_seconds: -1')),
    ).toThrow(/cache_ttl/);
    expect(() => parseResidencyDefaults('x: 1')).toThrow(/residency section/);
  });
});
