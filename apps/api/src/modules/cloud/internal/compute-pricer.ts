import { assertResidency, ResidencyDenied } from '@nuzm/domain';
import type { ResidencyService } from '../../compliance';
import { ProblemException } from '../../../common/errors';
import type { PriceContext, PricedItem, PricerResult, QuotePricer } from '../../commerce';
import { UUID } from './common';
import { HOURS_PER_MONTH, type OfferPriceComposer } from './offer-price';
import type { OfferCandidate, OfferService } from './offer.service';
import type { RoutingService } from './routing.service';
import type { ImageCatalog } from './images';
import { parsePanelRequest, type HestiaTemplate } from './hestia-vps/policy';
import type { PanelInstallService } from './hestia-vps/panel-install.service';

export interface ComputeSpec {
  imageId: string;
  diskGb: number | null;
  count: number;
  /** the control panel choice of the purchase page (S04): none, or HestiaCP with an explicit template (mail on/off) */
  panel: { kind: 'none' } | { kind: 'hestia'; template: HestiaTemplate };
}
export interface ComputeQuoteRequest {
  offerId?: string;
  routing?: {
    mode: 'explicit' | 'automatic';
    country?: string;
    region?: string;
    geoGroup?: string;
    provider?: string;
  };
  spec: ComputeSpec;
  term: { period: 'month' };
}

export function parseComputeRequest(raw: unknown): ComputeQuoteRequest {
  const bad = (m: string) => new ProblemException('validation_failed', m);
  const r = raw as { offerId?: unknown; routing?: unknown; spec?: unknown; term?: unknown } | null;
  if (!r || typeof r !== 'object')
    throw bad('a compute quote needs {offerId | routing, spec, term}');
  if ((r.offerId === undefined) === (r.routing === undefined))
    throw bad('send exactly one of offerId or routing');
  const s = r.spec as
    { imageId?: unknown; diskGb?: unknown; count?: unknown; panel?: unknown } | undefined;
  if (!s || typeof s !== 'object') throw bad('spec is required');
  if (typeof s.imageId !== 'string' || !UUID.test(s.imageId))
    throw bad('spec.imageId must be an image id (UUID)');
  const count = s.count === undefined ? 1 : s.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10)
    throw bad('spec.count must be an integer 1..10');
  let diskGb: number | null = null;
  if (s.diskGb !== undefined) {
    if (
      typeof s.diskGb !== 'number' ||
      !Number.isInteger(s.diskGb) ||
      s.diskGb < 1 ||
      s.diskGb > 4096
    )
      throw bad('spec.diskGb must be an integer 1..4096');
    diskGb = s.diskGb;
  }
  const term = (r.term ?? { period: 'month' }) as { period?: unknown };
  if (term.period !== 'month') throw bad('term.period must be "month" (the only supported term)');
  const out: ComputeQuoteRequest = {
    spec: { imageId: s.imageId.toLowerCase(), diskGb, count, panel: parsePanelRequest(s.panel) },
    term: { period: 'month' },
  };
  if (r.offerId !== undefined) {
    if (typeof r.offerId !== 'string' || !UUID.test(r.offerId)) throw bad('offerId must be a UUID');
    out.offerId = r.offerId.toLowerCase();
  } else {
    const ro = r.routing as {
      mode?: unknown;
      country?: unknown;
      region?: unknown;
      geoGroup?: unknown;
      provider?: unknown;
    };
    if (!ro || (ro.mode !== 'explicit' && ro.mode !== 'automatic'))
      throw bad('routing.mode must be "explicit" or "automatic"');
    const rt: NonNullable<ComputeQuoteRequest['routing']> = { mode: ro.mode };
    for (const k of ['country', 'region', 'geoGroup', 'provider'] as const)
      if (ro[k] !== undefined) {
        if (typeof ro[k] !== 'string' || (ro[k] as string).length > 100)
          throw bad(`routing.${k} is invalid`);
        rt[k] = k === 'country' ? (ro[k] as string).toUpperCase() : (ro[k] as string);
      }
    if (rt.mode === 'explicit' && (!rt.provider || !rt.region))
      throw bad('explicit routing needs provider and region');
    if (rt.mode === 'automatic' && !rt.country && !rt.geoGroup)
      throw bad('automatic routing needs country or geoGroup');
    out.routing = rt;
  }
  return out;
}

/**
 * The compute pricer registered with the M02 quote mechanism (M05 task 8). Chooses the offer (explicit `offerId`, or routing over ELIGIBLE offers),
 * evaluates residency (M04 hook, mutation → audited, denial → 403 residency_denied), prices the plan from the price book, and returns the routing
 * decision as an internal preference. Provider identity never appears in the quote lines.
 */
const unsupportedPanel: Pick<PanelInstallService, 'planOrder'> = {
  planOrder: () =>
    Promise.reject(
      new ProblemException('unsupported_capability', 'a VPS with HestiaCP is not available'),
    ),
};

