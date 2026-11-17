import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['draft', 'open', 'partially_paid', 'paid', 'void', 'uncollectible'];
const EINVOICE_STATES = [
  'not_generated',
  'generated',
  'stamped',
  'queued',
  'submitted',
  'cleared',
  'reported',
  'rejected',
  'error',
];

export interface AdminInvoiceDto {
  id: string;
  orgId: string;
  number: string;
  status: string;
  environment: 'sandbox' | 'live';
  currency: string;
  issuedAt: string;
  dueAt: string;
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  paidMinor: string;
  buyerName: { ar: string; en: string };
  buyerVatNumber: string | null;
  taxReviewRequired: boolean;
  dataRegion: string;
  einvoice: {
    state: string;
    environment: 'sandbox' | 'simulation' | 'production' | null;
    uuid: string | null;
  };
}

const iso = (v: unknown, name: string): Date | null => {
  if (v === undefined || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime()))
    throw new ProblemException('validation_failed', `${name} must be an ISO date-time`);
  return d;
};

/**
 * Cross-organization invoice search for finance (S12d, UI-M03-13). READ-ONLY: it reads through the platform scope (`app.platform_scope =
 * admin`, SELECT only) and every read is audited. Nothing here can change an invoice; corrections are credit notes.
 */
export class AdminInvoiceReadService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(
    actorUserId: string,
    o: {
      limit: number;
      cursor?: string | undefined;
      org?: string | undefined;
      status?: string | undefined;
      number?: string | undefined;
      einvoiceState?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    },
  ): Promise<Page<AdminInvoiceDto>> {
    if (o.org !== undefined && !UUID.test(o.org))
      throw new ProblemException('validation_failed', 'org must be a uuid');
    if (o.status !== undefined && !STATUSES.includes(o.status))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${STATUSES.join(', ')}`,
      );
    if (o.einvoiceState !== undefined && !EINVOICE_STATES.includes(o.einvoiceState))
      throw new ProblemException(
        'validation_failed',
        `einvoiceState must be one of ${EINVOICE_STATES.join(', ')}`,
      );
    if (o.number !== undefined && (o.number.length > 40 || /[\0]/.test(o.number)))
      throw new ProblemException('validation_failed', 'number is too long');
    const from = iso(o.from, 'from');
    const to = iso(o.to, 'to');
    const after = decodeCursor(o.cursor);
    // prefix match on the number; LIKE metacharacters in the input are escaped so they match literally
    const prefix =
      o.number === undefined || o.number === ''
        ? null
        : `${o.number.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT i.*, d.uuid AS z_uuid, d.environment AS z_env, d.state AS z_state
               FROM invoicing.invoices i
               LEFT JOIN LATERAL (
                 SELECT x.uuid, x.environment,
                        (SELECT s.state FROM invoicing.zatca_submissions s WHERE s.document_id = x.id ORDER BY s.seq DESC LIMIT 1) AS state
                   FROM invoicing.zatca_documents x
                  WHERE x.source_type = 'invoice' AND x.source_id = i.id ORDER BY x.created_at DESC LIMIT 1) d ON true
              WHERE ($1::uuid IS NULL OR i.org_id = $1::uuid) AND ($2::text IS NULL OR i.status = $2)
                AND ($3::text IS NULL OR i.number_text ILIKE $3) AND ($4::timestamptz IS NULL OR i.issued_at >= $4)
                AND ($5::timestamptz IS NULL OR i.issued_at <= $5)
                AND ($6::text IS NULL OR coalesce(d.state, 'not_generated') = $6)
                AND ($7::uuid IS NULL OR i.id < $7::uuid)
              ORDER BY i.id DESC LIMIT $8`,
            [
              o.org ?? null,
              o.status ?? null,
              prefix,
              from,
              to,
              o.einvoiceState ?? null,
              after,
              o.limit + 1,
            ],
          )
        ).rows as Row[],
    );
    const page = pageOf(
      rows.map((r) => ({ id: r.id as string, r })),
      o.limit,
    );
    await this.audit.record({
      action: 'billing.admin_invoices.read',
      actorUserId,
      resource: { type: 'invoice_search' },
      outcome: 'success',
      detail: {
        org: o.org ?? null,
        status: o.status ?? null,
        einvoiceState: o.einvoiceState ?? null,
        numberFilter: o.number !== undefined && o.number !== '',
        rows: page.items.length,
      },
    });
    return { items: page.items.map((x) => this.dto(x.r)), nextCursor: page.nextCursor };
  }

  private dto(r: Row): AdminInvoiceDto {
    const buyer = (r.buyer ?? {}) as {
      legalName?: { ar?: string; en?: string };
      vatNumber?: string | null;
    };
    const review = (r.tax_review ?? {}) as { required?: boolean };
    return {
      id: r.id as string,
      orgId: r.org_id as string,
      number: r.number_text as string,
      status: r.status as string,
      environment: r.environment as 'sandbox' | 'live',
      currency: (r.currency as string).trim(),
      issuedAt: (r.issued_at as Date).toISOString(),
      dueAt: (r.due_at as Date).toISOString(),
      subtotalMinor: String(r.subtotal_minor),
      taxMinor: String(r.tax_minor),
      totalMinor: String(r.total_minor),
      paidMinor: String(r.paid_minor),
      buyerName: { ar: buyer.legalName?.ar ?? '', en: buyer.legalName?.en ?? '' },
      buyerVatNumber: buyer.vatNumber ?? null,
      taxReviewRequired: review.required === true,
      dataRegion: r.data_region as string,
      einvoice: {
        state: (r.z_state as string | null) ?? 'not_generated',
        environment: (r.z_env as AdminInvoiceDto['einvoice']['environment']) ?? null,
        uuid: (r.z_uuid as string | null) ?? null,
      },
    };
  }
}
