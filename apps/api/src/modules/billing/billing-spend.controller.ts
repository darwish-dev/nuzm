import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { DenyImpersonation, StepUp } from '../identity';
import { SpendService } from './internal/spend.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Spending limits and spend approvals (docs/04 §2.2). */
@Controller('v1/billing')
export class BillingSpendController {
  constructor(private readonly spend: SpendService) {}

  @RequirePermission('billing:read')
  @Get('spending-limits')
  async listLimits(@Org() orgId: string) {
    return { items: await this.spend.listLimits(orgId) };
  }

  /** Create or replace one cap (scope + project). Replacing needs `If-Match` (the limit's ETag): 412 when stale. */
  @RequirePermission('billing:manage')
  @Put('spending-limits')
  async putLimit(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = req.headers['if-match'];
    const expected = parseIfMatch(raw);
    if (raw !== undefined && expected === null)
      throw new ProblemException('validation_failed', "If-Match must be the limit's ETag");
    const limit = await this.spend.putLimit(orgId, body ?? {}, expected, a.actor.userId);
    void reply.header('etag', etag(limit.version));
    return limit;
  }

  @RequirePermission('spend:request')
  @Idempotent()
  @Post('spend-approvals')
  @HttpCode(201)
  request(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.spend.request(orgId, a.actor.userId, body ?? {});
  }

  /** Approvers (billing:manage) see every request; others see their own. */
  @RequirePermission('spend:request')
  @Get('spend-approvals')
  list(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Query() q: { limit?: string; cursor?: string; status?: string },
  ) {
    return this.spend.list(
      orgId,
      { userId: a.actor.userId, seesAll: a.permissions.has('billing:manage') },
      { limit: parseLimit(q.limit), cursor: q.cursor, status: q.status },
    );
  }

  /** Session-only, step-up protected, never while impersonating: approving spend is a financial decision. */
  @DenyImpersonation()
  @RequirePermission('billing:manage')
  @StepUp()
  @Post('spend-approvals/:id/decision')
  @HttpCode(200)
  decision(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    if (a.actor.kind !== 'session')
      throw new ProblemException('forbidden', 'API keys cannot decide spend approvals');
    if (!UUID.test(id)) throw new ProblemException('not_found');
    return this.spend.decide(orgId, id.toLowerCase(), a.actor.userId, body ?? {});
  }
}
