import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { DomainReconcilerService } from './internal/reconciler.service';

/** Forced reconciliation of one domain (admin console): looks at the registrar, finishes parked orders, syncs the state. Audited. */
@RealmOnly('admin')
@Controller('v1/admin/domains')
export class AdminDomainsController {
  constructor(private readonly recon: DomainReconcilerService) {}

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
