import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ABSENCE_RULE,
  RESOURCE_STATES,
  RESOURCE_TRANSITIONS,
  absenceProven,
  assertResourceTransition,
  canTransitionResource,
  classifyObservation,
  isOfferEligible,
  isResourceState,
  offerFailures,
  replayUsage,
  route,
  scaledDecimal,
  sumMeter,
  usageForInterval,
  type OfferFacts,
  type OfferPolicy,
  type RouteCandidate,
  type RoutingRule,
  type RunInterval,
} from './index';

describe('canonical resource states (docs/05 §9, AC-M05-24)', () => {
  it('are exactly the nine documented states', () => {
    expect([...RESOURCE_STATES]).toEqual([
      'DRAFT',
      'QUOTED',
      'AWAITING_PAYMENT',
      'PROVISIONING',
      'ACTIVE',
      'FAILED',
      'DELETING',
      'DELETED',
      'UNKNOWN',
    ]);
    expect(isResourceState('RUNNING')).toBe(false);
    expect(isResourceState('active')).toBe(false);
  });
  it('rejects every pair outside the table, for both actors', () => {
    for (const from of RESOURCE_STATES)
      for (const to of RESOURCE_STATES) {
        const listed = RESOURCE_TRANSITIONS[from].includes(to);
        expect(canTransitionResource(from, to, 'reconciler')).toBe(listed);
        const orchestratorOk = listed && from !== 'UNKNOWN';
        expect(canTransitionResource(from, to, 'orchestrator')).toBe(orchestratorOk);
      }
  });
  it('only the reconciler may leave UNKNOWN; DELETED is terminal', () => {
    expect(() => assertResourceTransition('UNKNOWN', 'ACTIVE', 'orchestrator')).toThrow(
      /illegal resource transition/,
    );
    expect(() => assertResourceTransition('UNKNOWN', 'ACTIVE', 'reconciler')).not.toThrow();
    expect(RESOURCE_TRANSITIONS.DELETED).toEqual([]);
    expect(canTransitionResource('PROVISIONING', 'UNKNOWN', 'orchestrator')).toBe(true);
  });
});

const facts = (o: Partial<OfferFacts> = {}): OfferFacts => ({
  provider: { status: 'active', environmentPolicy: 'any' },
  account: { status: 'active', healthState: 'healthy', breakerState: 'closed' },
  region: {
    state: 'verified',
    verifiedAt: new Date('2026-11-17T00:00:00Z'),
    evidenceRef: 'evidence:x',
    evidenceKind: 'live',
  },
  plan: { availability: 'available', hasProviderPrice: true },
  capabilities: {
    'compute.provision': 'supported',
    'compute.inspect': 'supported',
    'compute.delete': 'supported',
  },
  nuzmPricePresent: true,
  ...o,
});
const policy = (o: Partial<OfferPolicy> = {}): OfferPolicy => ({
  now: new Date('2026-11-18T00:00:00Z'),
  production: false,
  verificationTtlMs: 7 * 86_400_000,
  residencyAllows: true,
  quotaAllows: true,
  entitlementAllows: true,
  ...o,
});

