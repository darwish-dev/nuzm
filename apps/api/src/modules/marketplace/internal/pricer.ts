import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import type { PriceContext, PricerResult, QuotePricer } from '../../commerce';
import type { ResidencyService } from '../../compliance';
import { isUuid, type Row } from './model';

/**
 * The `marketplace` quote kind (docs/04 §2.2 already lists it). One item `{listingId, versionId?}`; the price is the listing's own price (a fixed commercial figure set by the publisher, in
 * the buyer's currency or no quote). Only a PUBLISHED listing with an APPROVED version can be quoted. VAT is estimated by the quote service as for every kind.
 */
export class MarketplacePricer implements QuotePricer {
  readonly kind = 'marketplace' as const;
  constructor(
    private readonly db: Db,
    private readonly residency: Pick<ResidencyService, 'evaluate'> | null,
    private readonly enabled: (orgId: string) => Promise<boolean>,
  ) {}

  async price(ctx: PriceContext, items: unknown[]): Promise<PricerResult> {
    if (!(await this.enabled(ctx.orgId)))
      throw new ProblemException(
        'feature_disabled',
        'the marketplace is not enabled for this organization',
      );
    if (items.length !== 1)
      throw new ProblemException(
        'validation_failed',
        'a marketplace quote has exactly one item: {listingId, versionId?}',
      );
    const i = items[0] as { listingId?: unknown; versionId?: unknown };
    if (!isUuid(i.listingId) || (i.versionId !== undefined && !isUuid(i.versionId)))
      throw new ProblemException('validation_failed', 'listingId (and versionId) must be uuids');
    const x = await this.db.withOrg(ctx.orgId, async (c) => {
      const l = (
        await c.query(`SELECT * FROM marketplace.listings WHERE id = $1 AND status = 'published'`, [
          i.listingId,
        ])
      ).rows[0] as Row | undefined;
      if (!l) return null;
      const v = (
        await c.query(
          i.versionId
            ? `SELECT * FROM marketplace.listing_versions WHERE id = $2 AND listing_id = $1 AND moderation_status = 'approved'`
            : `SELECT * FROM marketplace.listing_versions WHERE listing_id = $1 AND moderation_status = 'approved' ORDER BY created_at DESC LIMIT 1`,
          i.versionId ? [i.listingId, i.versionId] : [i.listingId],
        )
      ).rows[0] as Row | undefined;
      return v ? { l, v } : null;
    });
    if (!x)
      throw new ProblemException('not_purchasable', 'this listing or version cannot be purchased');
    if (x.l.org_id === ctx.orgId)
      throw new ProblemException('not_purchasable', 'a publisher cannot buy its own listing');
    if ((x.l.currency as string).trim() !== ctx.currency)
      throw new ProblemException(
        'kind_not_available',
        `this listing is priced in ${(x.l.currency as string).trim()}`,
      );
    let residency: Record<string, unknown> | undefined;
    if (this.residency) {
      const r = await this.residency.evaluate({
        orgId: ctx.orgId,
        dataClass: 'customer-content',
        targetRegion: x.l.data_region,
        purpose: 'marketplace.purchase',
        operation: 'read',
      });
      residency = {
        decision: r.decision,
        policyVersion: r.policyVersion,
        floorVersion: r.floorVersion,
        assessmentId: r.assessmentId,
        evidenceRef: r.evidenceRef,
      };
      if (r.decision === 'deny')
        throw new ProblemException(
          'residency_denied',
          'the listing is stored in a region this organization cannot use',
        );
    }
    const net = BigInt(x.l.price_minor);
    return {
      priceBookVersionId: null,
      residency,
      items: [
        {
          description: `Marketplace: ${x.l.title_en} v${x.v.version}`,
          meterId: null,
          meterGroup: null,
          quantity: '1',
          unit: 'licence',
          unitPriceMinor: net.toString(),
          amountMinor: net,
          details: {
            listingId: x.l.id,
            versionId: x.v.id,
            version: x.v.version,
            publisherId: x.l.publisher_id,
            licence: x.l.licence,
            seats: x.l.seats,
          },
        },
      ],
    };
  }
}
