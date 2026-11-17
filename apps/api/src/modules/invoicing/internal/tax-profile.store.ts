import { isSealed, type FieldCipher } from '../../../common/field-crypto';

/** The personal part of a tax profile: what is sealed into `invoicing.tax_profiles.pii_enc`. */
export interface ProfilePii {
  legalName: { ar: string; en: string };
  vatNumber: string | null;
  crNumber: string | null;
  address: Record<string, string>;
}
export const PII_COLUMN = 'invoicing.tax_profiles.pii_enc';
type Row = Record<string, unknown>;

export const sealProfile = (cipher: FieldCipher, orgId: string, pii: ProfilePii): Promise<string> =>
  cipher.encryptJson(pii, { column: PII_COLUMN, row: orgId });

/**
 * The personal part of a stored profile row: opened from `pii_enc`, or read from the legacy plaintext columns of a row written before S13d (until the
 * backfill has sealed it). A sealed row without a cipher is an error, never a silent blank.
 */
export async function openProfile(cipher: FieldCipher | undefined, row: Row): Promise<ProfilePii> {
  const sealed = row.pii_enc;
  if (sealed === null || sealed === undefined) {
    return {
      legalName: { ar: row.legal_name_ar as string, en: row.legal_name_en as string },
      vatNumber: (row.vat_number as string | null) ?? null,
      crNumber: (row.cr_number as string | null) ?? null,
      address: (row.address as Record<string, string> | null) ?? {},
    };
  }
  if (!cipher || !isSealed(sealed)) throw new Error('a sealed tax profile needs the field cipher');
  return cipher.decryptJson<ProfilePii>(sealed, { column: PII_COLUMN, row: row.org_id as string });
}
