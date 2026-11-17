import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { ConsentService, type Caller } from './internal/consent.service';

const callerOf = (a: AccessContext): Caller => ({
  userId: a.actor.userId,
  canManage: a.permissions.has('privacy:consent:manage'),
  via: a.actor.kind === 'api_key' ? 'api_key' : 'session',
});

/** Consents (docs/04 §2.4): any member for themselves, `privacy:consent:manage` (owner, admin) for the organization and its end users. */
@Controller('v1/compliance')
export class ConsentsController {
  constructor(private readonly consents: ConsentService) {}

  /** Append-only. Granting again with the same wording while already granted answers 200 with the existing record and writes nothing. */
  @RequirePermission('privacy:consent:self')
  @Idempotent()
  @Post('consents')
  async grant(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.consents.grant(orgId, callerOf(a), body ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.consent;
  }

  @RequirePermission('privacy:consent:self')
  @Get('consents')
  list(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Query()
    q: {
      purposeId?: string;
      subject?: string;
      status?: string;
      history?: string;
      limit?: string;
      cursor?: string;
    },
  ) {
    return this.consents.list(orgId, callerOf(a), {
      purposeId: q.purposeId,
      subject: q.subject,
      status: q.status,
      history: q.history === 'true',
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  /** Records a `withdrawn` entry (the row is retained). Applies immediately; withdrawing twice changes nothing. */
  @RequirePermission('privacy:consent:self')
  @Delete('consents/:id')
  @HttpCode(204)
  async withdraw(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    await this.consents.withdraw(orgId, callerOf(a), id.toLowerCase());
  }
}
