import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  CLASSES,
  MODES,
  evaluate,
  stricter,
  type AssessmentRef,
  type DataClass,
  type EvaluateInput,
  type Floor,
  type Mode,
  type OrgPolicy,
} from './evaluator';
import { MockRegionRegistry, parseRegionGroups } from './regions';

const ORG = '0194a1b2-1111-7222-8333-444455556666';
const OTHER_ORG = '0194a1b2-2222-7222-8333-444455556666';
const NOW = new Date('2026-11-17T12:00:00Z');
const defaults = parse(
  readFileSync(join(__dirname, '../../../../../../../spec/compliance/defaults.yaml'), 'utf8'),
) as {
  residency: { floor: Record<DataClass, Mode>; default_mode: Mode };
};
const FLOOR: Floor = { version: 1, byClass: defaults.residency.floor };
const regions = new MockRegionRegistry();
const REGION = {
  in_kingdom: 'sa-central',
  gcc: 'ae-dubai',
  eu: 'de-frankfurt',
  other: 'us-east',
} as const;
const GROUPS = ['in_kingdom', 'gcc', 'eu', 'other'] as const;

const policy = (mode: Mode, extra: Partial<OrgPolicy> = {}): OrgPolicy => ({
  version: 3,
  mode,
  allowedCountriesByClass: Object.fromEntries(CLASSES.map((c) => [c, ['AE']])),
  exceptions: [],
  ...extra,
});
type RunOver = Omit<Partial<EvaluateInput>, 'target'> & { target: string; dataClass: DataClass };
const run = (over: RunOver): ReturnType<typeof evaluate> => {
  const { target, ...rest } = over;
  return evaluate({
    orgId: ORG,
    policy: policy('in_kingdom_only'),
    floor: FLOOR,
    defaultMode: defaults.residency.default_mode,
    assessments: [],
    processor: null,
    now: NOW,
    ...rest,
    target: regions.resolve(target),
  } as EvaluateInput);
};
const A = 'allow';
const D = 'deny';
const R = 'requires_assessment';

/** EXPECTED decision for every (class, mode, group): the 72-cell matrix as a literal fixture (columns: in_kingdom, gcc, eu, other), allow-list = [AE]. */
const MATRIX: Record<DataClass, Record<Mode, string[]>> = {
  public: {
    in_kingdom_only: [A, A, A, A],
    allow_listed: [A, A, A, A],
    unrestricted_with_assessment: [A, A, A, A],
  },
  internal: {
    in_kingdom_only: [A, D, D, D],
    allow_listed: [A, A, D, D],
    unrestricted_with_assessment: [A, R, R, R],
  },
  'customer-content': {
    in_kingdom_only: [A, D, D, D],
    allow_listed: [A, A, D, D],
    unrestricted_with_assessment: [A, R, R, R],
  },
  personal: {
    in_kingdom_only: [A, D, D, D],
    allow_listed: [A, A, D, D],
    unrestricted_with_assessment: [A, R, R, R],
  },
  financial: {
    in_kingdom_only: [A, D, D, D],
    allow_listed: [A, A, D, D],
    unrestricted_with_assessment: [A, R, R, R],
  },
  credentials: {
    in_kingdom_only: [A, D, D, D],
    allow_listed: [A, D, D, D],
    unrestricted_with_assessment: [A, D, D, D],
  }, // the floor keeps credentials in the Kingdom
};

describe('policy matrix: 6 data classes × 4 region groups × 3 modes = 72 cells (AC-M04-01)', () => {
  const cells = CLASSES.flatMap((c) =>
    MODES.flatMap((m) => GROUPS.map((g, gi) => ({ c, m, g, gi }))),
  );
  it('has exactly 72 cells', () => expect(cells).toHaveLength(72));
  it.each(cells)('$c · $m · $g', ({ c, m, g, gi }) => {
    const r = run({ dataClass: c, policy: policy(m), target: REGION[g] });
    expect(r.decision).toBe(MATRIX[c][m][gi]);
    expect(r.reasons.length).toBeGreaterThan(0);
    for (const x of r.reasons) {
      expect(x.message.ar.length).toBeGreaterThan(5);
      expect(x.message.en.length).toBeGreaterThan(5);
    }
    expect(r.policyVersion).toBe(3);
    expect(r.floorVersion).toBe(1);
    expect(r.evidenceRef).toMatch(/^rd_[0-9a-f]{24}$/);
  });
});

