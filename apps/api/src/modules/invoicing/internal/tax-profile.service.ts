import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { FieldCipher } from '../../../common/field-crypto';
import { parseTaxProfile, type ProfileRules, type TaxProfileInput } from './tax-profile.rules';
import { openProfile, sealProfile } from './tax-profile.store';

export interface TaxProfileDto extends TaxProfileInput {
  version: number;
  updatedAt: string;
}
type Row = Record<string, unknown>;
const dto = async (r: Row, cipher: FieldCipher | undefined): Promise<TaxProfileDto> => {
  const pii = await openProfile(cipher, r);
  return {
    buyerType: r.buyer_type as 'b2b' | 'b2c',
    legalName: pii.legalName,
    vatNumber: pii.vatNumber,
    crNumber: pii.crNumber,
    address: pii.address as TaxProfileDto['address'],
    version: r.version as number,
    updatedAt: (r.updated_at as Date).toISOString(),
  };
};

/** The organization's invoicing identity (classified financial + personal). One row per organization; replace with If-Match. */
export class TaxProfileService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly rules: ProfileRules,
    /** Seals the personal part (M04 S13d). Optional only for unit contexts without a database. */
    private readonly cipher?: FieldCipher,
  ) {}

  async get(orgId: string): Promise<TaxProfileDto> {
    return this.db.withOrg(orgId, async (c) => {
      const r = (await c.query(`SELECT * FROM invoicing.tax_profiles WHERE org_id = $1`, [orgId]))
        .rows[0];
      if (!r)
        throw new ProblemException(
          'not_found',
          'no tax profile has been set for this organization',
        );
      return dto(r, this.cipher);
    });
  }

  /** Create (no precondition) or replace (needs the current version → 428/412). */
  async put(
    orgId: string,
    actorUserId: string,
    raw: Record<string, unknown>,
    expectedVersion: number | null,
  ): Promise<TaxProfileDto> {
    const p = parseTaxProfile(raw, this.rules);
    return this.db.withOrg(orgId, async (c) => {
      const existing = (
        await c.query(`SELECT * FROM invoicing.tax_profiles WHERE org_id = $1 FOR UPDATE`, [orgId])
      ).rows[0];
      if (existing) {
        if (expectedVersion === null)
          throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
        if (existing.version !== expectedVersion)
          throw new ProblemException('precondition_failed', 'the tax profile changed; reload it');
      }
      if (!this.cipher) throw new Error('the tax profile needs the field cipher to be written');
      const sealed = await sealProfile(this.cipher, orgId, {
        legalName: p.legalName,
        vatNumber: p.vatNumber,
        crNumber: p.crNumber,
        address: p.address as Record<string, string>,
      });
      // the personal values exist only inside `pii_enc`: the plaintext columns are NULL (database check)
      const row = (
        existing
          ? await c.query(
              `UPDATE invoicing.tax_profiles SET buyer_type=$2, pii_enc=$3, legal_name_ar=NULL, legal_name_en=NULL, vat_number=NULL, cr_number=NULL, address=NULL,
                      version = version + 1, updated_by=$4, updated_at=now() WHERE org_id=$1 RETURNING *`,
              [orgId, p.buyerType, sealed, actorUserId],
            )
          : await c.query(
              `INSERT INTO invoicing.tax_profiles (org_id, buyer_type, pii_enc, updated_by) VALUES ($1,$2,$3,$4) RETURNING *`,
              [orgId, p.buyerType, sealed, actorUserId],
            )
      ).rows[0]!;
      // the audit row names WHICH fields changed, never the personal values themselves
      await this.audit.record({
        action: existing ? 'invoicing.tax_profile.updated' : 'invoicing.tax_profile.created',
        actorUserId,
        orgId,
        resource: { type: 'tax_profile', id: orgId },
        outcome: 'success',
        after: {
          buyerType: p.buyerType,
          hasVatNumber: p.vatNumber !== null,
          hasCrNumber: p.crNumber !== null,
          version: row.version,
        },
      });
      return dto(row, this.cipher);
    });
  }
}