describe('offer eligibility', () => {
  it('a fully satisfied offer is eligible', () => {
    expect(isOfferEligible(facts(), policy())).toBe(true);
  });
  it.each([
    [
      'provider disabled',
      facts({ provider: { status: 'disabled', environmentPolicy: 'any' } }),
      policy(),
      'provider_inactive',
    ],
    [
      'simulator in production',
      facts({ provider: { status: 'active', environmentPolicy: 'non_production_only' } }),
      policy({ production: true }),
      'provider_not_permitted',
    ],
    [
      'account unhealthy',
      facts({ account: { status: 'active', healthState: 'unhealthy', breakerState: 'closed' } }),
      policy(),
      'account_unhealthy',
    ],
    [
      'account degraded is not healthy',
      facts({ account: { status: 'active', healthState: 'degraded', breakerState: 'closed' } }),
      policy(),
      'account_unhealthy',
    ],
    [
      'breaker open',
      facts({ account: { status: 'active', healthState: 'healthy', breakerState: 'open' } }),
      policy(),
      'breaker_open',
    ],
    [
      'region only listed',
      facts({
        region: { state: 'listed', verifiedAt: null, evidenceRef: null, evidenceKind: null },
      }),
      policy(),
      'region_not_verified',
    ],
    [
      'verified but no evidence ref',
      facts({
        region: {
          state: 'verified',
          verifiedAt: new Date('2026-11-17T00:00:00Z'),
          evidenceRef: null,
          evidenceKind: 'live',
        },
      }),
      policy(),
      'region_not_verified',
    ],
    [
      'stale verification',
      facts({
        region: {
          state: 'verified',
          verifiedAt: new Date('2026-11-01T00:00:00Z'),
          evidenceRef: 'e',
          evidenceKind: 'live',
        },
      }),
      policy(),
      'region_stale',
    ],
    [
      'mock evidence in production',
      facts({
        region: {
          state: 'verified',
          verifiedAt: new Date('2026-11-17T00:00:00Z'),
          evidenceRef: 'e',
          evidenceKind: 'mock',
        },
      }),
      policy({ production: true }),
      'region_evidence_not_live',
    ],
    [
      'sold out',
      facts({ plan: { availability: 'sold_out', hasProviderPrice: true } }),
      policy(),
      'plan_unavailable',
    ],
    [
      'capability unknown',
      facts({ capabilities: { 'compute.provision': 'supported', 'compute.inspect': 'supported' } }),
      policy(),
      'capability_unsupported',
    ],
    [
      'capability unsupported',
      facts({
        capabilities: {
          'compute.provision': 'supported',
          'compute.inspect': 'supported',
          'compute.delete': 'unsupported',
        },
      }),
      policy(),
      'capability_unsupported',
    ],
    ['residency denies', facts(), policy({ residencyAllows: false }), 'residency_denied'],
    ['quota blocks', facts(), policy({ quotaAllows: false }), 'quota_blocked'],
    ['entitlement blocks', facts(), policy({ entitlementAllows: false }), 'entitlement_blocked'],
    [
      'no provider price',
      facts({ plan: { availability: 'available', hasProviderPrice: false } }),
      policy(),
      'no_provider_price',
    ],
    ['no Nuzm price', facts({ nuzmPricePresent: false }), policy(), 'no_nuzm_price'],
  ])('hides the offer: %s', (_n, f, p, failure) => {
    expect(offerFailures(f, p)).toContain(failure);
    expect(isOfferEligible(f, p)).toBe(false);
  });
});

