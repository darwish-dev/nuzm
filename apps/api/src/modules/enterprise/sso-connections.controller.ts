import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Org, RequirePermission } from '../../common/access';
import { CurrentPrincipal, StepUp, type Principal } from '../identity';
import { idemKey } from './idem';
import { SsoConnectionService } from './sso-connections.service';

/** POST/GET /v1/organizations/{orgId}/sso-connections (docs/04 §2.12). org:security; writes need a recent MFA. */
@Controller('v1/organizations/:orgId/sso-connections')
export class SsoConnectionsController {
  constructor(private readonly sso: SsoConnectionService) {}

  @RequirePermission('org:security')
  @Get()
  list(@Org() orgId: string) {
    return this.sso.list(orgId);
  }

  @RequirePermission('org:security')
  @StepUp()
  @Post()
  async upsert(
    @Org() orgId: string,
    @CurrentPrincipal() p: Principal,
    @Body() b: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.sso.upsert(
      orgId,
      { userId: p.userId, ip: req.ip, traceId: req.traceId },
      idemKey(req),
      b ?? {},
    );
    void reply.status(r.created ? 201 : 200);
    return r.connection;
  }
}
