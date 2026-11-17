import type { Db } from '@nuzm/platform';
import { enqueue } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../../common/pagination';
import {
  EInvoiceAuthError,
  EInvoiceTimeout,
  EInvoiceUnavailable,
  type DecisionResult,
  type EInvoiceAdapter,
} from './adapter';
import type { ArchiveStore } from './archive';
import { subtypeOf } from './build-document';
import type { SecretStore } from './secrets';
import { appendSubmission, type SubmissionState } from './submission-log';
import type { ZatcaDocumentService } from './zatca-document.service';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES: SubmissionState[] = [
  'generated',
  'stamped',
  'queued',
  'submitted',
  'cleared',
  'reported',
  'rejected',
  'error',
];

export interface SubmissionDto {
  /** The id of the latest state row (the retry endpoint takes it). */
  id: string;
  documentId: string;
  orgId: string;
  environment: 'sandbox' | 'simulation';
  documentType: string;
  subtype: 'standard' | 'simplified';
  uuid: string;
  icv: string;
  state: SubmissionState;
  attempt: number;
  deadLetter: boolean;
  nextAttemptAt: string | null;
  lastError: { code: string; message: string } | null;
  warnings: { code: string; message: string }[];
  updatedAt: string;
  createdAt: string;
  /** Simplified invoices must be reported within the window: seconds left (null once decided or for standard documents). */
  windowRemainingSeconds: number | null;
  /** True once half of the reporting window has passed without a report (the SLO alarm). */
  windowAlert: boolean;
  windowBreached: boolean;
  notVerifiedVsZatca: boolean;
}
export interface InvoiceZatcaStatus {
  state: 'not_generated' | SubmissionState;
  uuid: string | null;
  qr: string | null;
}

/**
 * The submission queue (docs/11 §5): append-only state rows per document, the current state is the latest row. The rules that matter:
 *  - **Reconcile before retry:** a timeout (the answer was lost) is never retried blindly: the server is asked about the document uuid first, and
 *    a decision that already exists is adopted. A decided document is never resubmitted.
 *  - **Backoff then dead letter:** a failed attempt is followed by `queued` with an exponential delay; after the maximum number of attempts the
 *    document stops at `error` (dead letter) until a person retries it. A REJECTED document is final: it needs human review, never a resubmission.
 *  - **Standard invoices are not delivered before clearance**; simplified ones are queued and reported within the window (config; alarm at 50%).
 *  - **Claim by insert:** moving a document to `submitted` is an append that only one worker can win (transition check + unique sequence).
 */