const cand = (o: Partial<RouteCandidate> & { offerId: string }): RouteCandidate => ({
  providerKey: 'p1',
  accountId: 'a1',
  providerRegionId: 'r1',
  country: 'DE',
  geoGroup: 'eu',
  planRef: 'small',
  priceMinor: 100n,
  ...o,
});
describe('routing', () => {
  const pool = [
    cand({ offerId: 'o1', providerKey: 'b', priceMinor: 100n }),
    cand({ offerId: 'o2', providerKey: 'a', priceMinor: 100n, accountId: 'a2' }),
    cand({
      offerId: 'o3',
      providerKey: 'a',
      priceMinor: 90n,
      country: 'SA',
      geoGroup: 'in_kingdom',
      providerRegionId: 'r2',
    }),
    cand({ offerId: 'o4', providerKey: 'c', priceMinor: 100n }),
  ];
  it('automatic mode: cheapest first, then a total deterministic tie-break (provider, account, region, plan)', () => {
    const r = route(pool, { mode: 'automatic' }, []);
    expect(r.chosen?.offerId).toBe('o3');
    const eu = route(pool, { mode: 'automatic', country: 'DE' }, []);
    expect(eu.decision.order).toEqual(['o2', 'o1', 'o4']); // equal price: provider key a < b < c
    expect(eu.decision.tieBreak).toEqual([
      'rank',
      'priceMinor',
      'providerKey',
      'accountId',
      'providerRegionId',
      'planRef',
    ]);
  });
  it('is independent of the input order', () => {
    const a = route(pool, { mode: 'automatic', country: 'DE' }, []);
    const b = route([...pool].reverse(), { mode: 'automatic', country: 'DE' }, []);
    expect(b.decision.order).toEqual(a.decision.order);
  });
  it('explicit mode filters by provider and region and may match nothing', () => {
    expect(route(pool, { mode: 'explicit', provider: 'a', region: 'r1' }, []).chosen?.offerId).toBe(
      'o2',
    );
    expect(route(pool, { mode: 'explicit', provider: 'zzz' }, []).chosen).toBeNull();
  });
  it('geoGroup filter', () => {
    expect(route(pool, { mode: 'automatic', geoGroup: 'in_kingdom' }, []).chosen?.offerId).toBe(
      'o3',
    );
  });
  const rule = (r: Partial<RoutingRule> & { ruleKey: string }): RoutingRule => ({
    version: 1,
    priority: 10,
    enabled: true,
    match: {},
    action: { type: 'prefer' },
    ...r,
  });
  it('prefer ranks ahead of price; exclude removes; pin restricts (and is recorded)', () => {
    const prefer = route(pool, { mode: 'automatic', country: 'DE' }, [
      rule({ ruleKey: 'pref-c', action: { type: 'prefer', providerKey: 'c' } }),
    ]);
    expect(prefer.chosen?.offerId).toBe('o4');
    expect(prefer.decision.rulesApplied).toEqual([
      { ruleKey: 'pref-c', version: 1, type: 'prefer', effect: 'preferred 1' },
    ]);
    const excl = route(pool, { mode: 'automatic', country: 'DE' }, [
      rule({ ruleKey: 'no-a', action: { type: 'exclude', providerKey: 'a' } }),
    ]);
    expect(excl.decision.order).toEqual(['o1', 'o4']);
    const pin = route(pool, { mode: 'automatic', country: 'DE' }, [
      rule({ ruleKey: 'pin-b', action: { type: 'pin', providerKey: 'b' } }),
    ]);
    expect(pin.decision.order).toEqual(['o1']);
    const badPin = route(pool, { mode: 'automatic', country: 'DE' }, [
      rule({ ruleKey: 'pin-x', action: { type: 'pin', providerKey: 'x' } }),
    ]);
    expect(badPin.decision.rulesApplied[0]?.effect).toMatch(/ignored/);
    expect(badPin.chosen?.offerId).toBe('o2');
  });
  it('disabled rules and non-matching conditions do nothing; priority orders rules', () => {
    const off = route(pool, { mode: 'automatic', country: 'DE' }, [
      rule({ ruleKey: 'x', enabled: false, action: { type: 'exclude', providerKey: 'a' } }),
    ]);
    expect(off.decision.order).toHaveLength(3);
    const other = route(pool, { mode: 'automatic', country: 'DE' }, [
      rule({
        ruleKey: 'y',
        match: { country: ['SA'] },
        action: { type: 'exclude', providerKey: 'a' },
      }),
    ]);
    expect(other.decision.order).toHaveLength(3);
    const first = route(pool, { mode: 'automatic', country: 'DE' }, [
      rule({ ruleKey: 'late', priority: 20, action: { type: 'prefer', providerKey: 'b' } }),
      rule({ ruleKey: 'early', priority: 5, action: { type: 'prefer', providerKey: 'c' } }),
    ]);
    expect(first.decision.order.slice(0, 2)).toEqual(['o4', 'o1']);
  });
});

describe('absence proof (reconcile before retry)', () => {
  const t0 = 1_000_000;
  const rule = DEFAULT_ABSENCE_RULE;
  it('one observation is never proof; an early observation (inside the consistency window) does not count', () => {
    expect(absenceProven(t0, [{ at: t0 + rule.windowMs + 1, found: false }])).toBe(false);
    expect(
      absenceProven(t0, [
        { at: t0 + 1000, found: false },
        { at: t0 + 2000, found: false },
      ]),
    ).toBe(false);
  });
  it('two absent observations after the window and spaced apart prove absence', () => {
    expect(
      absenceProven(t0, [
        { at: t0 + rule.windowMs, found: false },
        { at: t0 + rule.windowMs + rule.gapMs, found: false },
      ]),
    ).toBe(true);
  });
  it('observations that are too close together do not count twice', () => {
    expect(
      absenceProven(t0, [
        { at: t0 + rule.windowMs, found: false },
        { at: t0 + rule.windowMs + 1000, found: false },
      ]),
    ).toBe(false);
  });
  it('any sighting after the attempt voids the proof', () => {
    expect(
      absenceProven(t0, [
        { at: t0 + rule.windowMs, found: false },
        { at: t0 + rule.windowMs + 40_000, found: true },
        { at: t0 + rule.windowMs + 80_000, found: false },
      ]),
    ).toBe(false);
  });
  it('classification: unreadable never changes state; absent is missing; differing status/plan is drift', () => {
    const exp = { status: 'running', planRef: 'p' };
    expect(classifyObservation(exp, { kind: 'unreadable' })).toBe('unchanged');
    expect(classifyObservation(exp, { kind: 'absent' })).toBe('missing');
    expect(classifyObservation(exp, { kind: 'found', status: 'running', planRef: 'p' })).toBe(
      'in_sync',
    );
    expect(classifyObservation(exp, { kind: 'found', status: 'stopped', planRef: 'p' })).toBe(
      'drift',
    );
    expect(classifyObservation(exp, { kind: 'found', status: 'running', planRef: 'q' })).toBe(
      'drift',
    );
  });
});