describe('platform floor versus organization policy', () => {
  const tight = (over: Partial<Record<DataClass, Mode>>): Floor => ({
    version: 7,
    byClass: { ...FLOOR.byClass, ...over },
  });
  it.each([
    [
      'no policy at all: the default is in-Kingdom only (personal, EU)',
      { policy: null },
      'personal',
      'eu',
      D,
      'in_kingdom_only',
    ],
    [
      'no policy at all: in-Kingdom region still allowed',
      { policy: null },
      'personal',
      'in_kingdom',
      A,
      'in_kingdom',
    ],
    [
      'the org is looser than the floor: the floor wins (credentials, unrestricted org)',
      { policy: policy('unrestricted_with_assessment') },
      'credentials',
      'gcc',
      D,
      'floor_in_kingdom_only',
    ],
    [
      'a floor of allow_listed beats an unrestricted org (listed country)',
      {
        floor: tight({ personal: 'allow_listed' }),
        policy: policy('unrestricted_with_assessment'),
      },
      'personal',
      'gcc',
      A,
      'country_allow_listed',
    ],
    [
      'a floor of allow_listed beats an unrestricted org (unlisted country)',
      {
        floor: tight({ personal: 'allow_listed' }),
        policy: policy('unrestricted_with_assessment'),
      },
      'personal',
      'eu',
      D,
      'country_not_allow_listed',
    ],
    [
      'the org tightens a loose floor (in_kingdom_only org, loose floor)',
      { policy: policy('in_kingdom_only') },
      'financial',
      'gcc',
      D,
      'in_kingdom_only',
    ],
    [
      'a floor of in_kingdom_only beats an allow_listed org',
      { floor: tight({ financial: 'in_kingdom_only' }), policy: policy('allow_listed') },
      'financial',
      'gcc',
      D,
      'floor_in_kingdom_only',
    ],
    [
      'the stricter of floor and org is used both ways (org allow_listed, floor loose)',
      { policy: policy('allow_listed') },
      'customer-content',
      'gcc',
      A,
      'country_allow_listed',
    ],
    [
      'an allow-list never reaches a class the floor forbids',
      { floor: tight({ internal: 'in_kingdom_only' }), policy: policy('allow_listed') },
      'internal',
      'gcc',
      D,
      'floor_in_kingdom_only',
    ],
    [
      'a class missing from the allow-list is denied',
      { policy: policy('allow_listed', { allowedCountriesByClass: { financial: ['AE'] } }) },
      'personal',
      'gcc',
      D,
      'country_not_allow_listed',
    ],
    [
      'an empty allow-list denies',
      { policy: policy('allow_listed', { allowedCountriesByClass: { personal: [] } }) },
      'personal',
      'gcc',
      D,
      'country_not_allow_listed',
    ],
    [
      'a country-level allow-list: Germany listed, Netherlands not',
      { policy: policy('allow_listed', { allowedCountriesByClass: { personal: ['DE'] } }) },
      'personal',
      'eu',
      A,
      'country_allow_listed',
    ],
    [
      'a policy version is reported',
      { policy: policy('in_kingdom_only', { version: 12 }) },
      'personal',
      'other',
      D,
      'in_kingdom_only',
    ],
    [
      'public data ignores floor and mode',
      { floor: tight({ public: 'in_kingdom_only' }), policy: policy('in_kingdom_only') },
      'public',
      'other',
      A,
      'public_data',
    ],
  ] as const)('%s', (_n, over, dataClass, group, decision, code) => {
    const r = run({ ...(over as object), dataClass, target: REGION[group as keyof typeof REGION] });
    expect(r.decision).toBe(decision);
    expect(r.reasons.map((x) => x.code)).toContain(code);
  });
  it('Germany versus the Netherlands under a country-level list', () => {
    const p = policy('allow_listed', { allowedCountriesByClass: { personal: ['DE'] } });
    expect(run({ dataClass: 'personal', policy: p, target: 'nl-amsterdam' }).decision).toBe(D);
  });
  it('orders the modes strictest first and picks the stricter', () => {
    expect(MODES).toEqual(['in_kingdom_only', 'allow_listed', 'unrestricted_with_assessment']);
    expect(stricter('allow_listed', 'in_kingdom_only')).toBe('in_kingdom_only');
    expect(stricter('unrestricted_with_assessment', 'allow_listed')).toBe('allow_listed');
    expect(stricter('allow_listed', 'allow_listed')).toBe('allow_listed');
  });
});

