import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { etag, parseIfMatch } from '../../common/etag';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { SitesService } from './internal/sites.service';

/** Hosting sites (docs/04 §2.6). Another organization's id is 404; the node is never part of a customer response. */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @RequirePermission('hosting:site:create')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.sites.create(orgId, { userId: a.actor.userId }, body ?? {});
    void reply.header('etag', etag(r.site.version));
    return { site: r.site, operationId: r.operationId };
  }

  @RequirePermission('hosting:site:read')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string; status?: string }) {
    return this.sites.list(orgId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      status: q.status,
    });
  }

  @RequirePermission('hosting:site:read')
  @Get(':id')
  async get(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const s = await this.sites.get(orgId, id);
    void reply.header('etag', etag(s.version));
    return s;
  }

  @RequirePermission('hosting:site:update')
  @Patch(':id')
  async patch(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const v = parseIfMatch(req.headers['if-match']);
    if (v === null)
      throw new ProblemException('precondition_required', 'Send If-Match with the site version');
    const s = await this.sites.patch(orgId, { userId: a.actor.userId }, id, v, body ?? {});
    void reply.header('etag', etag(s.version));
    return s;
  }

  /** Needs the header `X-Confirm-Delete: <siteName>`; starts the offboarding operation (export window, then a verified wipe). */
  @RequirePermission('hosting:site:delete')
  @Delete(':id')
  @HttpCode(202)
  async remove(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Req() req: FastifyRequest,
  ) {
    const c = req.headers['x-confirm-delete'];
    return this.sites.requestDelete(
      orgId,
      { userId: a.actor.userId },
      id,
      typeof c === 'string' ? c : undefined,
    );
  }
}