describe('compute metering replay (AC-M05-11): exact quantities', () => {
  const H = 3_600_000;
  const T = Date.UTC(2026, 10, 18, 0, 0, 0); // 2026-11-18 00:00Z
  const spec = { vcpu: 2, memoryMb: 4096, diskGb: 80 };
  it('scaledDecimal rounds half up at 8 decimals', () => {
    expect(scaledDecimal(1n, 3n)).toBe('0.33333333');
    expect(scaledDecimal(2n, 3n)).toBe('0.66666667');
    expect(scaledDecimal(5n, 2n)).toBe('2.50000000');
  });
  it('timeline 1: 3 whole hours running', () => {
    const m = replayUsage([{ startMs: T, endMs: T + 3 * H, ...spec }], T, T + 10 * H);
    expect(sumMeter(m, 'compute.vcpu_hours')).toBe('6.00000000');
    expect(sumMeter(m, 'compute.memory_gb_hours')).toBe('12.00000000'); // 4 GiB x 3 h
    expect(sumMeter(m, 'compute.disk_gb_months')).toBe(
      scaledDecimal(80n * 3n * BigInt(H), BigInt(30 * 24 * H)),
    ); // November has 30 days
  });
  it('timeline 2: partial hours at both ends (00:20 → 02:50)', () => {
    const m = replayUsage(
      [{ startMs: T + 20 * 60_000, endMs: T + 2 * H + 50 * 60_000, ...spec }],
      T,
      T + 10 * H,
    );
    expect(sumMeter(m, 'compute.vcpu_hours')).toBe('5.00000000'); // 2.5 h x 2 vcpu
  });
  it('timeline 3: start, stop, start again (two intervals) sums both and skips the stopped hour', () => {
    const ivs: RunInterval[] = [
      { startMs: T, endMs: T + H, ...spec },
      { startMs: T + 2 * H, endMs: T + 3 * H, ...spec },
    ];
    expect(sumMeter(replayUsage(ivs, T, T + 10 * H), 'compute.vcpu_hours')).toBe('4.00000000');
  });
  it('timeline 4: resize mid-hour splits the quantity by plan (1 vcpu for 30 min, 4 vcpu for 30 min)', () => {
    const ivs: RunInterval[] = [
      { startMs: T, endMs: T + 30 * 60_000, vcpu: 1, memoryMb: 1024, diskGb: 20 },
      { startMs: T + 30 * 60_000, endMs: T + H, vcpu: 4, memoryMb: 4096, diskGb: 20 },
    ];
    const m = replayUsage(ivs, T, T + 10 * H);
    expect(sumMeter(m, 'compute.vcpu_hours')).toBe('2.50000000');
    expect(sumMeter(m, 'compute.memory_gb_hours')).toBe('2.50000000');
  });
  it('timeline 5: an open interval counts only up to `to`; replaying in two slices equals one replay (no gaps, no overlaps)', () => {
    const iv: RunInterval = { startMs: T, endMs: null, ...spec };
    const whole = replayUsage([iv], T, T + 5 * H);
    const a = replayUsage([iv], T, T + 2 * H);
    const b = replayUsage([iv], T + 2 * H, T + 5 * H);
    expect(sumMeter(whole, 'compute.vcpu_hours')).toBe('10.00000000');
    for (const meter of [
      'compute.vcpu_hours',
      'compute.memory_gb_hours',
      'compute.disk_gb_months',
    ] as const) {
      const sum = [...a, ...b].filter(([k]) => k.startsWith(meter)).reduce((s, [, v]) => s + v, 0n);
      const all = [...whole].filter(([k]) => k.startsWith(meter)).reduce((s, [, v]) => s + v, 0n);
      expect(sum).toBe(all);
    }
  });
  it('duplicate (meter, window) keys are one entry per interval: the same window list is produced every time', () => {
    const iv: RunInterval = { startMs: T, endMs: T + 2 * H, ...spec };
    expect(usageForInterval(iv, T, T + 10 * H)).toEqual(usageForInterval(iv, T, T + 10 * H));
    expect(usageForInterval(iv, T, T + 10 * H)).toHaveLength(6); // 2 hours x 3 meters
    expect(usageForInterval(iv, T + 5 * H, T + 6 * H)).toEqual([]);
  });
});
