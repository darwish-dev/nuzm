import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { RegistrarAdminService } from './internal/registrar-admin.service';

/** Registrar registry (admin console): accounts by vault reference, probe → capability matrix. Every change is audited. */
@RealmOnly('admin')
@Controller('v1/admin/registrars')
export class AdminRegistrarsController {
  constructor(private readonly admin: RegistrarAdminService) {}

  @RequirePlatformPermission('admin:domains:read')
  @Get()
  list() {
    return this.admin.list();
  }

  @RequirePlatformPermission('admin:domains:read')
  @StepUp()
  @Post()
  @HttpCode(201)
  create(@Platform() who: PlatformContext, @Body() body: Record<string, unknown> | undefined) {
    if (!who.permissions.has('admin:domains:manage'))
      throw new ProblemException('forbidden', 'permission admin:domains:manage is required');
    return this.admin.createAccount(who.userId, body ?? {});
  }

  /** DNet connection settings: one account, created on the first save. Credentials are write-only (sealed secret store, dev profile; vault reference otherwise). */
  @RequirePlatformPermission('admin:domains:read')
  @StepUp()
  @Put('dnet')
  @HttpCode(200)
  saveDnet(@Platform() who: PlatformContext, @Body() body: Record<string, unknown> | undefined) {
    if (!who.permissions.has('admin:domains:manage'))
      throw new ProblemException('forbidden', 'permission admin:domains:manage is required');
    return this.admin.saveDnetSettings(who.userId, body ?? {});
  }

  @RequirePlatformPermission('admin:domains:read')
  @StepUp()
  @Post(':id/verification')
  @HttpCode(200)
  verify(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
  ) {
    if (!who.permissions.has('admin:domains:manage'))
      throw new ProblemException('forbidden', 'permission admin:domains:manage is required');
    return this.admin.verify(who.userId, id, body ?? {}, String(req.id ?? 'verify'));
  }
}
