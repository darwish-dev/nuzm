import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { EmailDomainService } from './internal/domain.service';
import { MailboxService } from './internal/mailbox.service';
import { MessageService } from './internal/message.service';
import { SenderTemplateService } from './internal/sender-template.service';
import { SuppressionService } from './internal/suppression.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const ifMatch = (req: FastifyRequest) => {
  const v = parseIfMatch(req.headers['if-match']);
  if (v === null)
    throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
  return v;
};
const page = (q: { limit?: string; cursor?: string }) => ({
  limit: parseLimit(q.limit),
  cursor: q.cursor,
});

/** Email domains and business mailboxes (docs/04 §2.8). */
@Controller('v1/email')
export class EmailController {
  constructor(
    private readonly domains: EmailDomainService,
    private readonly mailboxes: MailboxService,
    private readonly senders: SenderTemplateService,
    private readonly messages: MessageService,
    private readonly suppressions: SuppressionService,
  ) {}

  // ---- domains -----------------------------------------------------------------------------------------------------------
  /** 201 with the required DNS records (declared by the provider adapters + Nuzm's ownership TXT + DMARC guidance) and `state=pending`. */
  @RequirePermission('email:domain:manage')
  @Idempotent()
  @Post('domains')
  @HttpCode(201)
  addDomain(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.domains.create(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('email:read')
  @Get('domains')
  listDomains(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.domains.list(orgId, page(q));
  }
  /** Re-check DNS now (several resolvers, majority) and the provider's own verification. `apply=true` writes the records through the M07 zone when the domain is a Nuzm zone. */
  @RequirePermission('email:domain:manage')
  @Post('domains/:id/verification')
  @HttpCode(200)
  verify(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.domains.verify(orgId, a.actor.userId, id.toLowerCase(), {
      apply: b(body).apply === true,
    });
  }

  // ---- mailboxes ---------------------------------------------------------------------------------------------------------
  @RequirePermission('email:mailbox:manage')
  @Idempotent()
  @Post('mailboxes')
  @HttpCode(202)
  async createMailbox(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Body_,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const m = await this.mailboxes.create(orgId, a.actor.userId, b(body));
    void reply.header('etag', etag(m.etag));
    return m;
  }
  @RequirePermission('email:read')
  @Get('mailboxes')
  listMailboxes(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; domainId?: string },
  ) {
    return this.mailboxes.list(orgId, { ...page(q), domainId: q.domainId });
  }
  @RequirePermission('email:mailbox:manage')
  @Patch('mailboxes/:id')
  @HttpCode(202)
  async patchMailbox(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
  ) {
    return this.mailboxes.patch(orgId, a.actor.userId, id.toLowerCase(), ifMatch(req), b(body));
  }
  @RequirePermission('email:mailbox:manage')
  @Delete('mailboxes/:id')
  @HttpCode(202)
  deleteMailbox(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    return this.mailboxes.remove(orgId, a.actor.userId, id.toLowerCase());
  }
  @RequirePermission('email:mailbox:manage')
  @Idempotent()
  @Post('aliases')
  @HttpCode(202)
  createAlias(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.mailboxes.createAlias(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('email:read')
  @Get('aliases')
  listAliases(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.mailboxes.listAliases(orgId, page(q));
  }

  // ---- sender identities, templates ----------------------------------------------------------------------------------------
  @RequirePermission('email:domain:manage')
  @Idempotent()
  @Post('sender-identities')
  @HttpCode(201)
  createSender(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.senders.createSender(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('email:read')
  @Get('sender-identities')
  listSenders(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.senders.listSenders(orgId, page(q));
  }
  @RequirePermission('email:template:write')
  @Idempotent()
  @Post('templates')
  @HttpCode(201)
  createTemplate(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.senders.createTemplate(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('email:read')
  @Get('templates')
  listTemplates(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; key?: string },
  ) {
    return this.senders.listTemplates(orgId, { ...page(q), key: q.key });
  }

  // ---- messages, events, suppressions ------------------------------------------------------------------------------------
  /** 202 `{id, status: queued}`. Idempotency-Key is mandatory. `category` must be `transactional`. */
  @RequirePermission('email:send')
  @Idempotent()
  @Post('messages')
  @HttpCode(202)
  send(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
  ) {
    return this.messages.send(
      orgId,
      a.actor.userId,
      String(req.headers['idempotency-key'] ?? ''),
      b(body),
    );
  }
  @RequirePermission('email:read')
  @Get('messages/:id')
  getMessage(@Org() orgId: string, @Param('id') id: string) {
    return this.messages.get(orgId, id.toLowerCase());
  }
  @RequirePermission('email:read')
  @Get('messages')
  listMessages(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; status?: string; senderId?: string },
  ) {
    return this.messages.list(orgId, { ...page(q), status: q.status, senderId: q.senderId });
  }
  @RequirePermission('email:read')
  @Get('events')
  listEvents(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; type?: string; messageId?: string },
  ) {
    return this.messages.listEvents(orgId, { ...page(q), type: q.type, messageId: q.messageId });
  }
  @RequirePermission('email:read')
  @Get('suppressions')
  listSuppressions(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; active?: string },
  ) {
    return this.suppressions.list(orgId, { ...page(q), active: q.active });
  }
  /** Add (default) or, with `action: remove`, remove a suppression: audited. Hard bounces and complaints need `override: true` to be removed. */
  @RequirePermission('email:domain:manage')
  @Post('suppressions')
  @HttpCode(200)
  addSuppression(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.suppressions.add(orgId, a.actor.userId, b(body));
  }
}
