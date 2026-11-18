import { offerFailures, type OfferFailure, type OfferFacts, type OfferPolicy } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import type { QuotaService } from '../../billing';
import type { ResidencyService } from '../../compliance';
import { isProduction } from './adapter-registry';
import { UUID, iso, type Row } from './common';
import type { OfferPrice, OfferPriceComposer } from './offer-price';
import type { ComputeQuotaGuard } from './quota-guard';

/** Everything known about one (account, region, plan) offer. `failures` empty = eligible. Internal: provider identity lives here. */
export interface OfferCandidate {
  offerId: string; // provider_plans.id: opaque, stable across catalog syncs
  accountId: string;
  accountName: string;
  providerId: string;
  providerKey: string;
  regionRowId: string; // cloud.provider_regions.id (what residency resolves)
  providerRegionId: string;
  country: string;
  geoGroup: string;
  planRef: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  bandwidth: string | null;
  providerPrice: { amountMinor: string; currency: string; period: string } | null;
  verifiedAt: Date | null;
  evidenceKind: string | null;
  capabilities: string[]; // supported compute.* capability ids of the account
  price: OfferPrice | null; // price of ONE instance for one month
  failures: OfferFailure[];
}
export interface OfferFilters {
  country?: string;
  geoGroup?: string;
  provider?: string;
  region?: string;
  minVcpu?: number;
  minMemoryMb?: number;
}
export interface RegionGroupLookup {
  groupOf(country: string): string;
}

const ISO2 = /^[A-Za-z]{2}$/;
export const parseOfferFilters = (q: Record<string, unknown>, admin: boolean): OfferFilters => {
  const bad = (m: string) => new ProblemException('invalid_filter', m);
  const f: OfferFilters = {};
  if (q.kind !== undefined && q.kind !== 'compute') throw bad('kind must be "compute"');
  if (q.country !== undefined) {
    if (typeof q.country !== 'string' || !ISO2.test(q.country))
      throw bad('country must be an ISO 3166-1 alpha-2 code');
    f.country = q.country.toUpperCase();
  }
  if (q.geoGroup !== undefined) {
    if (typeof q.geoGroup !== 'string' || !/^[a-z_]{2,30}$/.test(q.geoGroup))
      throw bad('geoGroup is invalid');
    f.geoGroup = q.geoGroup;
  }
  // provider identity and providerRegionId are never exposed to customers, so they cannot be filter inputs for them either
  for (const k of ['provider', 'region'] as const)
    if (q[k] !== undefined) {
      if (!admin) throw bad(`${k} is not a customer filter`);
      if (typeof q[k] !== 'string' || (q[k] as string).length > 100) throw bad(`${k} is invalid`);
      f[k] = q[k] as string;
    }
  for (const [k, key] of [
    ['minVcpu', 'minVcpu'],
    ['minMemoryMb', 'minMemoryMb'],
  ] as const)
    if (q[k] !== undefined) {
      const n = Number(q[k]);
      if (!Number.isInteger(n) || n < 1 || n > 1_000_000)
        throw bad(`${k} must be a positive integer`);
      f[key] = n;
    }
  return f;
};

export interface OfferConfig {
  /** Region verification older than this hides the offer (proposal: 7 days, M05 §4 task 6). */
  verificationTtlMs: number;
  production: boolean;
}
export const offerConfigFromEnv = (): OfferConfig => ({
  verificationTtlMs: Number(process.env.CLOUD_REGION_VERIFICATION_TTL_DAYS ?? 7) * 86_400_000,
  production: isProduction(),
});

const SELECT = `
  SELECT p.id AS plan_id, p.plan_ref, p.vcpu, p.memory_mb, p.disk_gb, p.bandwidth, p.provider_price_minor, p.currency, p.period, p.availability,
         r.id AS region_row_id, r.provider_region_id, r.country_code, r.state AS region_state, r.verified_at, r.evidence_ref, r.evidence_kind,
         a.id AS account_id, a.name AS account_name, a.status AS account_status, a.health_state, a.breaker_state->>'state' AS breaker_state,
         pr.id AS provider_id, pr.key AS provider_key, pr.status AS provider_status, pr.environment_policy,
         (SELECT jsonb_object_agg(cp.capability_id, cp.state) FROM cloud.provider_capabilities cp WHERE cp.account_id = a.id) AS caps
    FROM cloud.provider_plans p
    JOIN cloud.provider_regions r ON r.id = p.region_id
    JOIN cloud.provider_accounts a ON a.id = p.account_id
    JOIN cloud.providers pr ON pr.id = a.provider_id
   WHERE pr.kind = 'compute'`;

