import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { PaymentService } from './internal/payment.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Payments of the active organization (docs/04 §2.3). 201 created, 202 while the outcome is still unknown. */
@Controller('v1/billing/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentService) {}

  @RequirePermission('billing:manage')
  @Idempotent()
  @Post()
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.payments.create(orgId, a.actor.userId, body ?? {});
    void reply.status(r.httpStatus);
    return r.payment;
  }

  @RequirePermission('billing:read')
  @Get()
  list(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; status?: string; invoice?: string },
  ) {
    return this.payments.list(orgId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      status: q.status,
      invoiceId: q.invoice,
    });
  }

  @RequirePermission('billing:read')
  @Get(':id')
  get(@Org() orgId: string, @Param('id') id: string) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    return this.payments.get(orgId, id.toLowerCase());
  }
}
