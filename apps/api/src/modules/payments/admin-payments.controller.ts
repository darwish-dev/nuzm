import { Controller, Get, Param, Query } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { parseLimit } from '../../common/pagination';
import { RealmOnly } from '../identity';
import { AdminPaymentReadService } from './internal/admin-payment-read.service';

/** Cross-organization payment search and redacted PSP events for finance (S12d, UI-M03-14). Read-only; every read is audited. */
@RealmOnly('admin')
@Controller('v1/admin/billing/payments')
export class AdminPaymentsController {
  constructor(private readonly reads: AdminPaymentReadService) {}

  @RequirePlatformPermission('admin:billing:read')
  @Get()
  list(
    @Platform() who: PlatformContext,
    @Query()
    q: {
      limit?: string;
      cursor?: string;
      org?: string;
      status?: string;
      invoiceId?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.reads.listPayments(who.userId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      org: q.org,
      status: q.status,
      invoiceId: q.invoiceId,
      from: q.from,
      to: q.to,
    });
  }

  @RequirePlatformPermission('admin:billing:read')
  @Get(':id/events')
  events(@Platform() who: PlatformContext, @Param('id') id: string) {
    return this.reads.paymentEvents(who.userId, id);
  }
}
