import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { AgencyService } from './internal/agency.service';
import { ResellerService } from './internal/reseller.service';
import { StatementService } from './internal/statement.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/**
 * Agency program (docs/04 §2.11). The org-level permission on the route is the floor (`org:read`: any member); each handler then enforces the side-specific permission
 * (`agency:manage` for the agency's own organization, `partners:manage` for the client answering). Revocation routes are SCR-M11-01 and do NOT exist.
 */
@Controller('v1/agencies')
export class AgenciesController {
  constructor(private readonly agencies: AgencyService) {}
  @RequirePermission('agency:manage')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.agencies.create(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('org:read')
  @Get()
  list(@Org() orgId: string) {
    return this.agencies.list(orgId);
  }
  @RequirePermission('org:read')
  @Idempotent()
  @Post(':id/clients')
  @HttpCode(201)
  postClient(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string, @Body() body: Body_) {
    return this.agencies.postClient(orgId, a.actor.userId, a.permissions, id, b(body));
  }
  @RequirePermission('org:read')
  @Get(':id/clients')
  listClients(@Org() orgId: string, @Param('id') id: string) {
    return this.agencies.listClients(orgId, id);
  }
  @RequirePermission('org:read')
  @Idempotent()
  @Post(':id/delegated-access')
  @HttpCode(201)
  postGrant(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string, @Body() body: Body_) {
    return this.agencies.postGrant(orgId, a.actor.userId, a.permissions, id, b(body));
  }
  @RequirePermission('org:read')
  @Get(':id/delegated-access')
  listGrants(@Org() orgId: string, @Param('id') id: string) {
    return this.agencies.listGrants(orgId, id);
  }
}

/** Reseller program (docs/04 §2.11). */
@Controller('v1/resellers')
export class ResellersController {
  constructor(
    private readonly resellers: ResellerService,
    private readonly statements: StatementService,
  ) {}
  @RequirePermission('reseller:manage')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.resellers.create(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('org:read')
  @Get()
  list(@Org() orgId: string) {
    return this.resellers.list(orgId);
  }
  @RequirePermission('org:read')
  @Idempotent()
  @Post(':id/sub-organizations')
  @HttpCode(201)
  postSub(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string, @Body() body: Body_) {
    return this.resellers.postSubOrg(orgId, a.actor.userId, a.permissions, id, b(body));
  }
  @RequirePermission('org:read')
  @Get(':id/sub-organizations')
  listSubs(@Org() orgId: string, @Param('id') id: string) {
    return this.resellers.listSubOrgs(orgId, id);
  }
  @RequirePermission('reseller:pricing')
  @Get(':id/price-rules')
  async rules(@Org() orgId: string, @Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const r = await this.resellers.rules(orgId, id);
    void reply.header('etag', etag(r.version));
    return r;
  }
  @RequirePermission('reseller:pricing')
  @Put(':id/price-rules')
  async putRules(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string, @Body() body: Body_, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const m = parseIfMatch(req.headers['if-match']);
    if (m === null) throw new ProblemException('precondition_required', 'send the current rule-set version in If-Match');
    const r = await this.resellers.putRules(orgId, a.actor.userId, a.permissions, id, m, b(body));
    void reply.header('etag', etag(r.version));
    return r;
  }
  /** `?period=YYYY-MM` (default: the previous month); `?format=csv` returns text/csv. */
  @RequirePermission('reseller:finance')
  @Get(':id/statements')
  @Header('cache-control', 'no-store')
  async statement(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string, @Query() q: { period?: string; format?: string }, @Res({ passthrough: true }) reply: FastifyReply) {
    const s = await this.statements.statement(orgId, a.actor.userId, a.permissions, id.toLowerCase(), q.period);
    if (q.format === 'csv') {
      void reply.header('content-type', 'text/csv; charset=utf-8');
      void reply.header('content-disposition', `attachment; filename="statement-${s.period}.csv"`);
      return this.statements.toCsv(s);
    }
    return s;
  }
}