describe('exceptions: approved transfer assessments', () => {
  const asm = (over: Partial<AssessmentRef> = {}): AssessmentRef => ({
    id: 'asm-1',
    orgId: ORG,
    dataClass: 'personal',
    region: 'gcc',
    processorId: null,
    status: 'approved',
    expiresAt: new Date('2027-06-01T00:00:00Z'),
    ...over,
  });
  const withAsm = (a: AssessmentRef[], extra: Partial<OrgPolicy> = {}) =>
    policy('in_kingdom_only', { exceptions: a.map((x) => x.id), ...extra });
  const go = (
    a: AssessmentRef[],
    over: Omit<Partial<EvaluateInput>, 'target' | 'dataClass'> & {
      target?: string;
      dataClass?: DataClass;
    } = {},
  ) =>
    run({ dataClass: 'personal', target: 'ae-dubai', policy: withAsm(a), assessments: a, ...over });

  it('a valid assessment allows the transfer and names itself', () => {
    const r = go([asm()]);
    expect(r.decision).toBe(A);
    expect(r.assessmentId).toBe('asm-1');
    expect(r.reasons.map((x) => x.code)).toEqual(['assessment_exception']);
  });
  it('a country-scoped assessment works for that country only', () => {
    const a = asm({ region: 'AE' });
    expect(go([a]).decision).toBe(A);
    expect(go([a], { target: 'de-frankfurt' }).decision).toBe(D);
  });
  it('an expired assessment is ignored and says so', () => {
    const r = go([asm({ expiresAt: new Date('2026-11-17T11:59:59Z') })]);
    expect(r.decision).toBe(D);
    expect(r.reasons.map((x) => x.code)).toContain('assessment_expired');
  });
  it('an assessment that expires exactly now is expired', () => {
    expect(go([asm({ expiresAt: NOW })]).decision).toBe(D);
  });
  it.each([
    ['another data class', { dataClass: 'financial' as DataClass }],
    ['another region group', { region: 'eu' }],
    ['another organization', { orgId: OTHER_ORG }],
    ['a pending status', { status: 'pending' as const }],
    ['a rejected status', { status: 'rejected' as const }],
    ['a different processor', { processorId: 'Other Vendor' }],
  ])('an assessment for %s does not apply', (_n, over) => {
    expect(go([asm(over)]).decision).toBe(D);
  });
  it('an assessment the policy does not reference does not apply', () => {
    expect(
      run({
        dataClass: 'personal',
        target: 'ae-dubai',
        policy: policy('in_kingdom_only', { exceptions: [] }),
        assessments: [asm()],
      }).decision,
    ).toBe(D);
  });
  it('a platform-wide assessment (no organization) applies to every organization that references it', () => {
    expect(go([asm({ orgId: null })]).decision).toBe(A);
  });
  it('an assessment scoped to a processor needs that processor', () => {
    const a = asm({ processorId: 'Example PSP' });
    const processor = { exists: true, dataClasses: ['personal'] };
    expect(go([a], { processorId: 'Example PSP', processor }).decision).toBe(A);
    expect(go([a]).decision).toBe(D); // no processor named
  });
  it('nothing overrides a floor of in_kingdom_only', () => {
    const a = asm({ dataClass: 'credentials' });
    const r = go([a], { dataClass: 'credentials' });
    expect(r.decision).toBe(D);
    expect(r.reasons.map((x) => x.code)).toContain('floor_in_kingdom_only');
  });
  it('an exception lifts an unrestricted_with_assessment "requires assessment" into allow', () => {
    const a = asm();
    const r = run({
      dataClass: 'personal',
      target: 'ae-dubai',
      policy: policy('unrestricted_with_assessment', { exceptions: [a.id] }),
      assessments: [a],
    });
    expect(r.decision).toBe(A);
    const none = run({
      dataClass: 'personal',
      target: 'ae-dubai',
      policy: policy('unrestricted_with_assessment'),
    });
    expect(none.decision).toBe(R);
  });
});

