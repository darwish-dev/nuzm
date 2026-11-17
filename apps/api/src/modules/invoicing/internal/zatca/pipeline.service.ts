import type { Db } from '@nuzm/platform';
import type { KeyVault } from './signing';
import type { ZatcaSubmissionService } from './submission.service';
import type { ZatcaDocumentService } from './zatca-document.service';

export interface PipelineResult {
  generated: number;
  stamped: number;
  queued: number;
  waitingForCredentials: number;
  submitted: {
    cleared: number;
    reported: number;
    rejected: number;
    failed: number;
    deadLetters: number;
    skipped: number;
  };
  failed: number;
}

/**
 * One pass of the e-invoicing jobs (called by the billing scheduler): generate documents for newly issued invoices and credit notes (only from the
 * configured cutover date: nothing older is ever picked up, and with no cutover date nothing is generated automatically), stamp them once credentials
 * exist, queue them, and submit what is due. Every step is idempotent and isolated per document.
 */
export class ZatcaPipelineService {
  constructor(
    private readonly db: Db,
    private readonly docs: ZatcaDocumentService,
    private readonly submissions: ZatcaSubmissionService,
    private readonly vault: KeyVault,
    private readonly generateFrom: Date | null,
    private readonly batch = 50,
  ) {}

  static generateFromEnv(env: NodeJS.ProcessEnv = process.env): Date | null {
    if (!env.ZATCA_GENERATE_FROM) return null;
    const d = new Date(env.ZATCA_GENERATE_FROM);
    if (Number.isNaN(d.getTime()))
      throw new Error('ZATCA_GENERATE_FROM must be an ISO-8601 timestamp');
    return d;
  }

  async run(now = new Date()): Promise<PipelineResult> {
    const out: PipelineResult = {
      generated: 0,
      stamped: 0,
      queued: 0,
      waitingForCredentials: 0,
      submitted: { cleared: 0, reported: 0, rejected: 0, failed: 0, deadLetters: 0, skipped: 0 },
      failed: 0,
    };
    if (this.docs.mode === 'off') return out;
    const env = this.docs.mode;
    if (this.generateFrom) {
      const todo = await this.db.withoutScope(
        async (c) =>
          (
            await c.query<{
              org_id: string;
              source_type: 'invoice' | 'credit_note';
              source_id: string;
            }>(
              `SELECT org_id, source_type, source_id FROM invoicing.zatca_unprocessed($1, $2, $3)`,
              [env, this.generateFrom, this.batch],
            )
          ).rows,
      );
      for (const t of todo) {
        try {
          await this.docs.generate(t.org_id, { type: t.source_type, id: t.source_id }, now);
          out.generated++;
        } catch {
          out.failed++; // e.g. the seller data is incomplete: reported by the count, retried on the next pass
        }
      }
    }
    const generated = await this.db.withoutScope(
      async (c) =>
        (
          await c.query<{ org_id: string; document_id: string }>(
            `SELECT org_id, document_id FROM invoicing.zatca_pending($1, 'generated', $2, $3)`,
            [env, now, this.batch],
          )
        ).rows,
    );
    for (const g of generated) {
      try {
        const entity = (await this.db.withOrg(
          g.org_id,
          async (c) =>
            (
              await c.query<{ entity_id: string }>(
                `SELECT entity_id FROM invoicing.zatca_documents WHERE id = $1`,
                [g.document_id],
              )
            ).rows[0],
        ))!.entity_id;
        const cred = await this.submissions.credentialFor(entity, env);
        if (!cred) {
          out.waitingForCredentials++;
          continue;
        }
        await this.docs.stamp(g.org_id, g.document_id, this.vault, cred.keyRef, now);
        out.stamped++;
      } catch {
        out.failed++;
      }
    }
    const stamped = await this.db.withoutScope(
      async (c) =>
        (
          await c.query<{ org_id: string; document_id: string }>(
            `SELECT org_id, document_id FROM invoicing.zatca_pending($1, 'stamped', $2, $3)`,
            [env, now, this.batch],
          )
        ).rows,
    );
    for (const s of stamped) {
      try {
        if (await this.submissions.enqueue(s.org_id, s.document_id, now)) out.queued++;
      } catch {
        out.failed++;
      }
    }
    out.submitted = await this.submissions.processDue(now, this.batch);
    return out;
  }
}
