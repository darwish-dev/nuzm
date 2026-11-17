import type { Db } from '@nuzm/platform';
import type { FieldCipher } from '../../../common/field-crypto';
import { openProfile } from './tax-profile.store';
import {
  computeTax,
  resolveRate,
  type BuyerType,
  type RoundingMode,
  type TaxRate,
  type TaxScope,
} from './tax-engine';

export interface TaxEstimate {
  status: 'computed';
  rateCode: string;
  rateBps: number;
  scope: TaxScope;
  taxMinor: bigint;
  perLineTaxMinor: bigint[];
  /** true when the case is not covered by advisor-approved configuration (unknown scope, foreign buyer, ...). */
  reviewRequired: boolean;
  reasons: string[];
  source: 'tax_rates';
}

/** Tax for a set of net amounts: buyer classification from the tax profile, the rate in force from `invoicing.tax_rates`. */
export class TaxService {
  constructor(
    private readonly db: Db,
    private readonly rounding: RoundingMode = 'half_up',
    /** Baseline scope of the platform's own services (`TAX_DEFAULT_SCOPE`, default `domestic`: services supplied in the Kingdom). null = unconfigured, every estimate is flagged. [VERIFY HG-03-04] */
    private readonly defaultScope: TaxScope | null = 'domestic',
    /** Opens a sealed tax profile (M04 S13d). */
    private readonly cipher?: FieldCipher,
  ) {}

  static defaultScopeFromEnv(env: NodeJS.ProcessEnv = process.env): TaxScope | null {
    const v = env.TAX_DEFAULT_SCOPE;
    if (v === undefined) return 'domestic';
    return v === 'domestic' || v === 'export' || v === 'exempt' || v === 'zero' ? v : null;
  }

  static roundingFromEnv(env: NodeJS.ProcessEnv = process.env): RoundingMode {
    return env.TAX_ROUNDING === 'half_even' ? 'half_even' : 'half_up';
  }

  async estimate(
    orgId: string,
    netMinor: readonly bigint[],
    on: Date = new Date(),
    scope: TaxScope | null | undefined = undefined,
  ): Promise<TaxEstimate> {
    const { profile, rates } = await this.db.withOrg(orgId, async (c) => ({
      profile: (
        await c.query<Record<string, unknown>>(
          `SELECT org_id, buyer_type, address, pii_enc FROM invoicing.tax_profiles WHERE org_id = $1`,
          [orgId],
        )
      ).rows[0],
      rates: (
        await c.query<{
          code: string;
          rate_bps: number;
          scope: TaxScope;
          jurisdiction: string;
          valid_from: string;
          valid_to: string | null;
          verify: boolean;
        }>(
          `SELECT code, rate_bps, scope, jurisdiction, valid_from::text, valid_to::text, verify FROM invoicing.tax_rates`,
        )
      ).rows.map((r): TaxRate => ({
        code: r.code,
        rateBps: r.rate_bps,
        scope: r.scope,
        jurisdiction: r.jurisdiction,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        verify: r.verify,
      })),
    }));
    const res = resolveRate(rates, {
      on,
      buyerType: (profile?.buyer_type as BuyerType | undefined) ?? 'b2c',
      buyerCountry: profile
        ? ((await openProfile(this.cipher, profile)).address.country ?? null)
        : null,
      scope: scope === undefined ? this.defaultScope : scope,
    });
    const t = computeTax(netMinor, res.rate.rateBps, this.rounding);
    return {
      status: 'computed',
      rateCode: res.rate.code,
      rateBps: res.rate.rateBps,
      scope: res.rate.scope,
      taxMinor: t.taxMinor,
      perLineTaxMinor: t.lines.map((l) => l.taxMinor),
      reviewRequired: res.reviewRequired,
      reasons: res.reasons,
      source: 'tax_rates',
    };
  }
}
