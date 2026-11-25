import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { iso, UUID, type Row } from '../common';
import { isSupportedOs, parseOsImage, type ConfigSource } from './policy';

/**
 * Administrator-approved images for HestiaCP (S04): "only images verified for Hestia are offered". An image becomes approvable only when the provider's own listing
 * states cloud-init for it AND its operating system is one Hestia documents as supported; the approval records WHO approved it, for which Hestia version, and with what
 * evidence (`live` only after a real install on that provider; `fixture`/`mock` are labelled as such and never shown as verified live).
 */
export class PanelImageService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly config: ConfigSource,
  ) {}

  async list(q: { accountId?: string; regionId?: string } = {}) {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT i.id, i.account_id, i.provider_region_id, i.image_ref, i.name, i.cloud_init,
                    a.id AS approval_id, a.panel_version, a.os_id, a.os_version, a.evidence_kind, a.evidence_note, a.approved_at, a.revoked_at
               FROM compute.images i
          LEFT JOIN compute.panel_image_approvals a
                 ON a.account_id = i.account_id AND a.provider_region_id = i.provider_region_id AND a.image_ref = i.image_ref AND a.panel_kind = 'hestia'
              WHERE ($1::uuid IS NULL OR i.account_id = $1) AND ($2::text IS NULL OR i.provider_region_id = $2)
              ORDER BY i.provider_region_id, i.name, a.approved_at DESC LIMIT 500`,
            [q.accountId ?? null, q.regionId ?? null],
          )
        ).rows as Row[],
    );
    return rows.map((r) => {
      const os = parseOsImage(r.name as string);
      return {
        imageId: r.id as string,
        accountId: r.account_id as string,
        providerRegionId: r.provider_region_id as string,
        name: r.name as string,
        cloudInit: (r.cloud_init as boolean | null) ?? null,
        os: os
          ? {
              id: os.osId,
              version: os.osVersion,
              supportedByHestia: isSupportedOs(os.osId, os.osVersion),
            }
          : null,
        approval: r.approval_id
          ? {
              id: r.approval_id as string,
              panelVersion: r.panel_version as string,
              evidenceKind: r.evidence_kind as string,
              evidenceNote: r.evidence_note as string,
              approvedAt: iso(r.approved_at)!,
              revoked: !!r.revoked_at,
            }
          : null,
      };
    });
  }

  async approve(actor: string, imageId: string, body: unknown) {
    if (!UUID.test(imageId)) throw new ProblemException('not_found', 'image not found');
    const b = (body ?? {}) as { evidenceKind?: unknown; evidenceNote?: unknown };
    if (!['live', 'fixture', 'mock'].includes(b.evidenceKind as string))
      throw new ProblemException('validation_failed', 'evidenceKind must be live, fixture or mock');
    if (
      typeof b.evidenceNote !== 'string' ||
      b.evidenceNote.trim().length < 3 ||
      b.evidenceNote.length > 500
    )
      throw new ProblemException(
        'validation_failed',
        'evidenceNote is required (3..500 characters)',
      );
    const note = b.evidenceNote.trim();
    const evidenceKind = b.evidenceKind as string;
    if (b.evidenceKind === 'mock' && process.env.NODE_ENV === 'production')
      throw new ProblemException(
        'validation_failed',
        'a mock approval is not accepted in production',
      );
    const cfg = this.config.get();
    if (!cfg)
      throw new ProblemException(
        'unsupported_capability',
        'the Hestia VPS product is not configured',
      );
    return this.db.withPlatformScope(async (c) => {
      const im = (await c.query(`SELECT * FROM compute.images WHERE id = $1`, [imageId]))
        .rows[0] as Row | undefined;
      if (!im) throw new ProblemException('not_found', 'image not found');
      if (im.cloud_init !== true)
        throw new ProblemException(
          'validation_failed',
          'the provider does not state cloud-init support for this image',
        );
      const os = parseOsImage(im.name as string);
      if (!os || !isSupportedOs(os.osId, os.osVersion))
        throw new ProblemException(
          'validation_failed',
          'HestiaCP does not document this operating system as supported',
        );
      const id = uuidv7();
      const r = await c.query(
        `INSERT INTO compute.panel_image_approvals (id, account_id, provider_region_id, image_ref, panel_kind, panel_version, os_id, os_version, evidence_kind, evidence_note, approved_by)
         VALUES ($1,$2,$3,$4,'hestia',$5,$6,$7,$8,$9,$10)
         ON CONFLICT (account_id, provider_region_id, image_ref, panel_kind, panel_version)
         DO UPDATE SET revoked_at = NULL, evidence_kind = EXCLUDED.evidence_kind, evidence_note = EXCLUDED.evidence_note, approved_by = EXCLUDED.approved_by, approved_at = now()
         RETURNING id`,
        [
          id,
          im.account_id,
          im.provider_region_id,
          im.image_ref,
          cfg.panelVersion,
          os.osId,
          os.osVersion,
          evidenceKind,
          note,
          actor,
        ],
      );
      await this.audit.record({
        action: 'compute.panel_image.approved',
        actorUserId: actor,
        actorType: 'user',
        resource: { type: 'compute_image', id: imageId },
        outcome: 'success',
        detail: { panelVersion: cfg.panelVersion, evidenceKind: b.evidenceKind },
      });
      return { approvalId: r.rows[0]!.id as string };
    });
  }

  async revoke(actor: string, approvalId: string) {
    if (!UUID.test(approvalId)) throw new ProblemException('not_found', 'approval not found');
    await this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `UPDATE compute.panel_image_approvals SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
        [approvalId],
      );
      if (!r.rowCount) throw new ProblemException('not_found', 'approval not found');
    });
    await this.audit.record({
      action: 'compute.panel_image.revoked',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'compute_image_approval', id: approvalId },
      outcome: 'success',
    });
  }
}
