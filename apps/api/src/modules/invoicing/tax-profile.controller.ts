import { Body, Controller, Get, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { TaxProfileService } from './internal/tax-profile.service';

/** The organization's tax profile (docs/04 `GET/PUT /v1/billing/tax-profile`). */
@Controller('v1/billing/tax-profile')
export class TaxProfileController {
  constructor(private readonly profiles: TaxProfileService) {}

  @RequirePermission('billing:read')
  @Get()
  async get(@Org() orgId: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const p = await this.profiles.get(orgId);
    void reply.header('etag', etag(p.version));
    return p;
  }

  /** Creating needs no precondition; replacing needs `If-Match` (428 without, 412 when stale). */
  @RequirePermission('billing:manage')
  @Put()
  async put(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = req.headers['if-match'];
    const expected = parseIfMatch(raw);
    if (raw !== undefined && expected === null)
      throw new ProblemException('validation_failed', "If-Match must be the profile's ETag");
    const p = await this.profiles.put(orgId, a.actor.userId, body ?? {}, expected);
    void reply.header('etag', etag(p.version));
    return p;
  }
}
