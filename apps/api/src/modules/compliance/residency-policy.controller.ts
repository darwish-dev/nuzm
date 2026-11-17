import { Body, Controller, Get, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { ResidencyService } from './internal/residency/residency.service';

/** The organization's data residency policy (docs/04): any member reads, owners and admins change it; it can only tighten the platform floor. */
@Controller('v1/compliance/residency-policy')
export class ResidencyPolicyController {
  constructor(private readonly residency: ResidencyService) {}

  @RequirePermission('privacy:residency:read')
  @Get()
  async get(@Org() orgId: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const p = await this.residency.getPolicy(orgId);
    void reply.header('etag', etag(p.version));
    return p;
  }

  /** The first policy needs no precondition; replacing needs `If-Match` (428 without, 412 when stale). 422 `policy_below_floor` when it loosens the floor. */
  @RequirePermission('privacy:residency:manage')
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
      throw new ProblemException('validation_failed', "If-Match must be the policy's ETag");
    const p = await this.residency.putPolicy(orgId, a.actor.userId, body ?? {}, expected);
    void reply.header('etag', etag(p.version));
    return p;
  }
}