describe('processors must be in the ROPA', () => {
  it('denies an unknown processor and a processor not registered for the class, before looking at the region', () => {
    const a = run({
      dataClass: 'personal',
      target: 'sa-central',
      processorId: 'Ghost Vendor',
      processor: { exists: false, dataClasses: [] },
    });
    expect(a.decision).toBe(D);
    expect(a.reasons.map((x) => x.code)).toEqual(['processor_not_in_ropa']);
    const b = run({
      dataClass: 'personal',
      target: 'sa-central',
      processorId: 'Narrow',
      processor: { exists: true, dataClasses: ['financial'] },
    });
    expect(b.reasons.map((x) => x.code)).toEqual(['processor_class_not_registered']);
    const c = run({
      dataClass: 'personal',
      target: 'sa-central',
      processorId: 'Good',
      processor: { exists: true, dataClasses: ['personal'] },
    });
    expect(c.decision).toBe(A);
  });
  it('a processor check is skipped for public data', () => {
    expect(
      run({ dataClass: 'public', target: 'us-east', processorId: 'Ghost', processor: null })
        .decision,
    ).toBe(A);
  });
});

describe('regions: a name proves nothing', () => {
  it('an unverified Saudi region is treated as outside the Kingdom and says so', () => {
    expect(regions.resolve('sa-pending')).toMatchObject({
      country: 'SA',
      group: 'other',
      verified: false,
    });
    const r = run({ dataClass: 'personal', target: 'sa-pending' });
    expect(r.decision).toBe(D);
    expect(r.reasons.map((x) => x.code)).toContain('region_unverified');
  });
  it('an unknown region and a bare country code carry no verification', () => {
    expect(regions.resolve('mars-1')).toMatchObject({
      group: 'other',
      verified: false,
      country: null,
    });
    expect(regions.resolve('SA')).toMatchObject({ country: 'SA', verified: false });
    expect(run({ dataClass: 'personal', target: 'SA' }).decision).toBe(D);
    expect(regions.resolve('DE')).toMatchObject({ group: 'eu' });
  });
  it('verified Saudi regions are in the Kingdom; groups are resolved from the file', () => {
    expect(regions.resolve('sa-central')).toMatchObject({ group: 'in_kingdom', verified: true });
    expect(regions.resolve('sa-west')).toMatchObject({ group: 'in_kingdom', verified: true });
    expect(regions.resolve('ae-dubai').group).toBe('gcc');
    expect(regions.resolve('de-frankfurt').group).toBe('eu');
    expect(regions.resolve('us-east').group).toBe('other');
    expect(regions.resolve('gcc')).toMatchObject({ group: 'gcc', country: null });
  });
  it('the region file is validated', () => {
    expect(() => parseRegionGroups('groups: {}')).toThrow(/in_kingdom|list of ISO/);
    expect(() => parseRegionGroups('groups: { in_kingdom: [SA], gcc: [SA], eu: [] }')).toThrow(
      /two groups/,
    );
    expect(() => parseRegionGroups('groups: { in_kingdom: [sa], gcc: [], eu: [] }')).toThrow(/ISO/);
    expect(() => parseRegionGroups('groups: { in_kingdom: [], gcc: [], eu: [] }')).toThrow(
      /at least one/,
    );
    expect(() =>
      parseRegionGroups(
        'groups: { in_kingdom: [SA], gcc: [], eu: [] }\nfixtures: [{ id: x, country: SA, verified: yes }]',
      ),
    ).toThrow(/fixture/);
  });
});

describe('the decision is deterministic and carries evidence', () => {
  it('the same input gives the same evidence reference; a different input another one', () => {
    const a = run({ dataClass: 'personal', target: 'us-east' });
    const b = run({ dataClass: 'personal', target: 'us-east' });
    const c = run({ dataClass: 'personal', target: 'de-frankfurt' });
    expect(a.evidenceRef).toBe(b.evidenceRef);
    expect(a.evidenceRef).not.toBe(c.evidenceRef);
  });
  it('the platform floor in the default file matches the proposal (credentials strictest)', () => {
    expect(defaults.residency.floor.credentials).toBe('in_kingdom_only');
    expect(defaults.residency.default_mode).toBe('in_kingdom_only');
    for (const c of CLASSES) expect(MODES).toContain(defaults.residency.floor[c]);
  });
});
