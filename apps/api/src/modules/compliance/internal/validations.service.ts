import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';

type Row = Record<string, unknown>;
const STATUSES = ['open', 'answered', 'validated', 'rejected'] as const;
const APPLICABILITY = ['to_confirm', 'applicable', 'not_applicable'] as const;
const KEY = /^[a-z][a-z0-9-]{2,60}$/;
export type ValidationStatus = (typeof STATUSES)[number];

export interface ValidationDto {
  id: string;
  validationKey: string;
  version: number;
  regime: string;
  question: string;
  applicability: (typeof APPLICABILITY)[number];
  status: ValidationStatus;
  answer: string | null;
  documentRef: string | null;
  validatedBy: string | null;
  validatedAt: string | null;
  changeNote: string | null;
  createdBy: string | null;
  createdAt: string;
}
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
const dto = (r: Row): ValidationDto => ({
  id: r.id as string,
  validationKey: r.validation_key as string,
  version: r.version as number,
  regime: r.regime as string,
  question: r.question as string,
  applicability: r.applicability as ValidationDto['applicability'],
  status: r.status as ValidationStatus,
  answer: (r.answer as string | null) ?? null,
  documentRef: (r.document_ref as string | null) ?? null,
  validatedBy: (r.validated_by as string | null) ?? null,
  validatedAt: iso(r.validated_at),
  changeNote: (r.change_note as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: iso(r.created_at)!,
});

/**
 * The regulatory validation register (M04 §4 task 15, docs/10 §7). Versioned and immutable. The platform creates the open questions; people answer
 * them. `validated` is a HUMAN act: it needs a document reference, a decided applicability and the caller recorded as the validator (422
 * `validation_requires_evidence` otherwise), and the database refuses it without them. No automated or agent path exists: the admin realm is for people.
 */
export class ValidationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(q: {
    validationKey?: string;
    status?: string;
    applicability?: string;
    history?: boolean;
    limit: number;
    cursor?: unknown;
  }): Promise<Page<ValidationDto>> {
    if (q.status !== undefined && !(STATUSES as readonly string[]).includes(q.status))
      throw new ProblemException(
        'validation_failed',
        `status must be one of ${STATUSES.join(', ')}`,
      );
    if (
      q.applicability !== undefined &&
      !(APPLICABILITY as readonly string[]).includes(q.applicability)
    )
      throw new ProblemException(
        'validation_failed',
        `applicability must be one of ${APPLICABILITY.join(', ')}`,
      );
    if (q.history && !q.validationKey)
      throw new ProblemException('validation_failed', 'history needs a validationKey');
    const cursor = decodeCursor(q.cursor);
    return this.db.withPlatformScope(async (c) => {
      const args: unknown[] = [];
      const where: string[] = [];
      if (q.validationKey) where.push(`validation_key = $${args.push(q.validationKey)}`);
      const inner = q.history
        ? `SELECT * FROM compliance.regulatory_validations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
        : `SELECT DISTINCT ON (validation_key) * FROM compliance.regulatory_validations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY validation_key, version DESC`;
      const outer: string[] = [];
      if (q.status && !q.history) outer.push(`status = $${args.push(q.status)}`);
      if (q.applicability && !q.history)
        outer.push(`applicability = $${args.push(q.applicability)}`);
      if (cursor) outer.push(`id < $${args.push(cursor)}`);
      const rows = (
        await c.query(
          `SELECT * FROM (${inner}) t ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${q.limit + 1}`,
          args,
        )
      ).rows;
      return pageOf(rows.map(dto), q.limit);
    });
  }

  /** Create a question (no baseVersion; regime and question required) or add a version (baseVersion = the current one, else 409). */
  async save(
    actor: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ validation: ValidationDto; created: boolean }> {
    const errors: { field: string; message: string }[] = [];
    const bad = (field: string, message: string) => errors.push({ field, message });
    const vk = body.validationKey;
    if (typeof vk !== 'string' || !KEY.test(vk))
      bad('validationKey', 'must be lowercase words joined by - (3..61 characters)');
    const status = body.status ?? 'open';
    if (!(STATUSES as readonly string[]).includes(status as string))
      bad('status', `must be one of ${STATUSES.join(', ')}`);
    const applicability = body.applicability ?? 'to_confirm';
    if (!(APPLICABILITY as readonly string[]).includes(applicability as string))
      bad('applicability', `must be one of ${APPLICABILITY.join(', ')}`);
    const opt = (k: string, lo: number, hi: number) => {
      const v = body[k];
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string' || v.trim().length < lo || v.trim().length > hi) {
        bad(k, `must be ${lo}..${hi} characters`);
        return null;
      }
      return v.trim();
    };
    const regime = opt('regime', 2, 120);
    const question = opt('question', 10, 800);
    const answer = opt('answer', 1, 2000);
    const documentRef = opt('documentRef', 3, 300);
    const changeNote = opt('changeNote', 1, 500);
    const base = body.baseVersion;
    if (base !== undefined && base !== null && (!Number.isInteger(base) || (base as number) < 1))
      bad('baseVersion', 'must be a positive integer');
    if (body.validatedBy !== undefined && body.validatedBy !== actor)
      bad('validatedBy', 'is recorded from the signed-in person; leave it out');
    if (status === 'answered' && !answer) bad('answer', 'is required to record an answer');
    if (errors.length)
      throw new ProblemException('validation_failed', 'invalid validation', errors);
    const validated = status === 'validated';
    if (validated && (!documentRef || applicability === 'to_confirm'))
      throw new ProblemException(
        'validation_requires_evidence',
        'validated needs a document reference and a decided applicability (applicable or not_applicable); a person records it',
        [
          ...(documentRef ? [] : [{ field: 'documentRef', message: 'is required to validate' }]),
          ...(applicability === 'to_confirm'
            ? [{ field: 'applicability', message: 'must be decided to validate' }]
            : []),
        ],
      );
    return this.db.withPlatformScope(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `validation:${vk as string}`,
      ]);
      const prior = (
        await c.query(
          `SELECT * FROM compliance.regulatory_validations WHERE validation_key = $1 ORDER BY version DESC LIMIT 1`,
          [vk],
        )
      ).rows[0];
      const replay = (
        await c.query(
          `SELECT * FROM compliance.regulatory_validations WHERE validation_key = $1 AND idempotency_key = $2`,
          [vk, key],
        )
      ).rows[0];
      if (replay) {
        const r = dto(replay);
        if (
          r.status !== status ||
          r.applicability !== applicability ||
          r.answer !== answer ||
          r.documentRef !== documentRef
        )
          throw new ProblemException(
            'idempotency_key_reuse',
            'this Idempotency-Key was used with different content',
          );
        return { validation: r, created: false };
      }
      if (prior && base !== prior.version)
        throw new ProblemException(
          'conflict',
          `${vk as string} is at version ${prior.version}; send baseVersion ${prior.version}`,
        );
      if (!prior && base !== undefined && base !== null)
        throw new ProblemException('conflict', 'baseVersion is only for a question that exists');
      if (!prior && (!regime || !question))
        throw new ProblemException(
          'validation_failed',
          'regime and question are required for a new question',
          [
            ...(regime ? [] : [{ field: 'regime', message: 'is required' }]),
            ...(question ? [] : [{ field: 'question', message: 'is required' }]),
          ],
        );
      if (
        prior &&
        ((regime && regime !== prior.regime) || (question && question !== prior.question))
      )
        throw new ProblemException(
          'validation_failed',
          'the regime and the question are fixed once created',
          [{ field: 'regime', message: 'cannot change' }],
        );
      const id = uuidv7();
      const version = prior ? Number(prior.version) + 1 : 1;
      const row = (
        await c.query(
          `INSERT INTO compliance.regulatory_validations (id, validation_key, version, regime, question, applicability, status, answer, document_ref,
                  validated_by, validated_at, change_note, idempotency_key, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [
            id,
            vk,
            version,
            prior?.regime ?? regime,
            prior?.question ?? question,
            applicability,
            status,
            answer,
            documentRef,
            validated ? actor : null,
            validated ? this.clock() : null,
            changeNote,
            key,
            actor,
          ],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.validation.changed',
        actorUserId: actor,
        resource: { type: 'regulatory_validation', id },
        outcome: 'success',
        ...(prior
          ? {
              before: {
                status: prior.status,
                applicability: prior.applicability,
                version: prior.version,
              },
            }
          : {}),
        after: {
          validationKey: vk,
          version,
          status,
          applicability,
          documentRef: documentRef ? 'set' : null,
        },
      });
      return { validation: dto(row), created: true };
    });
  }
}
