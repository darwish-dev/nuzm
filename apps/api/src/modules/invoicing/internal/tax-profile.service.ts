import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { parseTaxProfile, type ProfileRules, type TaxProfileInput } from './tax-profile.rules';

export interface TaxProfileDto extends TaxProfileInput {
  version: number;
  updatedAt: string;
}
type Row = Record<string, unknown>;
const dto = (r: Row): TaxProfileDto => ({
  buyerType: r.buyer_type as 'b2b' | 'b2c',
  legalName: { ar: r.legal_name_ar as string, en: r.legal_name_en as string },
  vatNumber: (r.vat_number as string | null) ?? null,
  crNumber: (r.cr_number as string | null) ?? null,
  address: r.address as TaxProfileDto['address'],
  version: r.version as number,
  updatedAt: (r.updated_at as Date).toISOString(),
});

/** The organization's invoicing identity (classified financial + personal). One row per organization; replace with If-Match. */
export class TaxProfileService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly rules: ProfileRules,
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
      return dto(r);
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
      const row = (
        existing
          ? await c.query(
              `UPDATE invoicing.tax_profiles SET buyer_type=$2, legal_name_ar=$3, legal_name_en=$4, vat_number=$5, cr_number=$6, address=$7,
                      version = version + 1, updated_by=$8, updated_at=now() WHERE org_id=$1 RETURNING *`,
              [
                orgId,
                p.buyerType,
                p.legalName.ar,
                p.legalName.en,
                p.vatNumber,
                p.crNumber,
                JSON.stringify(p.address),
                actorUserId,
              ],
            )
          : await c.query(
              `INSERT INTO invoicing.tax_profiles (org_id, buyer_type, legal_name_ar, legal_name_en, vat_number, cr_number, address, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
              [
                orgId,
                p.buyerType,
                p.legalName.ar,
                p.legalName.en,
                p.vatNumber,
                p.crNumber,
                JSON.stringify(p.address),
                actorUserId,
              ],
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
      return dto(row);
    });
  }
}
