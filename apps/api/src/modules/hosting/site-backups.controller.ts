import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { BackupService } from './internal/backups.service';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import { UsageService } from './internal/usage.service';

/** Backups, restores, usage and expiring download links of a site. Another organization's backup id or link is 404. */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SiteBackupsController {
  constructor(
    private readonly backups: BackupService,
    private readonly usage: UsageService,
  ) {}

  @RequirePermission('hosting:backup:create')
  @Idempotent()
  @Post(':id/backups')
  @HttpCode(202)
  create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.backups.request(orgId, { userId: a.actor.userId }, id, body ?? {});
  }

  @RequirePermission('hosting:backup:read')
  @Get(':id/backups')
  list(@Org() orgId: string, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.backups.list(orgId, id, parseLimit(limit));
  }

  /** An expiring, signed, organization-bound link to the (encrypted) archive. */
  @RequirePermission('hosting:backup:read')
  @Idempotent()
  @Post(':id/backups/:backupId/download-links')
  @HttpCode(201)
  link(@Org() orgId: string, @Param('id') id: string, @Param('backupId') backupId: string) {
    return this.backups.downloadLink(orgId, id, backupId);
  }

  @RequirePermission('hosting:backup:restore')
  @Idempotent()
  @Post(':id/restores')
  @HttpCode(202)
  restore(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.backups.requestRestore(orgId, { userId: a.actor.userId }, id, body ?? {});
  }

  @RequirePermission('hosting:site:read')
  @Get(':id/usage')
  usageOf(@Org() orgId: string, @Param('id') id: string) {
    return this.usage.read(orgId, id);
  }
}
