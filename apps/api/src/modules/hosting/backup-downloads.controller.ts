import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Org, RequirePermission } from '../../common/access';
import { BackupService } from './internal/backups.service';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';

/** The link target: needs the session of the SAME organization AND a valid, unexpired token. */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/backup-downloads')
export class BackupDownloadsController {
  constructor(private readonly backups: BackupService) {}
  @RequirePermission('hosting:backup:read')
  @Get()
  @Header('content-type', 'application/octet-stream')
  async get(
    @Org() orgId: string,
    @Query('token') token: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.backups.download(orgId, token ?? '');
    void reply.header('x-nuzm-checksum-sha256', r.checksum);
    void reply.header('content-disposition', `attachment; filename="backup-${r.id}.enc"`);
    return r.data;
  }
}
