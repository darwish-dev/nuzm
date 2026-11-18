import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  OFFER_REQUIRED_CAPABILITIES,
  isOfferEligible,
  offerFailures,
  route,
  type OfferFacts,
  type OfferPolicy,
  type RouteCandidate,
} from '@nuzm/domain';

/**
 * AC-M05-02: eligibility property test over ≥ 10,000 randomized catalog / account / region / capability / residency states.
 * Invariant: an offer is returned ONLY IF every condition holds (and, conversely, if every condition holds it is returned): 0 violations.
 */
const NOW = Date.parse('2026-11-18T00:00:00Z');
const TTL = 7 * 86_400_000;
const state = <T>(...v: T[]) => fc.constantFrom(...v);
/** Mostly the GOOD value (so eligible states are reached often), sometimes any of the bad ones: the property needs positives to be meaningful. */
const mostly = <T>(good: T, ...bad: T[]) =>
  fc.oneof(
    { weight: 12, arbitrary: fc.constant(good) },
    { weight: 1, arbitrary: fc.constantFrom(...bad) },
  );
const capState = mostly<'supported' | 'unsupported' | 'unknown' | undefined>(
  'supported',
  'unsupported',
  'unknown',
  undefined,
);

const arbFacts: fc.Arbitrary<OfferFacts> = fc.record({
  provider: fc.record({
    status: mostly<'active' | 'disabled'>('active', 'disabled'),
    environmentPolicy: mostly<'any' | 'non_production_only'>('any', 'non_production_only'),
  }),
  account: fc.record({
    status: mostly<'active' | 'disabled'>('active', 'disabled'),
    healthState: mostly<'healthy' | 'degraded' | 'unhealthy' | 'unknown'>(
      'healthy',
      'degraded',
      'unhealthy',
      'unknown',
    ),
    breakerState: mostly<'closed' | 'open' | 'half_open'>('closed', 'open', 'half_open'),
  }),
  region: fc.record({
    state: mostly<'listed' | 'verified' | 'withdrawn'>('verified', 'listed', 'withdrawn'),
    verifiedAt: fc.oneof(
      {
        weight: 12,
        arbitrary: fc.integer({ min: NOW - 6 * 86_400_000, max: NOW }).map((t) => new Date(t)),
      },
      {
        weight: 2,
        arbitrary: fc
          .integer({ min: NOW - 30 * 86_400_000, max: NOW - 8 * 86_400_000 })
          .map((t) => new Date(t)),
      },
      { weight: 1, arbitrary: fc.constant(null) },
    ),
    evidenceRef: mostly<string | null>('evidence:a', null),
    evidenceKind: mostly<'live' | 'fixture' | 'mock' | null>('live', 'fixture', 'mock', null),
  }),
  plan: fc.record({
    availability: mostly<'available' | 'sold_out' | 'unavailable'>(
      'available',
      'sold_out',
      'unavailable',
    ),
    hasProviderPrice: mostly(true, false),
  }),
  capabilities: fc.record({
    'compute.provision': capState,
    'compute.inspect': capState,
    'compute.delete': capState,
    'compute.metrics': capState,
    'compute.action.resize': capState,
  }),
  nuzmPricePresent: mostly(true, false),
});
const arbPolicy: fc.Arbitrary<OfferPolicy> = fc.record({
  now: fc.constant(new Date(NOW)),
  production: mostly(false, true),
  verificationTtlMs: fc.constant(TTL),
  residencyAllows: mostly(true, false),
  quotaAllows: mostly(true, false),
  entitlementAllows: mostly(true, false),
});