export class ZatcaSubmissionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly docs: Pick<ZatcaDocumentService, 'mode' | 'profile'>,
    private readonly adapter: EInvoiceAdapter,
    private readonly secrets: SecretStore,
    private readonly archive: ArchiveStore,
    private readonly opts: { maxAttempts: number; baseBackoffSeconds: number } = {
      maxAttempts: 6,
      baseBackoffSeconds: 60,
    },
  ) {}

  static optsFromEnv(env: NodeJS.ProcessEnv = process.env) {
    const maxAttempts = Number(env.ZATCA_MAX_ATTEMPTS ?? 6);
    const baseBackoffSeconds = Number(env.ZATCA_BACKOFF_SECONDS ?? 60);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
      throw new Error('ZATCA_MAX_ATTEMPTS must be an integer 1..20');
    if (
      !Number.isInteger(baseBackoffSeconds) ||
      baseBackoffSeconds < 1 ||
      baseBackoffSeconds > 3600
    )
      throw new Error('ZATCA_BACKOFF_SECONDS must be an integer 1..3600');
    return { maxAttempts, baseBackoffSeconds };
  }

  private env(): 'sandbox' | 'simulation' {
    if (this.docs.mode === 'off')
      throw new ProblemException('conflict', 'e-invoicing is not enabled (ZATCA_MODE=off)');
    return this.docs.mode;
  }

  /** The active PRODUCTION-kind credential of an entity (references only); the secrets are fetched from the vault at call time. */
  async credentialFor(
    entityId: string,
    env: string,
  ): Promise<{ keyRef: string; tokenRef: string; secretRef: string } | null> {
    const rows = await this.db.withoutScope(
      async (c) =>
        (await c.query(`SELECT * FROM invoicing.zatca_active_credential($1, $2)`, [entityId, env]))
          .rows as Row[],
    );
    const p = rows.find((r) => r.kind === 'production_csid');
    return p
      ? {
          keyRef: p.key_ref as string,
          tokenRef: p.token_ref as string,
          secretRef: p.secret_ref as string,
        }
      : null;
  }

  // ---- enqueue and process -----------------------------------------------------------------------------------------------

  async enqueue(orgId: string, documentId: string, now = new Date()): Promise<boolean> {
    try {
      return await this.db.withOrg(orgId, async (c) => {
        const cur = (
          await c.query(
            `SELECT state FROM invoicing.zatca_submissions WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
            [documentId],
          )
        ).rows[0];
        if (!cur || cur.state !== 'stamped') return false;
        await appendSubmission(c, orgId, documentId, 'queued', { nextAttemptAt: now, now });
        return true;
      });
    } catch (e) {
      if (['23505', '23514'].includes((e as { code?: string }).code ?? '')) return false; // another worker queued it first
      throw e;
    }
  }

  async processDue(
    now = new Date(),
    limit = 50,
  ): Promise<{
    cleared: number;
    reported: number;
    rejected: number;
    failed: number;
    deadLetters: number;
    skipped: number;
  }> {
    const env = this.env();
    const due = await this.db.withoutScope(
      async (c) =>
        (
          await c.query<{ org_id: string; document_id: string }>(
            `SELECT org_id, document_id FROM invoicing.zatca_pending($1, 'queued', $2, $3)`,
            [env, now, limit],
          )
        ).rows,
    );
    const out = { cleared: 0, reported: 0, rejected: 0, failed: 0, deadLetters: 0, skipped: 0 };
    for (const d of due) {
      try {
        const r = await this.processOne(d.org_id, d.document_id, now);
        if (r === 'skipped') out.skipped++;
        else if (r === 'dead_letter') out.deadLetters++;
        else if (r === 'error') out.failed++;
        else out[r]++;
      } catch {
        out.failed++;
      }
    }
    return out;
  }

  private async processOne(
    orgId: string,
    documentId: string,
    now: Date,
  ): Promise<'cleared' | 'reported' | 'rejected' | 'error' | 'dead_letter' | 'skipped'> {
    const loaded = await this.db.withOrg(orgId, async (c) => ({
      doc: (await c.query(`SELECT * FROM invoicing.zatca_documents WHERE id = $1`, [documentId]))
        .rows[0] as Row | undefined,
      cur: (
        await c.query(
          `SELECT * FROM invoicing.zatca_submissions WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
          [documentId],
        )
      ).rows[0] as Row | undefined,
    }));
    const { doc, cur } = loaded;
    if (
      !doc ||
      !cur ||
      cur.state !== 'queued' ||
      (cur.next_attempt_at as Date).getTime() > now.getTime() ||
      doc.xml_final === null
    )
      return 'skipped';
    const attempt = (cur.attempt as number) + 1;
    try {
      await this.db.withOrg(orgId, (c) =>
        appendSubmission(c, orgId, documentId, 'submitted', { attempt, now }),
      );
    } catch (e) {
      if (['23505', '23514'].includes((e as { code?: string }).code ?? '')) return 'skipped'; // lost the claim
      throw e;
    }
    const fail = (code: string, message: string) =>
      this.failure(orgId, doc, attempt, { code, message }, now);
    const cred = await this.credentialFor(doc.entity_id as string, doc.environment as string);
    if (!cred)
      return fail('no_credentials', 'no production credential exists: finish the onboarding');
    const c = {
      token: await this.secrets.get(cred.tokenRef),
      secret: await this.secrets.get(cred.secretRef),
    };
    const send = {
      uuid: doc.uuid as string,
      hash: doc.invoice_hash as string,
      type: doc.document_type as 'invoice',
      subtype: doc.subtype as 'standard' | 'simplified',
      xml: doc.xml_final as string,
    };
    let result: DecisionResult | null;
    try {
      result = await this.adapter.submit(c, send);
    } catch (e) {
      if (e instanceof EInvoiceTimeout) {
        // the outcome is unknown: ask before anything else; a decision that exists is adopted and NEVER resubmitted
        try {
          result = await this.adapter.lookup(c, send.uuid);
        } catch {
          result = null;
        }
        if (!result)
          return fail(
            'timeout',
            'the service did not answer and has no record of the document yet',
          );
      } else if (e instanceof EInvoiceUnavailable) {
        if (doc.subtype === 'standard') await this.alert(orgId, documentId, 'unavailable');
        return fail('unavailable', 'the e-invoicing service is unavailable');
      } else if (e instanceof EInvoiceAuthError) return fail('auth', 'the credential was refused');
      else return fail('unexpected', 'unexpected error talking to the e-invoicing service');
    }
    return this.decided(orgId, doc, attempt, result, now);
  }

  private async alert(orgId: string, documentId: string, reason: string) {
    await this.db.withOrg(orgId, async (c) => {
      await enqueue(c, orgId, 'zatca.clearance_unavailable', { documentId, reason });
      await this.audit.record({
        action: 'invoicing.zatca_submission.clearance_unavailable',
        actorType: 'system',
        orgId,
        resource: { type: 'zatca_document', id: documentId },
        outcome: 'failure',
        detail: { reason },
      });
    });
  }

  private async decided(orgId: string, doc: Row, attempt: number, r: DecisionResult, now: Date) {
    const response = {
      status: r.status,
      requestRef: r.requestRef,
      warnings: r.warnings,
      errors: r.errors,
      notVerifiedVsZatca: this.docs.profile.synthetic,
    };
    await this.db.withOrg(orgId, async (c) => {
      await appendSubmission(c, orgId, doc.id as string, r.status, { attempt, response, now });
      if (r.status === 'cleared' && r.clearedXml)
        await c.query(
          `UPDATE invoicing.zatca_documents SET cleared_xml = $2, cleared_at = $3 WHERE id = $1 AND cleared_xml IS NULL`,
          [doc.id, r.clearedXml, now],
        );
      await enqueue(c, orgId, `zatca.submission.${r.status}`, {
        documentId: doc.id,
        uuid: doc.uuid,
        attempt,
      });
      await this.audit.record({
        action: `invoicing.zatca_submission.${r.status}`,
        actorType: 'system',
        orgId,
        resource: { type: 'zatca_document', id: doc.id as string },
        outcome: r.status === 'rejected' ? 'failure' : 'success',
        detail: { attempt, errors: r.errors.map((e) => e.code) },
      });
    });
    if (r.status === 'cleared' && r.clearedXml) {
      const key = `${doc.environment as string}/${doc.entity_id as string}/${String(doc.icv).padStart(10, '0')}.cleared.xml`;
      const put = await this.archive.put(key, Buffer.from(r.clearedXml, 'utf8'));
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE invoicing.zatca_documents SET cleared_archive_ref = $2 WHERE id = $1 AND cleared_archive_ref IS NULL`,
          [doc.id, put.ref],
        ),
      );
    }
    return r.status;
  }

  /** Record a failed attempt: error + queued with exponential backoff, or error as a dead letter after the last attempt. */
  private async failure(
    orgId: string,
    doc: Row,
    attempt: number,
    lastError: { code: string; message: string },
    now: Date,
  ): Promise<'error' | 'dead_letter'> {
    const dead = attempt >= this.opts.maxAttempts;
    await this.db.withOrg(orgId, async (c) => {
      await appendSubmission(c, orgId, doc.id as string, 'error', {
        attempt,
        deadLetter: dead,
        response: { lastError },
        now,
      });
      if (dead) {
        await enqueue(c, orgId, 'zatca.submission.dead_letter', {
          documentId: doc.id,
          uuid: doc.uuid,
          lastError: lastError.code,
        });
        await this.audit.record({
          action: 'invoicing.zatca_submission.dead_letter',
          actorType: 'system',
          orgId,
          resource: { type: 'zatca_document', id: doc.id as string },
          outcome: 'failure',
          detail: { attempt, lastError: lastError.code },
        });
      } else {
        const delay = this.opts.baseBackoffSeconds * 2 ** (attempt - 1);
        await appendSubmission(c, orgId, doc.id as string, 'queued', {
          attempt,
          nextAttemptAt: new Date(now.getTime() + delay * 1000),
          response: { lastError },
          now,
        });
        await this.audit.record({
          action: 'invoicing.zatca_submission.failed',
          actorType: 'system',
          orgId,
          resource: { type: 'zatca_document', id: doc.id as string },
          outcome: 'failure',
          detail: { attempt, lastError: lastError.code, retryInSeconds: delay },
        });
      }
    });
    return dead ? 'dead_letter' : 'error';
  }

  // ---- finance: list and retry ---------------------------------------------------------------------------------------------

  private toDto(r: Row, now: Date): SubmissionDto {
    const state = r.state as SubmissionState;
    const response = (r.response ?? {}) as {
      lastError?: { code: string; message: string };
      errors?: { code: string; message: string }[];
      warnings?: { code: string; message: string }[];
    };
    const open = r.subtype === 'simplified' && !['reported', 'rejected'].includes(state);
    const started = ((r.stamped_at as Date | null) ?? (r.doc_created_at as Date)).getTime();
    const windowMs = this.docs.profile.reportingWindowHours * 3_600_000;
    const elapsed = now.getTime() - started;
    return {
      id: r.id as string,
      documentId: r.document_id as string,
      orgId: r.org_id as string,
      environment: r.environment as 'sandbox' | 'simulation',
      documentType: r.document_type as string,
      subtype: r.subtype as 'standard' | 'simplified',
      uuid: r.uuid as string,
      icv: String(r.icv),
      state,
      attempt: r.attempt as number,
      deadLetter: r.dead_letter as boolean,
      nextAttemptAt: r.next_attempt_at ? (r.next_attempt_at as Date).toISOString() : null,
      lastError:
        response.lastError ?? (state === 'rejected' ? (response.errors?.[0] ?? null) : null),
      warnings: response.warnings ?? [],
      updatedAt: (r.created_at as Date).toISOString(),
      createdAt: (r.doc_created_at as Date).toISOString(),
      windowRemainingSeconds:
        open && r.stamped_at ? Math.max(0, Math.floor((windowMs - elapsed) / 1000)) : null,
      windowAlert: open && Boolean(r.stamped_at) && elapsed >= windowMs / 2,
      windowBreached: open && Boolean(r.stamped_at) && elapsed >= windowMs,
      notVerifiedVsZatca: this.docs.profile.synthetic,
    };
  }

  async list(
    o: {
      limit: number;
      cursor?: string | undefined;
      state?: string | undefined;
      org?: string | undefined;
      deadLetter?: boolean | undefined;
    },
    now = new Date(),
  ): Promise<Page<SubmissionDto>> {
    if (o.state !== undefined && !STATES.includes(o.state as SubmissionState))
      throw new ProblemException('validation_failed', `state must be one of ${STATES.join(', ')}`);
    if (o.org !== undefined && !UUID.test(o.org))
      throw new ProblemException('validation_failed', 'org must be a uuid');
    const env = this.env();
    const after = decodeCursor(o.cursor);
    return this.db.withPlatformScope(async (c) => {
      const rows = (
        await c.query(
          `SELECT s.*, d.environment, d.document_type, d.subtype, d.uuid, d.icv, d.stamped_at, d.created_at AS doc_created_at
             FROM invoicing.zatca_documents d JOIN LATERAL (SELECT * FROM invoicing.zatca_submissions x WHERE x.document_id = d.id ORDER BY x.seq DESC LIMIT 1) s ON true
            WHERE d.environment = $1 AND ($2::text IS NULL OR s.state = $2) AND ($3::uuid IS NULL OR d.org_id = $3::uuid)
              AND ($4::boolean IS NULL OR s.dead_letter = $4) AND ($5::uuid IS NULL OR d.id < $5::uuid)
            ORDER BY d.id DESC LIMIT $6`,
          [env, o.state ?? null, o.org ?? null, o.deadLetter ?? null, after, o.limit + 1],
        )
      ).rows as Row[];
      const p = pageOf(
        rows.map((r) => ({ id: r.document_id as string, r })),
        o.limit,
      );
      return { items: p.items.map((x) => this.toDto(x.r, now)), nextCursor: p.nextCursor };
    });
  }

  /** Retry a document that stopped at `error` (dead letter). Idempotent per document: a queued or submitted one is returned as is; a decided one is not retryable. */
  async retry(actorUserId: string, submissionId: string, now = new Date()): Promise<SubmissionDto> {
    if (!UUID.test(submissionId)) throw new ProblemException('not_found');
    const found = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ org_id: string; document_id: string }>(
            `SELECT org_id, document_id FROM invoicing.zatca_submissions WHERE id = $1`,
            [submissionId.toLowerCase()],
          )
        ).rows[0],
    );
    if (!found) throw new ProblemException('not_found');
    await this.db.withOrg(found.org_id, async (c) => {
      const cur = (
        await c.query(
          `SELECT * FROM invoicing.zatca_submissions WHERE document_id = $1 ORDER BY seq DESC LIMIT 1`,
          [found.document_id],
        )
      ).rows[0] as Row;
      if (cur.state === 'queued' || cur.state === 'submitted') return; // already on its way: nothing to do
      if (['cleared', 'reported'].includes(cur.state as string))
        throw new ProblemException('conflict', `this document is already ${cur.state as string}`);
      if (cur.state === 'rejected')
        throw new ProblemException(
          'conflict',
          'a rejected document is not resubmitted: it needs human review (issue a credit note and a new invoice)',
        );
      if (cur.state !== 'error')
        throw new ProblemException(
          'conflict',
          `a ${cur.state as string} document is not ready to be retried`,
        );
      await appendSubmission(c, found.org_id, found.document_id, 'queued', {
        attempt: 0,
        nextAttemptAt: now,
        response: { manualRetryBy: actorUserId },
        now,
      });
      await this.audit.record({
        action: 'invoicing.zatca_submission.retried',
        actorUserId,
        orgId: found.org_id,
        resource: { type: 'zatca_document', id: found.document_id },
        outcome: 'success',
      });
    });
    const page = await this.listOne(found.document_id, now);
    return page;
  }
  private async listOne(documentId: string, now: Date): Promise<SubmissionDto> {
    return this.db.withPlatformScope(async (c) => {
      const r = (
        await c.query(
          `SELECT s.*, d.environment, d.document_type, d.subtype, d.uuid, d.icv, d.stamped_at, d.created_at AS doc_created_at
             FROM invoicing.zatca_documents d JOIN LATERAL (SELECT * FROM invoicing.zatca_submissions x WHERE x.document_id = d.id ORDER BY x.seq DESC LIMIT 1) s ON true WHERE d.id = $1`,
          [documentId],
        )
      ).rows[0] as Row;
      return this.toDto(r, now);
    });
  }

  // ---- invoice-facing: status, delivery gate, XML ---------------------------------------------------------------------------

  async statusOf(
    orgId: string,
    sourceType: 'invoice' | 'credit_note',
    sourceId: string,
  ): Promise<InvoiceZatcaStatus> {
    if (this.docs.mode === 'off') return { state: 'not_generated', uuid: null, qr: null };
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT d.uuid, d.qr, (SELECT state FROM invoicing.zatca_submissions x WHERE x.document_id = d.id ORDER BY seq DESC LIMIT 1) AS state
             FROM invoicing.zatca_documents d WHERE d.org_id = $1 AND d.source_type = $2 AND d.source_id = $3 AND d.environment = $4`,
            [orgId, sourceType, sourceId, this.docs.mode],
          )
        ).rows[0],
    );
    return r
      ? {
          state: r.state as SubmissionState,
          uuid: r.uuid as string,
          qr: (r.qr as string | null) ?? null,
        }
      : { state: 'not_generated', uuid: null, qr: null };
  }

  /** Status of many invoices at once (invoice lists): one query. */
  async statusOfMany(
    orgId: string,
    invoiceIds: string[],
  ): Promise<Map<string, InvoiceZatcaStatus>> {
    const out = new Map<string, InvoiceZatcaStatus>();
    if (this.docs.mode === 'off' || invoiceIds.length === 0) return out;
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT d.source_id, d.uuid, d.qr, (SELECT state FROM invoicing.zatca_submissions x WHERE x.document_id = d.id ORDER BY seq DESC LIMIT 1) AS state
             FROM invoicing.zatca_documents d WHERE d.org_id = $1 AND d.source_type = 'invoice' AND d.source_id = ANY($2::uuid[]) AND d.environment = $3`,
            [orgId, invoiceIds, this.docs.mode],
          )
        ).rows as Row[],
    );
    for (const r of rows)
      out.set(r.source_id as string, {
        state: r.state as SubmissionState,
        uuid: r.uuid as string,
        qr: (r.qr as string | null) ?? null,
      });
    return out;
  }

  /** Standard tax invoices (B2B) are delivered only after clearance when e-invoicing is on; simplified ones are not held. */
  async assertDeliverable(
    orgId: string,
    invoice: { id: string; buyer: { buyerType?: unknown; vatNumber?: string | null } },
  ): Promise<void> {
    if (this.docs.mode === 'off') return;
    if (subtypeOf(invoice.buyer.buyerType, invoice.buyer.vatNumber ?? null) === 'simplified')
      return;
    const s = await this.statusOf(orgId, 'invoice', invoice.id);
    if (s.state !== 'cleared')
      throw new ProblemException(
        'conflict',
        'a standard tax invoice is delivered only after clearance',
      );
  }

  /** The stored e-invoice XML: the cleared XML of a standard invoice, the stamped XML of a simplified one. 409 when there is none to give yet. */
  async xmlFor(orgId: string, invoiceId: string): Promise<string> {
    if (this.docs.mode === 'off')
      throw new ProblemException('conflict', 'e-invoicing is not enabled');
    const d = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT subtype, xml_final, cleared_xml FROM invoicing.zatca_documents WHERE org_id = $1 AND source_type = 'invoice' AND source_id = $2 AND environment = $3`,
            [orgId, invoiceId, this.docs.mode],
          )
        ).rows[0],
    );
    if (!d)
      throw new ProblemException(
        'conflict',
        'the e-invoice XML has not been generated for this invoice',
      );
    if (d.subtype === 'standard') {
      if (!d.cleared_xml)
        throw new ProblemException('conflict', 'the e-invoice has not been cleared yet');
      return d.cleared_xml as string;
    }
    if (!d.xml_final)
      throw new ProblemException('conflict', 'the e-invoice has not been stamped yet');
    return d.xml_final as string;
  }
}
