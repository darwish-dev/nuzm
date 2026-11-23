import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { CatalogService } from './internal/catalog.service';
import { ProviderAccountService } from './internal/account.service';

/**
 * Provider accounts, their capability matrix, regions, plans and platform jobs (verification, catalog sync).
 * Bodies carry vault REFERENCES only (`credentialRef: "vault://…"`); credential values are rejected (422 credential_value_rejected).
 */
@RealmOnly('admin')
@Controller('v1/admin/provider-accounts')
export class AdminProviderAccountsController {
  constructor(
    private readonly accounts: ProviderAccountService,
    private readonly jobs: CatalogService,
  ) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get()
  async list(@Query('providerId') providerId?: string) {
    return { items: await this.accounts.list(providerId) };
  }

  @RequirePlatformPermission('admin:provider:manage')
  @Post()
  @HttpCode(201)
  create(@Platform() who: PlatformContext, @Body() body: unknown) {
    return this.accounts.create(who.userId, body);
  }

  /** Connect with credentials typed in the console (write-only; sealed store, non-production). Needs a recent MFA check. */
  @RequirePlatformPermission('admin:provider:manage')
  @StepUp()
  @Post('connect')
  @HttpCode(201)
  connect(@Platform() who: PlatformContext, @Body() body: unknown) {
    return this.accounts.connect(who.userId, body);
  }

  /** Replace an account's credentials (rotation). Needs a recent MFA check; the account must be verified again. */
  @RequirePlatformPermission('admin:provider:manage')
  @StepUp()
  @Put(':id/credentials')
  setCredentials(@Platform() who: PlatformContext, @Param('id') id: string, @Body() body: unknown) {
    return this.accounts.setCredentials(who.userId, id, body);
  }

  @RequirePlatformPermission('admin:provider:read')
  @Get(':id')
  async get(@Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const a = await this.accounts.get(id);
    void reply.header('etag', etag(a.version));
    return a;
  }

  @RequirePlatformPermission('admin:provider:manage')
  @Patch(':id')
  async update(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const a = await this.accounts.update(who.userId, id, parseIfMatch(ifMatch), body);
    void reply.header('etag', etag(a.version));
    return a;
  }

  /** 202: a platform job probes capabilities, lists regions (with evidence) and plans, and records health. Poll GET /v1/admin/provider-jobs/{id}. */
  @RequirePlatformPermission('admin:provider:manage')
  @Post(':id/verification')
  @HttpCode(202)
  async verify(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: FastifyRequest,
  ) {
    const job = await this.accounts.startJob(who.userId, id, 'verification', key, req.traceId);
    if (job.state === 'pending') this.jobs.kick(job.id);
    return { operationId: job.id, job };
  }

  @RequirePlatformPermission('admin:provider:read')
  @Get(':id/capabilities')
  capabilities(@Param('id') id: string) {
    return this.accounts.capabilities(id);
  }

  @RequirePlatformPermission('admin:provider:manage')
  @Post(':id/catalog-syncs')
  @HttpCode(202)
  async sync(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: FastifyRequest,
  ) {
    const job = await this.accounts.startJob(who.userId, id, 'catalog_sync', key, req.traceId);
    if (job.state === 'pending') this.jobs.kick(job.id);
    return { operationId: job.id, job };
  }

  @RequirePlatformPermission('admin:provider:read')
  @Get(':id/regions')
  regions(@Param('id') id: string) {
    return this.accounts.regions(id);
  }

  @RequirePlatformPermission('admin:provider:read')
  @Get(':id/plans')
  plans(@Param('id') id: string, @Query('region') region?: string) {
    if (region !== undefined && (typeof region !== 'string' || region.length > 100))
      throw new ProblemException('invalid_filter', 'region must be a provider region id');
    return this.accounts.plans(id, region);
  }
}
