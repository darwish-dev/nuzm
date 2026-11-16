import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { NotificationService } from './internal/notification.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A user's own notifications in the active organization. Session callers only (never API keys). */
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationService) {}

  private userOf(a: AccessContext): string {
    if (a.actor.kind !== 'session') throw new ProblemException('unauthenticated'); // user sessions only
    return a.actor.userId;
  }

  @RequirePermission('org:read')
  @Get()
  list(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Query() q: { unread?: string; limit?: string; cursor?: string },
  ) {
    return this.svc.list(orgId, this.userOf(a), {
      unreadOnly: q.unread === 'true',
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  @RequirePermission('org:read')
  @Patch(':id')
  async markRead(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: { read?: unknown } | undefined,
  ) {
    const user = this.userOf(a);
    if (typeof body?.read !== 'boolean')
      throw new ProblemException('validation_failed', 'read must be a boolean');
    if (!UUID.test(id)) throw new ProblemException('not_found');
    return this.svc.setRead(orgId, user, id.toLowerCase(), body.read);
  }
}
