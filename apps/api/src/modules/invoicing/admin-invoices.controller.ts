import { Controller, Get, Query } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { parseLimit } from '../../common/pagination';
import { RealmOnly } from '../identity';
import { AdminInvoiceReadService } from './internal/admin-invoice-read.service';

/** Cross-organization invoice search for finance (S12d, UI-M03-13). Read-only; every read is audited. Corrections are credit notes. */
@RealmOnly('admin')
@Controller('v1/admin/billing/invoices')
export class AdminInvoicesController {
  constructor(private readonly reads: AdminInvoiceReadService) {}

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
      number?: string;
      einvoiceState?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.reads.list(who.userId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      org: q.org,
      status: q.status,
      number: q.number,
      einvoiceState: q.einvoiceState,
      from: q.from,
      to: q.to,
    });
  }
}
