import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import type { FieldCipher } from '../../../common/field-crypto';
import { openProfile, sealProfile } from './tax-profile.store';

export interface SealResult {
  /** Profiles that were plaintext (written before S13d) and are now sealed. */
  sealed: number;
  /** Profiles sealed with an older key and now re-sealed with the current one (key rotation). */
  resealed: number;
  /** Plaintext profiles still left after this run (0 = the constraint can be validated). */
  remainingPlaintext: number;
  /** Profiles still sealed with an older key. */
  remainingOldKey: number;
}

/**
 * Seals legacy plaintext tax profiles and re-seals profiles after a key rotation (M04 S13d, contract step of expand/contract). Idempotent and
 * restartable; one organization per transaction under its own context (forced RLS applies), so it works with the application role. It never changes
 * the version or the update time of a profile: the data is the same, only its protection changes.
 * Afterwards the operator runs `ALTER TABLE invoicing.tax_profiles VALIDATE CONSTRAINT tax_profiles_new_rows_sealed` when `remainingPlaintext` is 0.
 */
export class TaxProfileSealer {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
    private readonly audit: AuditSink,
  ) {}

  async run(batch = 200): Promise<SealResult> {
    const current = await this.cipher.currentKeyId();
    const prefix = `enc:v1:${current}:`;
    const todo = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ org_id: string; legacy: boolean }>(
            `SELECT org_id, pii_enc IS NULL AS legacy FROM invoicing.tax_profiles
              WHERE pii_enc IS NULL OR left(pii_enc, $1) <> $2 ORDER BY org_id LIMIT $3`,
            [prefix.length, prefix, batch],
          )
        ).rows,
    );
    let sealed = 0;
    let resealed = 0;
    for (const t of todo) {
      const done = await this.db.withOrg(t.org_id, async (c) => {
        const row = (
          await c.query(`SELECT * FROM invoicing.tax_profiles WHERE org_id = $1 FOR UPDATE`, [
            t.org_id,
          ])
        ).rows[0];
        if (!row) return null;
        const wasLegacy = row.pii_enc === null;
        if (!wasLegacy && String(row.pii_enc).startsWith(prefix)) return null; // sealed with the current key meanwhile
        const pii = await openProfile(this.cipher, row);
        const next = await sealProfile(this.cipher, t.org_id, pii);
        await c.query(
          `UPDATE invoicing.tax_profiles SET pii_enc = $2, legal_name_ar = NULL, legal_name_en = NULL, vat_number = NULL, cr_number = NULL, address = NULL
            WHERE org_id = $1`,
          [t.org_id, next],
        );
        return wasLegacy ? 'sealed' : 'resealed';
      });
      if (done === 'sealed') sealed++;
      else if (done === 'resealed') resealed++;
    }
    const left = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ plain: number; old: number }>(
            `SELECT count(*) FILTER (WHERE pii_enc IS NULL)::int AS plain,
                    count(*) FILTER (WHERE pii_enc IS NOT NULL AND left(pii_enc, $1) <> $2)::int AS old
               FROM invoicing.tax_profiles`,
            [prefix.length, prefix],
          )
        ).rows[0]!,
    );
    if (sealed + resealed > 0)
      await this.audit.record({
        action: 'invoicing.tax_profile.sealed_backfill',
        actorType: 'system',
        resource: { type: 'tax_profile' },
        outcome: 'success',
        detail: {
          sealed,
          resealed,
          remainingPlaintext: left.plain,
          remainingOldKey: left.old,
          keyId: current,
        },
      });
    return { sealed, resealed, remainingPlaintext: left.plain, remainingOldKey: left.old };
  }
}