/**
 * Offer eligibility pipeline (docs/09 §8): reads the catalog under the audited platform scope on the org's behalf, evaluates the pure
 * `offerFailures` function for every plan (including the org-specific conditions: residency, entitlement, quota, Nuzm price), and returns candidates
 * with their failure reasons. Customers only ever see offers with NO failure.
 */
export class OfferService {
  constructor(
    private readonly db: Db,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly composer: OfferPriceComposer,
    private readonly quotas: Pick<QuotaService, 'check'>,
    private readonly quotaGuard: Pick<ComputeQuotaGuard, 'hasHeadroom'>,
    private readonly regions: RegionGroupLookup,
    private readonly now: () => Date,
    private readonly cfg: OfferConfig = offerConfigFromEnv(),
  ) {}

  async candidates(
    orgId: string,
    opts: { planId?: string; ignoreInstanceQuota?: boolean } = {},
  ): Promise<OfferCandidate[]> {
    const now = this.now();
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `${SELECT} ${opts.planId ? 'AND p.id = $1' : ''} ORDER BY p.id`,
            opts.planId ? [opts.planId] : [],
          )
        ).rows as Row[],
    );
    if (!rows.length) return [];
    const pricer = await this.composer.session(orgId, now);
    const entitlementAllows = await this.quotas.check(orgId, 'compute', '1', now).then(
      (r) => r.allowed,
      () => false,
    );
    const quotaAllows = opts.ignoreInstanceQuota
      ? true
      : await this.quotaGuard.hasHeadroom(orgId).catch(() => false);
    const residencyByRegion = new Map<string, Promise<boolean>>();
    const residencyAllows = (r: Row): Promise<boolean> => {
      const key = `${r.region_row_id as string}|${r.provider_key as string}`;
      let p = residencyByRegion.get(key);
      if (!p) {
        p = this.residency
          .evaluate({
            orgId,
            dataClass: 'customer-content',
            targetRegion: r.region_row_id as string,
            purpose: 'compute.offer',
            processorId: r.provider_key as string,
            operation: 'read',
          })
          .then(
            (d) => d.decision === 'allow',
            () => false,
          ); // fail closed
        residencyByRegion.set(key, p);
      }
      return p;
    };
    const out: OfferCandidate[] = [];
    for (const r of rows) {
      const caps = (r.caps ?? {}) as OfferFacts['capabilities'];
      const price = pricer(
        { vcpu: r.vcpu as number, memoryMb: r.memory_mb as number, diskGb: r.disk_gb as number },
        1,
      );
      const facts: OfferFacts = {
        provider: {
          status: r.provider_status as 'active' | 'disabled',
          environmentPolicy: r.environment_policy as 'any' | 'non_production_only',
        },
        account: {
          status: r.account_status as 'active' | 'disabled',
          healthState: r.health_state as OfferFacts['account']['healthState'],
          breakerState: ((r.breaker_state as string | null) ??
            'closed') as OfferFacts['account']['breakerState'],
        },
        region: {
          state: r.region_state as 'listed' | 'verified' | 'withdrawn',
          verifiedAt: (r.verified_at as Date | null) ?? null,
          evidenceRef: (r.evidence_ref as string | null) ?? null,
          evidenceKind: (r.evidence_kind as 'live' | 'fixture' | 'mock' | null) ?? null,
        },
        plan: {
          availability: r.availability as 'available' | 'sold_out' | 'unavailable',
          hasProviderPrice: r.provider_price_minor !== null,
        },
        capabilities: caps,
        nuzmPricePresent: price !== null,
      };
      const policy: OfferPolicy = {
        now,
        production: this.cfg.production,
        verificationTtlMs: this.cfg.verificationTtlMs,
        residencyAllows: facts.region.state === 'verified' ? await residencyAllows(r) : false, // an unverified region is never placed
        quotaAllows,
        entitlementAllows,
      };
      const country = (r.country_code as string).trim();
      out.push({
        offerId: r.plan_id as string,
        accountId: r.account_id as string,
        accountName: r.account_name as string,
        providerId: r.provider_id as string,
        providerKey: r.provider_key as string,
        regionRowId: r.region_row_id as string,
        providerRegionId: r.provider_region_id as string,
        country,
        geoGroup: this.regions.groupOf(country),
        planRef: r.plan_ref as string,
        vcpu: r.vcpu as number,
        memoryMb: r.memory_mb as number,
        diskGb: r.disk_gb as number,
        bandwidth: (r.bandwidth as string | null) ?? null,
        providerPrice:
          r.provider_price_minor === null
            ? null
            : {
                amountMinor: String(r.provider_price_minor),
                currency: (r.currency as string).trim(),
                period: r.period as string,
              },
        verifiedAt: facts.region.verifiedAt,
        evidenceKind: facts.region.evidenceKind,
        capabilities: Object.entries(caps)
          .filter(([, s]) => s === 'supported')
          .map(([id]) => id)
          .sort(),
        price,
        failures: offerFailures(facts, policy),
      });
    }
    return out;
  }

  async eligible(
    orgId: string,
    opts: { planId?: string; ignoreInstanceQuota?: boolean } = {},
  ): Promise<OfferCandidate[]> {
    return (await this.candidates(orgId, opts)).filter(
      (c) => c.failures.length === 0 && c.price !== null,
    );
  }

  /** Customer view (portals C/A/R): no provider identity, no providerRegionId, no provider cost. */
  customerView(c: OfferCandidate) {
    return {
      offerId: c.offerId,
      kind: 'compute' as const,
      country: c.country,
      dataRegion: c.geoGroup,
      plan: {
        vcpu: c.vcpu,
        memoryMb: c.memoryMb,
        diskGb: c.diskGb,
        ...(c.bandwidth ? { bandwidth: c.bandwidth } : {}),
      },
      price: {
        amount: c.price!.monthlyMinor.toString(),
        currency: c.price!.currency,
        period: 'month' as const,
      },
      capabilities: c.capabilities,
      verifiedAt: iso(c.verifiedAt),
    };
  }
  /** Admin view (portal X): adds provider identity, provider region id, provider cost, evidence kind and the failure reasons. */
  adminView(c: OfferCandidate) {
    return {
      offerId: c.offerId,
      kind: 'compute' as const,
      country: c.country,
      dataRegion: c.geoGroup,
      plan: {
        vcpu: c.vcpu,
        memoryMb: c.memoryMb,
        diskGb: c.diskGb,
        ...(c.bandwidth ? { bandwidth: c.bandwidth } : {}),
      },
      price: c.price
        ? {
            amount: c.price.monthlyMinor.toString(),
            currency: c.price.currency,
            period: 'month' as const,
          }
        : null,
      capabilities: c.capabilities,
      verifiedAt: iso(c.verifiedAt),
      provider: { key: c.providerKey, accountId: c.accountId, accountName: c.accountName },
      providerRegionId: c.providerRegionId,
      planRef: c.planRef,
      providerPrice: c.providerPrice,
      evidenceKind: c.evidenceKind,
      eligible: c.failures.length === 0 && c.price !== null,
      failures: c.failures,
    };
  }

  filter(cs: OfferCandidate[], f: OfferFilters): OfferCandidate[] {
    return cs.filter(
      (c) =>
        (f.country === undefined || c.country === f.country) &&
        (f.geoGroup === undefined || c.geoGroup === f.geoGroup) &&
        (f.provider === undefined || c.providerKey === f.provider) &&
        (f.region === undefined || c.providerRegionId === f.region) &&
        (f.minVcpu === undefined || c.vcpu >= f.minVcpu) &&
        (f.minMemoryMb === undefined || c.memoryMb >= f.minMemoryMb),
    );
  }

  /** Stable order for paging: price ascending, then offer id. */
  static sort(cs: OfferCandidate[]): OfferCandidate[] {
    return [...cs].sort((a, b) => {
      const pa = a.price?.monthlyMinor ?? 0n;
      const pb = b.price?.monthlyMinor ?? 0n;
      return pa < pb
        ? -1
        : pa > pb
          ? 1
          : a.offerId < b.offerId
            ? -1
            : a.offerId > b.offerId
              ? 1
              : 0;
    });
  }
  static page<T extends { offerId: string; price: { amount: string } | null }>(
    items: T[],
    cursor: string | undefined,
    limit: number,
  ) {
    let start = 0;
    if (cursor) {
      const [amt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      if (amt === undefined || id === undefined || !UUID.test(id) || !/^\d+$/.test(amt))
        throw new ProblemException('invalid_filter', 'cursor is invalid');
      start = items.findIndex(
        (i) =>
          BigInt(i.price?.amount ?? '0') > BigInt(amt) ||
          (BigInt(i.price?.amount ?? '0') === BigInt(amt) && i.offerId > id),
      );
      if (start < 0) start = items.length;
    }
    const slice = items.slice(start, start + limit);
    const last = slice[slice.length - 1];
    return {
      items: slice,
      nextCursor:
        start + limit < items.length && last
          ? Buffer.from(`${last.price?.amount ?? '0'}|${last.offerId}`).toString('base64url')
          : null,
    };
  }
}
