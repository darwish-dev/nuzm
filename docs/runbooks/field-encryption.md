# Runbook — field-level encryption (M04 S13d)

What is sealed today: the personal part of a **tax profile** (legal names, VAT and CR numbers, address) in `invoicing.tax_profiles.pii_enc`. Everything else is covered by the inventory in [S13d report](../reports/S13d-report.md).

## How it works
- AES-256-GCM, a per-column subkey derived from a master key (HKDF-SHA256), 96-bit random IV, and the authenticated data `schema.table.column|rowId`: a sealed value copied to another row or column does not open.
- Format `enc:v1:<keyId>:<base64url(iv|tag|ciphertext)>`. The key id says which master key opens it, so rotation never breaks old values.
- Master keys are **vault references** (`FIELD_ENCRYPTION_KEYS`, see `.env.example`); the key bytes are never in the database, in code or in logs. **Production without configured keys fails closed** (D-12 decides the real vault/KMS; until then production use is BLOCKED). Development creates one throwaway key in the dev secret store.

## Rotate a key
1. Create the new master key in the vault (32 random bytes, base64) and add it to `FIELD_ENCRYPTION_KEYS` as `current`, keeping the old key listed. Deploy. New writes use the new key; old values still open.
2. Run `pnpm --filter @nuzm/api run encrypt:backfill` (the application's own configuration; one organization per transaction; idempotent; does not change versions or update times). It re-seals every value that is not under the current key and reports `remainingOldKey`.
3. When `remainingOldKey` is 0, remove the old key from the configuration and from the vault (keep a dated record). A value still sealed with a removed key cannot be opened again: do not retire a key early.

## Seal legacy rows (once, after deploying migration 0503)
1. Run `pnpm --filter @nuzm/api run encrypt:backfill`; it seals every plaintext tax profile.
2. When it reports `remainingPlaintext: 0`, as the database owner: `ALTER TABLE invoicing.tax_profiles VALIDATE CONSTRAINT tax_profiles_new_rows_sealed;` (the constraint was added NOT VALID so that existing rows did not block the deploy; new writes were sealed from the start).

## Lost key
Sealed values cannot be recovered without their master key. Back the vault up as the vault procedure requires (D-12); treat a lost key as a data-loss incident for the affected columns.

## Checks
`pnpm compliance:classification-coverage` fails when a credentials-class column has no declared protection (hash, vault_ref, lookup, encrypted), when its name does not fit, or when an `encrypted` column holds a value that is not a sealed field value.
