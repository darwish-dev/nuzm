import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../../common/pagination';

type Row = Record<string, unknown>;
const TYPES = ['automated', 'document', 'attestation', 'external-report'] as const;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

export interface EvidenceDto {
  id: string;
  controlId: string;
  type: (typeof TYPES)[number];
  source: string;
  contentHash: string;
  collectedAt: string;
  collector: string | null;
  collectorVersion: string | null;
  documentRef: string | null;
  attestedBy: string | null;
  note: string | null;
  summary: Record<string, unknown>;
}
const dto = (r: Row): EvidenceDto => ({
  id: r.id as string,
  controlId: r.control_id as string,
  type: r.type as EvidenceDto['type'],
  source: r.source as string,
  contentHash: r.content_hash as string,
  collectedAt: iso(r.collected_at)!,
  collector: (r.collector as string | null) ?? null,
  collectorVersion: (r.collector_version as string | null) ?? null,
  documentRef: (r.document_ref as string | null) ?? null,
  attestedBy: (r.attested_by as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  summary: r.summary as Record<string, unknown>,
});

/**
 * Evidence (M04 §4 task 13). Items are immutable. People add MANUAL evidence (a document, an attestation, an external report); the caller is the named
 * human who attests (a different `attestedBy` is refused). AUTOMATED evidence is written only by the collectors under the admin role: this API refuses
 * the type, and the database refuses it for the runtime role.
 */
export class EvidenceService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(q: {
    controlId?: string;
    type?: string;
    collector?: string;
    limit: number;
    cursor?: unknown;
  }): Promise<Page<EvidenceDto>> {
    if (q.type !== undefined && !(TYPES as readonly string[]).includes(q.type))
      throw new ProblemException('validation_failed', `type must be one of ${TYPES.join(', ')}`);
    const cursor = decodeCursor(q.cursor);
    return this.db.withPlatformScope(async (c) => {
      const args: unknown[] = [];
      const where: string[] = [];
      if (q.controlId) where.push(`control_id = $${args.push(q.controlId)}`);
      if (q.type) where.push(`type = $${args.push(q.type)}`);
      if (q.collector) where.push(`collector = $${args.push(q.collector)}`);
      if (cursor) where.push(`id < $${args.push(cursor)}`);
      const rows = (
        await c.query(
          `SELECT * FROM compliance.evidence_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${q.limit + 1}`,
          args,
        )
      ).rows;
      return pageOf(rows.map(dto), q.limit);
    });
  }

  async addManual(
    actor: string,
    actorRole: string | null,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ evidence: EvidenceDto; created: boolean }> {
    const errors: { field: string; message: string }[] = [];
    const bad = (field: string, message: string) => errors.push({ field, message });
    const type = body.type;
    if (type === 'automated')
      throw new ProblemException(
        'forbidden',
        'automated evidence is written by the collectors only; add a document, an attestation or an external report',
      );
    if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type))
      bad('type', 'must be document, attestation or external-report');
    const controlId = body.controlId;
    if (typeof controlId !== 'string' || !/^CTL-[A-Z]{2,6}-[0-9]{3}$/.test(controlId))
      bad('controlId', 'must be a control id');
    const opt = (k: string, lo: number, hi: number) => {
      const v = body[k];
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string' || v.trim().length < lo || v.trim().length > hi) {
        bad(k, `must be ${lo}..${hi} characters`);
        return null;
      }
      return v.trim();
    };
    const documentRef = opt('documentRef', 3, 300);
    const note = opt('note', 1, 1000);
    if ((type === 'document' || type === 'external-report') && !documentRef)
      bad('documentRef', `is required for ${type as string} evidence`);
    if (type === 'attestation' && !note) bad('note', 'state what is attested');
    if (body.attestedBy !== undefined && body.attestedBy !== actor)
      bad(
        'attestedBy',
        'is the signed-in person; a different person cannot be named: leave it out',
      );
    if (errors.length) throw new ProblemException('validation_failed', 'invalid evidence', errors);
    const hash = createHash('sha256')
      .update(JSON.stringify({ controlId, type, documentRef, note, attestedBy: actor }))
      .digest('hex');
    return this.db.withPlatformScope(async (c) => {
      if (
        !(
          await c.query(`SELECT 1 FROM compliance.control_catalog WHERE control_id = $1`, [
            controlId,
          ])
        ).rowCount
      )
        throw new ProblemException('not_found', 'control not found');
      const replay = (
        await c.query(
          `SELECT * FROM compliance.evidence_items WHERE attested_by = $1 AND idempotency_key = $2`,
          [actor, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.content_hash !== hash)
          throw new ProblemException(
            'idempotency_key_reuse',
            'this Idempotency-Key was used with different evidence',
          );
        return { evidence: dto(replay), created: false };
      }
      const id = uuidv7();
      const row = (
        await c.query(
          `INSERT INTO compliance.evidence_items (id, control_id, type, source, content_hash, document_ref, attested_by, note, summary, idempotency_key)
           VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
          [
            id,
            controlId,
            type,
            hash,
            documentRef,
            actor,
            note,
            JSON.stringify({ attesterRole: actorRole }),
            key,
          ],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.evidence.added',
        actorUserId: actor,
        resource: { type: 'evidence_item', id },
        outcome: 'success',
        after: { controlId, type, hasDocument: documentRef !== null },
      });
      return { evidence: dto(row), created: true };
    });
  }
}
