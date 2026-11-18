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
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { Idempotent } from '../../common/idempotency';
import { DnsService } from './internal/dns.service';
import { DomainsFlags } from './internal/flags';

/** DNS zones and records (docs/04 §2.7). Hosted by the registrar adapter's DNS capability only. Feature-flagged (404 when off). */
@Controller('v1/dns/zones')
export class DnsController {
  constructor(
    private readonly flags: DomainsFlags,
    private readonly dns: DnsService,
  ) {}

  @RequirePermission('dns:read')
  @Get()
  async list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    await this.flags.assert(orgId);
    return this.dns.listZones(orgId, q);
  }

  @RequirePermission('dns:write')
  @Idempotent()
  @Post()
  @HttpCode(201)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    await this.flags.assert(orgId);
    return this.dns.createZone(orgId, a.actor.userId, body ?? {}, `zone-${Date.now()}`);
  }

  @RequirePermission('dns:read')
  @Get(':id')
  async get(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.flags.assert(orgId);
    const z = await this.dns.getZone(orgId, id);
    void reply.header('etag', etag(z.version));
    return z;
  }

  @RequirePermission('dns:read')
  @Get(':id/records')
  async records(
    @Org() orgId: string,
    @Param('id') id: string,
    @Query() q: { name?: string; type?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.flags.assert(orgId);
    const r = await this.dns.records(orgId, id, q);
    void reply.header('etag', etag(r.version));
    return r;
  }

  @RequirePermission('dns:write')
  @Patch(':id/records')
  async change(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.flags.assert(orgId);
    const r = await this.dns.applyChangeSet(
      orgId,
      a.actor.userId,
      id,
      parseIfMatch(ifMatch),
      body ?? {},
      { writer: 'user', traceId: `dns-${Date.now()}` },
    );
    void reply.header('etag', etag(r.version));
    return r;
  }
}
