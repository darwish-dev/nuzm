import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { PurposeCatalog } from './purposes';
import { UUID } from '@nuzm/domain';

export interface ConsentDto {
  id: string;
  purposeId: string;
  subjectRef: string;
  state: 'granted' | 'withdrawn';
  textVersion: string;
  locale: 'ar' | 'en';
  source: 'api' | 'ui';
  withdrawsId: string | null;
  createdAt: string;
}
export interface Caller {
  userId: string;
  /** `privacy:consent:manage`: may act for the organization and its end users, and read every consent of the organization. */
  canManage: boolean;
  via: 'session' | 'api_key';
}
type Row = Record<string, unknown>;
const dto = (r: Row): ConsentDto => ({
  id: r.id as string,
  purposeId: r.purpose_id as string,
  subjectRef: r.subject_ref as string,
  state: r.state as ConsentDto['state'],
  textVersion: r.text_version as string,
  locale: r.locale as ConsentDto['locale'],
  source: r.source as ConsentDto['source'],
  withdrawsId: (r.withdraws_id as string | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(),
});

const SUBJECT = /^[A-Za-z0-9:_.-]{1,128}$/;

/** The subject reference of a member acting for themselves (an opaque id: never an email or a name). */
export const selfRef = (userId: string) => `member:${userId}`;
/** The organization itself as the subject of a consent. */
export const ORG_SUBJECT = 'org';

/**
 * Consent (M04 §4 task 3). The history is APPEND-ONLY: a grant or a withdrawal is a new row, and the current state of (organization, subject,
 * purpose) is the row with the highest `seq`. `seq` is allocated under an advisory lock inside the writing transaction, so concurrent grants and
 * withdrawals have one total order and `isAllowed` (a read of the latest row, committed data only) never returns a stale answer after a
 * withdrawal has returned. Purposes come from spec/compliance/purposes.yaml, not from a table.
 */
export class ConsentService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly purposes: PurposeCatalog,
  ) {}

  /** The catalogue as shown to the person (wording is a COUNSEL-TEXT-REQUIRED placeholder until HG-04-01). */
  catalog() {
    return {
      version: this.purposes.version,
      status: this.purposes.status,
      items: this.purposes.purposes.map((p) => ({
        id: p.id,
        category: p.category,
        textVersion: p.textVersion,
        label: p.label,
        text: p.text,
        pendingCounsel: p.pendingCounsel,
      })),
    };
  }

  private subjectOf(caller: Caller, requested: unknown): string {
    const self = selfRef(caller.userId);
    if (requested === undefined || requested === null || requested === '') return self;
    if (typeof requested !== 'string' || !SUBJECT.test(requested))
      throw new ProblemException(
        'validation_failed',
        'subjectRef must be an opaque id (letters, digits, : _ . -)',
      );
    if (requested !== self && !caller.canManage)
      throw new ProblemException(
        'forbidden',
        'only an organization administrator can act for another subject',
      );
    return requested;
  }

  /** Grant. Granting again with the same text while already granted returns the existing record and writes nothing. */
  async grant(orgId: string, caller: Caller, body: Record<string, unknown>) {
    const purposeId = body.purposeId;
    if (typeof purposeId !== 'string' || purposeId === '')
      throw new ProblemException('validation_failed', 'purposeId is required');
    if (body.granted !== true)
      throw new ProblemException(
        'validation_failed',
        'granted must be true; withdraw a consent with DELETE /v1/compliance/consents/{id}',
      );
    const purpose = this.purposes.byId.get(purposeId);
    if (!purpose)
      throw new ProblemException(
        'consent_purpose_unknown',
        `no purpose "${purposeId.slice(0, 80)}"`,
      );
    const locale = body.localeShown;
    if (locale !== 'ar' && locale !== 'en')
      throw new ProblemException('validation_failed', "localeShown must be 'ar' or 'en'");
    if (body.textVersion !== purpose.textVersion)
      throw new ProblemException(
        'validation_failed',
        `textVersion must be the current wording of this purpose (${purpose.textVersion}): show the current text before recording consent`,
      );
    const subject = this.subjectOf(caller, body.subjectRef);
    const source = caller.via === 'api_key' ? 'api' : 'ui';
    const result = await this.db.withOrg(orgId, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `consent:${orgId}:${subject}:${purposeId}`,
      ]);
      const last = (
        await c.query(
          `SELECT * FROM compliance.consents WHERE org_id = $1 AND subject_ref = $2 AND purpose_id = $3 ORDER BY seq DESC LIMIT 1`,
          [orgId, subject, purposeId],
        )
      ).rows[0];
      if (last && last.state === 'granted' && last.text_version === purpose.textVersion)
        return { row: last, created: false };
      const row = (
        await c.query(
          `INSERT INTO compliance.consents (id, org_id, subject_ref, purpose_id, state, seq, text_version, locale, source, created_by)
           VALUES ($1,$2,$3,$4,'granted',$5,$6,$7,$8,$9) RETURNING *`,
          [
            uuidv7(),
            orgId,
            subject,
            purposeId,
            last ? Number(last.seq) + 1 : 1,
            purpose.textVersion,
            locale,
            source,
            caller.userId,
          ],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.consent.granted',
        actorUserId: caller.userId,
        orgId,
        resource: { type: 'consent', id: row.id as string },
        outcome: 'success',
        after: { purposeId, subjectRef: subject, textVersion: purpose.textVersion, locale },
      });
      return { row, created: true };
    });
    return { consent: dto(result.row), created: result.created };
  }

  /**
   * Withdraw the CURRENT consent of the subject and purpose of the named record. Effective for the next `isAllowed`. Withdrawing something
   * already withdrawn is a no-op. 404 for an unknown id (also for another organization's: RLS).
   */
  async withdraw(orgId: string, caller: Caller, id: string): Promise<void> {
    if (!UUID.test(id)) throw new ProblemException('not_found', 'consent not found');
    await this.db.withOrg(orgId, async (c) => {
      const named = (await c.query(`SELECT * FROM compliance.consents WHERE id = $1`, [id]))
        .rows[0];
      if (!named) throw new ProblemException('not_found', 'consent not found');
      if (named.subject_ref !== selfRef(caller.userId) && !caller.canManage)
        throw new ProblemException('not_found', 'consent not found'); // existence is not revealed to members who cannot see it
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `consent:${orgId}:${named.subject_ref}:${named.purpose_id}`,
      ]);
      const last = (
        await c.query(
          `SELECT * FROM compliance.consents WHERE org_id = $1 AND subject_ref = $2 AND purpose_id = $3 ORDER BY seq DESC LIMIT 1`,
          [orgId, named.subject_ref, named.purpose_id],
        )
      ).rows[0]!;
      if (last.state === 'withdrawn') return; // already withdrawn
      const row = (
        await c.query(
          `INSERT INTO compliance.consents (id, org_id, subject_ref, purpose_id, state, seq, text_version, locale, source, withdraws_id, created_by)
           VALUES ($1,$2,$3,$4,'withdrawn',$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            uuidv7(),
            orgId,
            last.subject_ref,
            last.purpose_id,
            Number(last.seq) + 1,
            last.text_version,
            last.locale,
            caller.via === 'api_key' ? 'api' : 'ui',
            last.id,
            caller.userId,
          ],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.consent.withdrawn',
        actorUserId: caller.userId,
        orgId,
        resource: { type: 'consent', id: row.id as string },
        outcome: 'success',
        after: { purposeId: last.purpose_id, subjectRef: last.subject_ref, withdrawsId: last.id },
      });
    });
  }

  /**
   * The current consent per (subject, purpose); `history: true` returns every row. Members without `privacy:consent:manage` see only their own
   * subject. `status` filters on the CURRENT state.
   */
  async list(
    orgId: string,
    caller: Caller,
    q: {
      purposeId?: string;
      subject?: string;
      status?: string;
      history?: boolean;
      limit: number;
      cursor?: unknown;
    },
  ): Promise<Page<ConsentDto>> {
    if (q.status !== undefined && q.status !== 'granted' && q.status !== 'withdrawn')
      throw new ProblemException('validation_failed', "status must be 'granted' or 'withdrawn'");
    const self = selfRef(caller.userId);
    let subject = q.subject;
    if (subject !== undefined && !SUBJECT.test(subject))
      throw new ProblemException('validation_failed', 'subject must be an opaque id');
    if (!caller.canManage) {
      if (subject !== undefined && subject !== self)
        throw new ProblemException('forbidden', 'members can read only their own consents');
      subject = self;
    }
    const cursor = decodeCursor(q.cursor);
    return this.db.withOrg(orgId, async (c) => {
      const args: unknown[] = [orgId];
      const where: string[] = ['org_id = $1'];
      if (subject !== undefined) where.push(`subject_ref = $${args.push(subject)}`);
      if (q.purposeId !== undefined) where.push(`purpose_id = $${args.push(q.purposeId)}`);
      const inner = q.history
        ? `SELECT * FROM compliance.consents WHERE ${where.join(' AND ')}`
        : `SELECT DISTINCT ON (subject_ref, purpose_id) * FROM compliance.consents WHERE ${where.join(' AND ')} ORDER BY subject_ref, purpose_id, seq DESC`;
      const outer: string[] = [];
      if (q.status !== undefined && !q.history) outer.push(`state = $${args.push(q.status)}`);
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

  /**
   * The question other modules ask before they act on consent. True only while the latest record of (subject, purpose) is a grant.
   * Fail-closed: an unknown purpose or a malformed subject is `false`.
   */
  async isAllowed(orgId: string, subjectRef: string, purposeId: string): Promise<boolean> {
    if (!this.purposes.byId.has(purposeId) || !SUBJECT.test(subjectRef)) return false;
    return this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `SELECT state FROM compliance.consents WHERE org_id = $1 AND subject_ref = $2 AND purpose_id = $3 ORDER BY seq DESC LIMIT 1`,
          [orgId, subjectRef, purposeId],
        )
      ).rows[0];
      return r?.state === 'granted';
    });
  }
}
