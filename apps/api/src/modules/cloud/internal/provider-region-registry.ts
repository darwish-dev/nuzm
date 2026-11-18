import type { Db } from '@nuzm/platform';
import type { MockRegionRegistry, RegionRegistry, RegionTarget } from '../../compliance';
import { UUID } from './common';
import { isProduction } from './adapter-registry';

/**
 * Region registry for the M04 residency service backed by `cloud.provider_regions` (M05). A region id that is a provider-region row id resolves
 * from the database: it counts as verified ONLY with `verified_at` + `evidence_ref` (and, in a production profile, only `live` evidence from a
 * provider that is allowed in production); an unverified region is never in-Kingdom whatever its country says. Everything else (a country code, a
 * group name, a mock fixture id) falls back to the M04 mock registry unchanged.
 */
export class ProviderRegionRegistry implements RegionRegistry {
  constructor(
    private readonly db: Db,
    private readonly fallback: Pick<MockRegionRegistry, 'resolve' | 'group'>,
  ) {}

  group(country: string) {
    return this.fallback.group(country);
  }

  async resolve(targetRegion: string): Promise<RegionTarget> {
    const input = String(targetRegion ?? '').slice(0, 64);
    if (!UUID.test(input)) return this.fallback.resolve(input);
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT r.country_code, r.state, r.verified_at, r.evidence_ref, r.evidence_kind, p.environment_policy
               FROM cloud.provider_regions r JOIN cloud.provider_accounts a ON a.id = r.account_id JOIN cloud.providers p ON p.id = a.provider_id WHERE r.id = $1`,
            [input],
          )
        ).rows[0],
    );
    if (!row) return this.fallback.resolve(input);
    const prod = isProduction();
    const verified =
      row.state === 'verified' &&
      !!row.verified_at &&
      !!row.evidence_ref &&
      (!prod || row.evidence_kind === 'live') &&
      !(prod && row.environment_policy === 'non_production_only');
    const country = (row.country_code as string).trim();
    const g = this.group(country);
    return { input, country, group: verified ? g : g === 'in_kingdom' ? 'other' : g, verified };
  }
}
