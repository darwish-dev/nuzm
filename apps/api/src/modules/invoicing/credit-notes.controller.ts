import { Controller, Get, Param, Query } from '@nestjs/common';
import { Org, RequirePermission } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { CreditNoteService } from './internal/credit-note.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Credit notes of the active organization (docs/04 §2.3). They are issued by refunds and support flows, never by the customer. */
@Controller('v1/billing/credit-notes')
export class CreditNotesController {
  constructor(private readonly notes: CreditNoteService) {}

  @RequirePermission('billing:read')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string; invoice?: string }) {
    return this.notes.list(orgId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      invoiceId: q.invoice,
    });
  }

  @RequirePermission('billing:read')
  @Get(':id')
  get(@Org() orgId: string, @Param('id') id: string) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    return this.notes.get(orgId, id.toLowerCase());
  }
}
