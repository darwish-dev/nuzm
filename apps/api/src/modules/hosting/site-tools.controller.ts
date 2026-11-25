import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import { SiteToolsService } from './internal/tools/site-tools.service';

type Body_ = Record<string, unknown> | undefined;

/**
 * Website tools that run on the panel (HestiaCP S05): the capability report, scheduled jobs, logs, FTP accounts and password protection. Every route is org scoped (another
 * organization's site id is a 404), has its own permission, and answers from the panel the site's own account lives on. NOT VERIFIED against a real node.
 */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SiteToolsController {
  constructor(private readonly tools: SiteToolsService) {}

  @RequirePermission('hosting:site:read')
  @Get(':id/tools')
  capabilities(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    return this.tools.capabilities(orgId, id, a.permissions);
  }

  /* cron */
  @RequirePermission('hosting:cron:manage')
  @Get(':id/cron-jobs')
  listCron(@Org() orgId: string, @Param('id') id: string) {
    return this.tools.listCron(orgId, id);
  }
  @RequirePermission('hosting:cron:manage')
  @Idempotent()
  @Post(':id/cron-jobs')
  addCron(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.tools.addCron(orgId, a.actor.userId, id, body ?? {});
  }
  @RequirePermission('hosting:cron:manage')
  @Put(':id/cron-jobs/:job')
  changeCron(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('job') job: string,
    @Body() body: Body_,
  ) {
    return this.tools.changeCron(orgId, a.actor.userId, id, job, body ?? {});
  }
  @RequirePermission('hosting:cron:manage')
  @Delete(':id/cron-jobs/:job')
  @HttpCode(204)
  async deleteCron(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('job') job: string,
  ) {
    await this.tools.deleteCron(orgId, a.actor.userId, id, job);
  }

  /* logs */
  @RequirePermission('hosting:logs:read')
  @Get(':id/logs')
  logs(
    @Org() orgId: string,
    @Param('id') id: string,
    @Query('domain') domain?: string,
    @Query('kind') kind?: string,
    @Query('lines') lines?: string,
  ) {
    return this.tools.logs(orgId, id, { domain, kind, lines });
  }

  /* FTP */
  @RequirePermission('hosting:ftp:manage')
  @Get(':id/ftp-accounts')
  listFtp(@Org() orgId: string, @Param('id') id: string) {
    return this.tools.listFtp(orgId, id);
  }
  @RequirePermission('hosting:ftp:manage')
  @Idempotent()
  @Post(':id/ftp-accounts')
  addFtp(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.tools.addFtp(orgId, a.actor.userId, id, body ?? {});
  }
  @RequirePermission('hosting:ftp:manage')
  @Put(':id/ftp-accounts/:domain/:user/password')
  @HttpCode(204)
  async ftpPassword(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('domain') domain: string,
    @Param('user') user: string,
    @Body() body: Body_,
  ) {
    await this.tools.changeFtpPassword(
      orgId,
      a.actor.userId,
      id,
      domain,
      user,
      typeof body?.password === 'string' ? body.password : '',
    );
  }
  @RequirePermission('hosting:ftp:manage')
  @Delete(':id/ftp-accounts/:domain/:user')
  @HttpCode(204)
  async deleteFtp(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('domain') domain: string,
    @Param('user') user: string,
  ) {
    await this.tools.deleteFtp(orgId, a.actor.userId, id, domain, user);
  }

  /* password protection */
  @RequirePermission('hosting:protection:manage')
  @Get(':id/protection')
  listProtection(@Org() orgId: string, @Param('id') id: string) {
    return this.tools.listProtection(orgId, id);
  }
  @RequirePermission('hosting:protection:manage')
  @Idempotent()
  @Post(':id/protection')
  addProtection(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.tools.addProtection(orgId, a.actor.userId, id, body ?? {});
  }
  @RequirePermission('hosting:protection:manage')
  @Delete(':id/protection/:domain/:user')
  @HttpCode(204)
  async deleteProtection(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('domain') domain: string,
    @Param('user') user: string,
  ) {
    await this.tools.deleteProtection(orgId, a.actor.userId, id, domain, user);
  }
}