export class ComputeQuotePricer implements QuotePricer {
  readonly kind = 'compute' as const;
  constructor(
    private readonly offers: Pick<OfferService, 'eligible'>,
    private readonly routing: Pick<RoutingService, 'decide'>,
    private readonly images: Pick<ImageCatalog, 'findImage'>,
    private readonly composer: OfferPriceComposer,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly panel?: Pick<PanelInstallService, 'planOrder'>,
  ) {}

  itemsFrom(input: Record<string, unknown>): unknown[] {
    return [{ offerId: input.offerId, routing: input.routing, spec: input.spec, term: input.term }];
  }

  async price(ctx: PriceContext, items: unknown[]): Promise<PricerResult> {
    if (items.length !== 1)
      throw new ProblemException('validation_failed', 'a compute quote prices exactly one request');
    const req = parseComputeRequest(items[0]);
    const eligible = await this.offers.eligible(ctx.orgId);
    let chosen: OfferCandidate | null;
    let decision: unknown;
    if (req.offerId) {
      chosen = eligible.find((c) => c.offerId === req.offerId) ?? null;
      decision = { mode: 'offer', chosenOfferId: req.offerId };
    } else {
      const d = await this.routing.decide(eligible, req.routing!);
      chosen = d.chosen;
      decision = d.decision;
    }
    if (!chosen)
      throw new ProblemException(
        'no_eligible_offer',
        'no verified, available offer matches the request',
      );
    const image = await this.images.findImage(
      req.spec.imageId,
      chosen.accountId,
      chosen.providerRegionId,
    );
    if (!image)
      throw new ProblemException(
        'validation_failed',
        'the image is not available for the selected offer',
      );
    const diskGb = Math.max(req.spec.diskGb ?? chosen.diskGb, chosen.diskGb);
    const spec = { vcpu: chosen.vcpu, memoryMb: chosen.memoryMb, diskGb };
    if (req.spec.count > 1 && req.spec.panel.kind === 'hestia')
      throw new ProblemException(
        'validation_failed',
        'a VPS with HestiaCP is ordered one server at a time',
      );
    // S04: the panel choice is validated against the chosen placement and image and stored as part of the order snapshot.
    const panel =
      req.spec.panel.kind === 'hestia'
        ? await (this.panel ?? unsupportedPanel).planOrder(
            ctx.orgId,
            req.spec.panel.template,
            {
              accountId: chosen.accountId,
              providerKey: chosen.providerKey,
              providerRegionId: chosen.providerRegionId,
              planRef: chosen.planRef,
              ...spec,
            },
            { imageRef: image.imageRef, name: image.name },
          )
        : null;
    // Residency at the quote (class customer-content): audited decision; a denial is a hard stop, not a hidden offer.
    let verdict;
    try {
      verdict = await assertResidency(this.residency, {
        orgId: ctx.orgId,
        dataClass: 'customer-content',
        targetRegion: chosen.regionRowId,
        purpose: 'compute.quote',
        processorId: chosen.providerKey,
        operation: 'write',
      });
    } catch (e) {
      if (e instanceof ResidencyDenied)
        throw new ProblemException(
          'residency_denied',
          e.result.reasons.map((r) => r.message.en).join(' ') ||
            'the residency policy denies this placement',
          undefined,
          {
            reasons: e.result.reasons.map((r) => ({
              code: r.code,
              en: r.message.en,
              ar: r.message.ar,
            })),
          },
        );
      throw e;
    }
    const price = (await this.composer.session(ctx.orgId, ctx.now))(spec, req.spec.count);
    if (!price)
      throw new ProblemException('no_eligible_offer', 'no price is available for this offer');
    const lines: PricedItem[] = price.lines.map((l) => ({
      description: l.description,
      meterId: l.meterId,
      meterGroup: l.meterGroup,
      quantity: l.quantity,
      unit: l.unit,
      unitPriceMinor: l.unitPriceMinor,
      amountMinor: l.amountMinor,
      details: { kind: 'compute', hoursPerMonth: HOURS_PER_MONTH },
    }));
    return {
      items: lines,
      priceBookVersionId: price.priceBookVersionId,
      residency: {
        decision: verdict.decision,
        policyVersion: verdict.policyVersion,
        floorVersion: verdict.floorVersion,
        evidenceRef: verdict.evidenceRef,
        dataRegion: chosen.geoGroup,
        evaluatedAt: ctx.now.toISOString(),
      },
      preferences: {
        compute: {
          offerId: chosen.offerId,
          accountId: chosen.accountId,
          providerKey: chosen.providerKey,
          regionRowId: chosen.regionRowId,
          providerRegionId: chosen.providerRegionId,
          country: chosen.country,
          dataRegion: chosen.geoGroup,
          planRef: chosen.planRef,
          plan: spec,
          imageId: req.spec.imageId,
          imageRef: image.imageRef,
          imageName: image.name,
          ...(panel ? { panel } : {}),
          count: req.spec.count,
          term: req.term,
          providerPrice: chosen.providerPrice,
          priceBookVersionId: price.priceBookVersionId,
          routing: decision,
        },
      },
    };
  }
}
