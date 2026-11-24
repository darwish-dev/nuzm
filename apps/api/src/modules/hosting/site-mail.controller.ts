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
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import { MailService } from './internal/tools/mail.service';

type Body_ = Record<string, unknown> | undefined;

/** Business email of a website within the plan's mailbox quota. Records are only read (never written) by the DNS checks. NOT VERIFIED against a real node. */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SiteMailController {
  constructor(private readonly mail: MailService) {}

  @RequirePermission('hosting:mail:read')
  @Get(':id/mail')
  overview(@Org() orgId: string, @Param('id') id: string) {
    return this.mail.overview(orgId, id);
  }

  @RequirePermission('hosting:mail:read')
  @Get(':id/mail/dns-checks')
  dns(@Org() orgId: string, @Param('id') id: string, @Query('domain') domain?: string) {
    if (!domain) throw new ProblemException('validation_failed', 'domain is required');
    return this.mail.dnsCheck(orgId, id, domain);
  }

  @RequirePermission('hosting:mail:manage')
  @Idempotent()
  @Post(':id/mail/domains')
  enable(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.mail.enableDomain(orgId, a.actor.userId, id, body ?? {});
  }

  @RequirePermission('hosting:mail:manage')
  @Idempotent()
  @Post(':id/mail/mailboxes')
  create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.mail.createMailbox(orgId, a.actor.userId, id, body ?? {});
  }

  @RequirePermission('hosting:mail:manage')
  @Put(':id/mail/mailboxes/:domain/:name/password')
  @HttpCode(204)
  async password(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('domain') domain: string,
    @Param('name') name: string,
    @Body() body: Body_,
  ) {
    await this.mail.changePassword(orgId, a.actor.userId, id, domain, name, body ?? {});
  }

  @RequirePermission('hosting:mail:manage')
  @Put(':id/mail/mailboxes/:domain/:name/quota')
  quota(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('domain') domain: string,
    @Param('name') name: string,
    @Body() body: Body_,
  ) {
    return this.mail.changeQuota(orgId, a.actor.userId, id, domain, name, body ?? {});
  }

  @RequirePermission('hosting:mail:manage')
  @Delete(':id/mail/mailboxes/:domain/:name')
  @HttpCode(204)
  async remove(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('domain') domain: string,
    @Param('name') name: string,
  ) {
    await this.mail.deleteMailbox(orgId, a.actor.userId, id, domain, name);
  }

  @RequirePermission('hosting:mail:manage')
  @Idempotent()
  @Post(':id/mail/mailboxes/:domain/:name/aliases')
  addAlias(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('domain') domain: string,
    @Param('name') name: string,
    @Body() body: Body_,
  ) {
    return this.mail.addAlias(orgId, a.actor.userId, id, domain, name, body ?? {});
  }

  @RequirePermission('hosting:mail:manage')
  @Delete(':id/mail/mailboxes/:domain/:name/aliases/:alias')
  @HttpCode(204)
  async removeAlias(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Param('domain') domain: string,
    @Param('name') name: string,
    @Param('alias') alias: string,
  ) {
    await this.mail.deleteAlias(orgId, a.actor.userId, id, domain, name, alias);
  }
}
