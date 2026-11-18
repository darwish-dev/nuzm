/**
 * Offer eligibility (docs/09 §8, M05 §1): an offer is shown only if ALL of these hold — account healthy ∧ region verified (fresh, with
 * evidence) ∧ plan available ∧ capability supported ∧ residency allows ∧ org entitlement/quota allows ∧ price present. Any false → not shown.
 * Pure and exhaustive: `offerFailures` names every failing condition (admin dry-run), `isOfferEligible` is the single gate.
 */
export type EvidenceKindFact = 'live' | 'fixture' | 'mock';

export interface OfferFacts {
  provider: { status: 'active' | 'disabled'; environmentPolicy: 'any' | 'non_production_only' };
  account: {
    status: 'active' | 'disabled';
    healthState: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
    breakerState: 'closed' | 'open' | 'half_open';
  };
  region: {
    state: 'listed' | 'verified' | 'withdrawn';
    verifiedAt: Date | null;
    evidenceRef: string | null;
    evidenceKind: EvidenceKindFact | null;
  };
  plan: { availability: 'available' | 'sold_out' | 'unavailable'; hasProviderPrice: boolean };
  /** Capability states of the ACCOUNT as probed. Absent = unknown = unsupported. */
  capabilities: Readonly<Record<string, 'supported' | 'unsupported' | 'unknown' | undefined>>;
  /** Does Nuzm have a customer price for this plan (price book, D-23 open)? */
  nuzmPricePresent: boolean;
}
export interface OfferPolicy {
  now: Date;
  production: boolean;
  /** Region verification older than this hides the offer (proposal 7 days, M05 §4 task 6). */
  verificationTtlMs: number;
  residencyAllows: boolean;
  quotaAllows: boolean;
  entitlementAllows: boolean;
}

/** Lifecycle capabilities a compute offer needs: without all three we could not even clean up what we create. */
export const OFFER_REQUIRED_CAPABILITIES = [
  'compute.provision',
  'compute.inspect',
  'compute.delete',
] as const;

export type OfferFailure =
  | 'provider_inactive'
  | 'provider_not_permitted'
  | 'account_inactive'
  | 'account_unhealthy'
  | 'breaker_open'
  | 'region_not_verified'
  | 'region_stale'
  | 'region_evidence_not_live'
  | 'plan_unavailable'
  | 'capability_unsupported'
  | 'residency_denied'
  | 'quota_blocked'
  | 'entitlement_blocked'
  | 'no_provider_price'
  | 'no_nuzm_price';

export function offerFailures(f: OfferFacts, p: OfferPolicy): OfferFailure[] {
  const out: OfferFailure[] = [];
  if (f.provider.status !== 'active') out.push('provider_inactive');
  if (f.provider.environmentPolicy === 'non_production_only' && p.production)
    out.push('provider_not_permitted');
  if (f.account.status !== 'active') out.push('account_inactive');
  if (f.account.healthState !== 'healthy') out.push('account_unhealthy');
  if (f.account.breakerState !== 'closed') out.push('breaker_open');
  const r = f.region;
  const verified =
    r.state === 'verified' &&
    r.verifiedAt !== null &&
    r.evidenceRef !== null &&
    r.evidenceKind !== null;
  if (!verified) out.push('region_not_verified');
  else {
    if (p.now.getTime() - r.verifiedAt!.getTime() > p.verificationTtlMs) out.push('region_stale');
    // A production profile only trusts LIVE evidence; mock/fixture evidence proves nothing about a real account.
    if (p.production && r.evidenceKind !== 'live') out.push('region_evidence_not_live');
  }
  if (f.plan.availability !== 'available') out.push('plan_unavailable');
  if (OFFER_REQUIRED_CAPABILITIES.some((c) => f.capabilities[c] !== 'supported'))
    out.push('capability_unsupported');
  if (!p.residencyAllows) out.push('residency_denied');
  if (!p.quotaAllows) out.push('quota_blocked');
  if (!p.entitlementAllows) out.push('entitlement_blocked');
  if (!f.plan.hasProviderPrice) out.push('no_provider_price');
  if (!f.nuzmPricePresent) out.push('no_nuzm_price');
  return out;
}
export const isOfferEligible = (f: OfferFacts, p: OfferPolicy): boolean =>
  offerFailures(f, p).length === 0;
