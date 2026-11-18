import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { badRequest, isUuid, iso, type Row } from './model';

export interface ModerationDecision {
  listingId: string;
  versionId: string;
  decision: 'approve' | 'reject' | 'suspend';
  versionStatus: string;
  listingStatus: string;
}

/**
 * The human decision (M11 S53.2). `approve` makes a PENDING version purchasable (and publishes the listing); `reject` refuses a pending version; `suspend` takes an APPROVED version
 * down and suspends the listing (it disappears from browse and no new purchase or install is possible; installs already performed stay with their buyers). A decision on a version that is
 * no longer in the state the decision needs is `409` stale (two moderators, a replayed click), and an optional `If-Match` carries the case's version. A version flagged by the automated scans
 * can be approved only with the reason code `scan_override` (recorded, audited).
 */
export class ModerationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async decide(adminUserId: string, listingId: string, body: Record<string, unknown>, ifMatch: number | null): Promise<ModerationDecision> {
    for (const k of Object.keys(body)) if (!['decision', 'reasonCode', 'notes', 'versionId'].includes(k)) throw badRequest(`unknown field ${k}`);
    if (!isUuid(listingId)) throw new ProblemException('not_found');
    if (!['approve', 'reject', 'suspend'].includes(body.decision as string)) throw badRequest('decision must be approve, reject or suspend');
    const decision = body.decision as ModerationDecision['decision'];
    if (typeof body.reasonCode !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(body.reasonCode)) throw badRequest('reasonCode must be a snake_case code');
    if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 4000)) throw badRequest('notes must be at most 4000 characters');
    if (body.versionId !== undefined && !isUuid(body.versionId)) throw badRequest('versionId must be a uuid');
    const reason = body.reasonCode as string;
    const out = await this.db.withPlatformScope(async (c) => {
      const l = (await c.query(`SELECT * FROM marketplace.listings WHERE id = $1 FOR UPDATE`, [listingId])).rows[0] as Row | undefined;
      if (!l) throw new ProblemException('not_found');
      // the version the decision is about: the one named, else the newest version in the state the decision needs
      const need = decision === 'suspend' ? 'approved' : 'pending';
      const v = (
        await c.query(
          body.versionId
            ? `SELECT * FROM marketplace.listing_versions WHERE id = $1 AND listing_id = $2 FOR UPDATE`
            : `SELECT * FROM marketplace.listing_versions WHERE listing_id = $1 AND moderation_status = $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          body.versionId ? [body.versionId, listingId] : [listingId, need],
        )
      ).rows[0] as Row | undefined;
      if (!v) {
        if (body.versionId) throw new ProblemException('not_found');
        throw new ProblemException('conflict', `the listing has no ${need} version to ${decision}`);
      }
      const kase = (await c.query(`SELECT * FROM marketplace.moderation_cases WHERE listing_version_id = $1 FOR UPDATE`, [v.id])).rows[0] as Row;
      if (ifMatch !== null && ifMatch !== kase.version_lock) throw new ProblemException('conflict', 'stale decision: the case changed since you read it');
      if (v.moderation_status !== need) throw new ProblemException('conflict', `stale decision: the version is already ${v.moderation_status}`);
      if (decision === 'approve' && kase.scan_verdict === 'flagged' && reason !== 'scan_override')
        throw new ProblemException('validation_failed', 'the automated scans flagged this version: approve it only with reasonCode scan_override after reading the findings');
      const vs = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'suspended';
      await c.query(`UPDATE marketplace.listing_versions SET moderation_status = $2 WHERE id = $1`, [v.id, vs]);
      await c.query(`UPDATE marketplace.moderation_cases SET decision = $2, reason_code = $3, notes = $4, decided_by = $5, decided_at = now(), version_lock = version_lock + 1 WHERE id = $1`, [kase.id, decision, reason, (body.notes as string | undefined) ?? null, adminUserId]);
      let ls = l.status as string;
      if (decision === 'approve' && ls === 'draft') ls = 'published';
      if (decision === 'suspend') ls = 'suspended';
      if (ls !== l.status) await c.query(`UPDATE marketplace.listings SET status = $2 WHERE id = $1`, [listingId, ls]);
      return { org: l.org_id as string, res: { listingId, versionId: v.id as string, decision, versionStatus: vs, listingStatus: ls } satisfies ModerationDecision, at: iso(new Date()) };
    });
    await this.audit.record({ action: 'listing.version.moderated', actorUserId: adminUserId, orgId: out.org, resource: { type: 'listing_version', id: out.res.versionId }, outcome: 'success', detail: { listingId, decision, reasonCode: reason } });
    return out.res;
  }
}
