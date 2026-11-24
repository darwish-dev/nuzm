import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../identity';
import { OfferService } from './internal/offer.service';

/**
 * `GET /v1/public/compute-plans`: the server sizes the public website shows on the VPS and cloud-server pages. It is the eligible-offer list without any
 * organization: a size appears only when a healthy account, a verified region (with acceptable evidence for the environment), an available plan and a Nuzm price
 * all exist, priced from the same price book as `/v1/offers` (the placeholder book is refused in production). Residency, entitlement and quota are decided when
 * an organization orders. No provider identity or provider cost is returned. Off in production until `PUBLIC_PLANS_ENABLED=true`.
 */
@Controller('v1/public/compute-plans')
export class PublicComputePlansController {
  constructor(private readonly offers: OfferService) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  async list() {
    const on =
      process.env.NODE_ENV === 'production'
        ? process.env.PUBLIC_PLANS_ENABLED === 'true'
        : process.env.PUBLIC_PLANS_ENABLED !== 'false';
    return { items: on ? await this.offers.publicPlans().catch(() => []) : [] };
  }
}
