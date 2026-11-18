import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ProblemException } from '../../common/errors';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { Idempotent } from '../../common/idempotency';
import { DomainService } from './internal/domain.service';
import { DomainsFlags } from './internal/flags';
import { DomainOrderService } from './internal/orders.service';
import { TransferService } from './internal/transfer.service';
import { DnsLinkageService } from './internal/linkage.service';

/** Domains (docs/04 §2.7): orders from a quote, list, read, change, renew, eligibility, transfers. Everything is feature-flagged (404 when off). */
@Controller('v1/domains')
export class DomainsController {
  constructor(
    private readonly flags: DomainsFlags,
    private readonly domains: DomainService,
    private readonly orders: DomainOrderService,
    private readonly transfers: TransferService,
    private readonly linkage: DnsLinkageService,
  ) {}

  @RequirePermission('domain:write')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async order(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    await this.flags.assert(orgId);
    return this.orders.createRegistration(orgId, a.actor.userId, body ?? {}, `order-${Date.now()}`);
  }

  @RequirePermission('domain:read')
  @Get()
  async list(
    @Org() orgId: string,
    @Query() q: { state?: string; q?: string; limit?: string; cursor?: string },
  ) {
    await this.flags.assert(orgId);
    return this.domains.list(orgId, q);
  }

  @RequirePermission('domain:write')
  @Idempotent()
  @Post('transfers')
  @HttpCode(202)
  async transfer(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    await this.flags.assert(orgId);
    return this.orders.createTransfer(orgId, a.actor.userId, body ?? {}, `transfer-${Date.now()}`);
  }

  @RequirePermission('domain:read')
  @Get('transfers')
  async listTransfers(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    await this.flags.assert(orgId);
    return this.transfers.list(orgId, q);
  }

  @RequirePermission('domain:read')
  @Get(':id')
  async get(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.flags.assert(orgId);
    const d = await this.domains.get(orgId, id, a.permissions.has('domain:write'));
    void reply.header('etag', etag(d.version));
    return d;
  }

  @RequirePermission('domain:write')
  @Patch(':id')
  async patch(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.flags.assert(orgId);
    const r = await this.domains.patch(
      orgId,
      a.actor.userId,
      id,
      parseIfMatch(ifMatch),
      body ?? {},
      `patch-${Date.now()}`,
    );
    void reply.status(r.status).header('etag', etag(r.domain.version));
    return r.operationId ? { ...r.domain, operationId: r.operationId } : r.domain;
  }

  @RequirePermission('domain:renew')
  @Idempotent()
  @Post(':id/renewals')
  @HttpCode(202)
  async renew(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    await this.flags.assert(orgId);
    return this.orders.createRenewal(orgId, a.actor.userId, id, body ?? {}, `renew-${Date.now()}`);
  }

  @RequirePermission('domain:read')
  @Get(':id/eligibility')
  async eligibility(@Org() orgId: string, @Param('id') id: string) {
    await this.flags.assert(orgId);
    return this.domains.eligibilityOf(orgId, id);
  }

  /** Preview (apply false/absent) or apply the DNS records that link this domain to a hosting site (DnsLinkagePort). */
  @RequirePermission('domain:write')
  @Idempotent()
  @Post(':id/hosting-links')
  @HttpCode(200)
  async link(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    await this.flags.assert(orgId);
    await this.domains.get(orgId, id, false); // 404 for a domain that is not yours, before the body is judged
    const siteId = body?.siteId;
    if (typeof siteId !== 'string')
      throw new ProblemException('validation_failed', 'siteId is required');
    if (body?.apply === true) return this.linkage.applyLinkage(orgId, siteId, id, a.actor.userId);
    return {
      outcome: 'preview',
      proposal: await this.linkage.proposeRecordsForSite(orgId, siteId, id),
    };
  }

  @RequirePermission('domain:read')
  @Get(':id/hosting-links')
  async links(@Org() orgId: string, @Param('id') id: string) {
    await this.flags.assert(orgId);
    return this.linkage.current(orgId, id);
  }
}