/** An independent statement of docs/09 §8: account healthy ∧ region verified (fresh, evidence) ∧ plan available ∧ capability supported ∧ residency ∧ entitlement/quota ∧ price present. */
function oracle(f: OfferFacts, p: OfferPolicy): boolean {
  const accountHealthy =
    f.account.status === 'active' &&
    f.account.healthState === 'healthy' &&
    f.account.breakerState === 'closed';
  const providerUsable =
    f.provider.status === 'active' &&
    !(p.production && f.provider.environmentPolicy === 'non_production_only');
  const regionVerified =
    f.region.state === 'verified' &&
    f.region.verifiedAt !== null &&
    f.region.evidenceRef !== null &&
    f.region.evidenceKind !== null &&
    NOW - f.region.verifiedAt.getTime() <= TTL &&
    (!p.production || f.region.evidenceKind === 'live');
  const planAvailable = f.plan.availability === 'available';
  const capable = OFFER_REQUIRED_CAPABILITIES.every((c) => f.capabilities[c] === 'supported');
  const priced = f.plan.hasProviderPrice && f.nuzmPricePresent;
  return (
    providerUsable &&
    accountHealthy &&
    regionVerified &&
    planAvailable &&
    capable &&
    p.residencyAllows &&
    p.quotaAllows &&
    p.entitlementAllows &&
    priced
  );
}

describe('offer eligibility property test (AC-M05-02)', () => {
  it('10,000 random states: eligible ⇔ every condition holds; 0 violations', () => {
    let violations = 0;
    fc.assert(
      fc.property(arbFacts, arbPolicy, (f, p) => {
        const e = isOfferEligible(f, p);
        const o = oracle(f, p);
        if (e !== o) violations++;
        // the failure list is consistent with the verdict
        if (e !== (offerFailures(f, p).length === 0)) violations++;
        return e === o;
      }),
      { numRuns: 10_000, seed: 20261118 },
    );
    expect(violations).toBe(0);
  });

  it('10,000 random catalogs: every OFFER RETURNED satisfies all conditions (nothing unverified, unhealthy, unavailable, unsupported, denied or unpriced is ever shown)', () => {
    let returned = 0;
    let states = 0;
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbFacts, arbPolicy), { minLength: 1, maxLength: 6 }),
        (catalog) => {
          for (const [f, p] of catalog) {
            states++;
            if (!isOfferEligible(f, p)) continue;
            returned++;
            const ok =
              f.account.healthState === 'healthy' &&
              f.region.state === 'verified' &&
              f.region.evidenceRef !== null &&
              f.region.verifiedAt !== null &&
              f.plan.availability === 'available' &&
              OFFER_REQUIRED_CAPABILITIES.every((c) => f.capabilities[c] === 'supported') &&
              p.residencyAllows &&
              p.quotaAllows &&
              p.entitlementAllows &&
              f.plan.hasProviderPrice &&
              f.nuzmPricePresent;
            if (!ok) return false;
          }
          return true;
        },
      ),
      { numRuns: 4000, seed: 7 },
    );
    expect(states).toBeGreaterThanOrEqual(10_000);
    expect(returned).toBeGreaterThan(500); // the generator reaches eligible states often enough for the property to mean something
    expect(states - returned).toBeGreaterThan(500); // ... and ineligible ones
  });

  it('routing is deterministic: any permutation of the candidates yields the same order (property)', () => {
    const arbCand = fc.record({
      offerId: fc.uuid(),
      providerKey: state('a', 'b', 'c'),
      accountId: state('x1', 'x2'),
      providerRegionId: state('r1', 'r2'),
      country: state('SA', 'DE'),
      geoGroup: state('in_kingdom', 'eu'),
      planRef: state('s', 'm'),
      priceMinor: fc.bigInt({ min: 1n, max: 5n }),
    }) as fc.Arbitrary<RouteCandidate>;
    fc.assert(
      fc.property(
        fc.uniqueArray(arbCand, { selector: (c) => c.offerId, minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 1000 }),
        (cs, seed) => {
          const a = route(cs, { mode: 'automatic' }, []);
          const shuffled = [...cs].sort(
            (x, y) =>
              ((x.offerId.charCodeAt(seed % 8) * 31 + seed) % 7) -
              ((y.offerId.charCodeAt(seed % 8) * 31 + seed) % 7),
          );
          const b = route(shuffled, { mode: 'automatic' }, []);
          return (
            a.decision.order.join() === b.decision.order.join() &&
            a.chosen?.offerId === b.chosen?.offerId
          );
        },
      ),
      { numRuns: 500, seed: 3 },
    );
  });
});
