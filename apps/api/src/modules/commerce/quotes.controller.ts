import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { QuoteService } from './internal/quote.service';
import { UUID } from '@nuzm/domain';

/** One quote endpoint for every kind (docs/04). Quotes are immutable once issued. */
@Controller('v1/quotes')
export class QuotesController {
  constructor(private readonly quotes: QuoteService) {}

  @RequirePermission('quote:create')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    // Kind-specific permission (docs/04 §2.5): compute quotes need `compute:quote:create` on top of the generic `quote:create`.
    if (body?.kind === 'compute' && !a.permissions.has('compute:quote:create'))
      throw new ProblemException(
        'forbidden',
        'compute quotes need the compute:quote:create permission',
      );
    return this.quotes.create(orgId, a.actor.userId, body ?? {});
  }

  @RequirePermission('quote:read')
  @Get(':id')
  get(@Org() orgId: string, @Param('id') id: string) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    return this.quotes.get(orgId, id.toLowerCase());
  }
}
