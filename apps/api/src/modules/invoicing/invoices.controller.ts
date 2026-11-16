import { Controller, Get, Param, Query, StreamableFile } from '@nestjs/common';
import { Org, RequirePermission } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import type { DocLocale } from './internal/doc-labels';
import { InvoiceService } from './internal/invoice.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: string) => {
  if (!UUID.test(v)) throw new ProblemException('not_found');
  return v.toLowerCase();
};
const date = (name: string, v: string | undefined) => {
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new ProblemException('validation_failed', `${name} must be an ISO-8601 timestamp`);
  return d;
};
export const docLocale = (v: string | undefined): DocLocale => {
  if (v === undefined) return 'ar'; // D-32: Arabic first
  if (v !== 'ar' && v !== 'en')
    throw new ProblemException('validation_failed', "lang must be 'ar' or 'en'");
  return v;
};

/** Invoices of the active organization (docs/04 §2.3). Issued invoices only: drafts are never stored. */
@Controller('v1/billing/invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoiceService) {}

  @RequirePermission('billing:read')
  @Get()
  list(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; status?: string; from?: string; to?: string },
  ) {
    return this.invoices.list(orgId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      status: q.status,
      from: date('from', q.from),
      to: date('to', q.to),
    });
  }

  @RequirePermission('billing:read')
  @Get(':id')
  get(@Org() orgId: string, @Param('id') p: string) {
    return this.invoices.get(orgId, id(p));
  }

  /** `?lang=ar|en` (default ar). Rendered from the immutable snapshot, so a reprint is identical. */
  @RequirePermission('billing:read')
  @Get(':id/pdf')
  async pdf(@Org() orgId: string, @Param('id') p: string, @Query() q: { lang?: string }) {
    const r = await this.invoices.pdf(orgId, id(p), docLocale(q.lang));
    return new StreamableFile(r.pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${r.filename}"`,
    });
  }

  /** The e-invoice XML exists only after the ZATCA module generates it (S11): until then 409, as docs/04 specifies. */
  @RequirePermission('billing:read')
  @Get(':id/xml')
  async xml(@Org() orgId: string, @Param('id') p: string) {
    await this.invoices.get(orgId, id(p)); // 404 for unknown / foreign ids first
    throw new ProblemException(
      'conflict',
      'the e-invoice XML has not been generated for this invoice',
    );
  }
}
