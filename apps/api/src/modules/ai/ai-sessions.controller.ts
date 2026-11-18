import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { AiEnabledGuard } from './internal/ai-enabled.guard';
import { SessionService } from './internal/session.service';

/** `POST/GET /v1/ai/sessions`, `GET/POST /v1/ai/sessions/{id}/messages` (docs/04 §2.9). */
@UseGuards(AiEnabledGuard)
@Controller('v1/ai/sessions')
export class AiSessionsController {
  constructor(private readonly sessions: SessionService) {}

  @RequirePermission('ai:write')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.sessions.create(orgId, a.actor.userId, body ?? {});
  }

  @RequirePermission('ai:read')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.sessions.list(orgId, { limit: parseLimit(q.limit), cursor: q.cursor });
  }

  @RequirePermission('ai:read')
  @Get(':id/messages')
  messages(
    @Org() orgId: string,
    @Param('id') id: string,
    @Query() q: { limit?: string; cursor?: string },
  ) {
    return this.sessions.messages(orgId, id.toLowerCase(), {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  /** 422 `content_blocked` (moderation), 422 `secret_detected` (nothing is stored in either case). */
  @RequirePermission('ai:write')
  @Idempotent()
  @Post(':id/messages')
  @HttpCode(201)
  addMessage(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.sessions.addMessage(orgId, a.actor.userId, id.toLowerCase(), body ?? {});
  }
}
