import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { DunningService } from './internal/dunning.service';

/** Dunning cases for finance (docs/04): list, and manual hold / resume with a reason (audited). Billing never deletes or terminates anything. */
@RealmOnly('admin')
@Controller('v1/admin/billing/dunning')
export class AdminDunningController {
  constructor(private readonly dunning: DunningService) {}

  @RequirePlatformPermission('admin:billing:read')
  @Get()
  list(
    @Query() q: { limit?: string; cursor?: string; org?: string; stage?: string; state?: string },
  ) {
    return this.dunning.list({
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      orgId: q.org,
      stage: q.stage,
      state: q.state,
    });
  }

  @RequirePlatformPermission('admin:billing:read')
  @StepUp()
  @Patch(':id')
  patch(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    if (!who.permissions.has('admin:billing:manage'))
      throw new ProblemException('forbidden', 'permission admin:billing:manage is required');
    return this.dunning.setHold(who.userId, id, body ?? {});
  }
}
