import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Org, RequirePermission } from '../../common/access';
import { CurrentPrincipal, StepUp, type Principal } from '../identity';
import { ProblemException } from '../../common/errors';
import { EnterpriseFlags, SSO_FLAG } from './flags';
import { idemKey } from './idem';
import { SsoConnectionService } from './sso-connections.service';

/** POST/GET /v1/organizations/{orgId}/sso-connections (docs/04 §2.12). org:security; writes need a recent MFA. */
@Controller('v1/organizations/:orgId/sso-connections')
export class SsoConnectionsController {
  constructor(
    private readonly sso: SsoConnectionService,
    private readonly flags: EnterpriseFlags,
  ) {}

  /** The feature does not exist for an organization that does not have it (404, never 403). */
  private async gate(orgId: string) {
    if (!(await this.flags.enabled(orgId, SSO_FLAG))) throw new ProblemException('not_found');
  }

  @RequirePermission('org:security')
  @Get()
  async list(@Org() orgId: string) {
    await this.gate(orgId);
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
    await this.gate(orgId);
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
