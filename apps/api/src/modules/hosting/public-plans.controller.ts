import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../identity';
import { PlansService } from './internal/plans.service';

/**
 * `GET /v1/public/hosting-plans`: the published hosting plans for the public website's plan sections. No sign-in, no organization: it carries only what the
 * owner published (limits and price), and a plan is "published" only when it is active and its price is not a placeholder. Off in production until
 * `PUBLIC_PLANS_ENABLED=true` (an empty list is answered while off), on by default elsewhere.
 */
@Controller('v1/public/hosting-plans')
export class PublicPlansController {
  constructor(private readonly plans: PlansService) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  async list() {
    const on =
      process.env.NODE_ENV === 'production'
        ? process.env.PUBLIC_PLANS_ENABLED === 'true'
        : process.env.PUBLIC_PLANS_ENABLED !== 'false';
    return { items: on ? await this.plans.listPublished() : [] };
  }
}
