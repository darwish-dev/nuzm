import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { PriceBookService } from './internal/price-book.service';
import { UUID } from '@nuzm/domain';

/** Price books (docs/04: GET/POST /v1/admin/billing/price-books · POST …/{id}/versions). */
@RealmOnly('admin')
@Controller('v1/admin/billing/price-books')
export class AdminPriceBooksController {
  constructor(private readonly books: PriceBookService) {}

  @RequirePlatformPermission('admin:billing:read')
  @Get()
  list(@Query() q: { limit?: string; cursor?: string }) {
    return this.books.list({ limit: parseLimit(q.limit), cursor: q.cursor });
  }

  @RequirePlatformPermission('admin:billing:manage')
  @Post()
  @HttpCode(201)
  create(@Platform() who: PlatformContext, @Body() body: Record<string, unknown> | undefined) {
    return this.books.createBook(body ?? {}, who.userId);
  }

  /**
   * `{effectiveFrom, items[], note?}` creates a DRAFT version (needs `admin:billing:manage`: finance);
   * `{publishVersionId}` publishes one (needs `admin:billing:publish`: platform_admin, a different person than the creator).
   */
  @RequirePlatformPermission('admin:billing:read')
  @StepUp()
  @Post(':id/versions')
  @HttpCode(201)
  version(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const b = body ?? {};
    if (b.publishVersionId !== undefined) {
      if (!who.permissions.has('admin:billing:publish')) throw new ProblemException('forbidden');
      if (typeof b.publishVersionId !== 'string' || !UUID.test(b.publishVersionId))
        throw new ProblemException('validation_failed', 'publishVersionId must be a UUID');
      return this.books.publish(id.toLowerCase(), b.publishVersionId.toLowerCase(), who.userId);
    }
    if (!who.permissions.has('admin:billing:manage')) throw new ProblemException('forbidden');
    return this.books.createVersion(id.toLowerCase(), b, who.userId);
  }
}
