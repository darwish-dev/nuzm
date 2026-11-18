import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { DomainAdminReadService } from './internal/admin-read.service';
import { DomainReconcilerService } from './internal/reconciler.service';

/** Forced reconciliation of one domain (admin console): looks at the registrar, finishes parked orders, syncs the state. Audited. */
@RealmOnly('admin')
@Controller('v1/admin/domains')
export class AdminDomainsController {
  constructor(
    private readonly recon: DomainReconcilerService,
    private readonly read: DomainAdminReadService,
  ) {}

  @RequirePlatformPermission('admin:domains:read')
  @Get()
  list(
    @Query()
    q: {
      state?: string;
      needsReconcile?: string;
      q?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.read.list(q);
  }

  @RequirePlatformPermission('admin:domains:read')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.read.get(id);
  }

  @RequirePlatformPermission('admin:domains:read')
  @StepUp()
  @Post(':id/reconciliations')
  @HttpCode(202)
  force(@Platform() who: PlatformContext, @Param('id') id: string, @Req() req: FastifyRequest) {
    if (!who.permissions.has('admin:domains:manage'))
      throw new ProblemException('forbidden', 'permission admin:domains:manage is required');
    return this.recon.force(who.userId, id, String(req.id ?? 'reconcile'));
  }
}
