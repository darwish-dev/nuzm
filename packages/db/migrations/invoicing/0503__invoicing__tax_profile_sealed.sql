-- M04 S13d: the personal data of a tax profile (legal names, VAT and CR numbers, address) is sealed with field-level encryption (AES-256-GCM, key in
-- the vault by reference; apps/api/src/common/field-crypto.ts). Expand step of expand/contract:
--  * pii_enc holds the sealed JSON; the plaintext columns become nullable and are NULL for every new or changed row;
--  * a row never carries plaintext beside ciphertext (always enforced);
--  * every NEW write must be sealed (CHECK ... NOT VALID: existing rows are exempt until the backfill has run and the constraint is VALIDATEd);
--  * legacy plaintext rows keep working (the service opens either form) and are sealed by `pnpm --filter @nuzm/api run encrypt:backfill`.
ALTER TABLE invoicing.tax_profiles ADD COLUMN pii_enc text;
ALTER TABLE invoicing.tax_profiles ALTER COLUMN legal_name_ar DROP NOT NULL;
ALTER TABLE invoicing.tax_profiles ALTER COLUMN legal_name_en DROP NOT NULL;
ALTER TABLE invoicing.tax_profiles ALTER COLUMN address DROP NOT NULL;
ALTER TABLE invoicing.tax_profiles ALTER COLUMN address DROP DEFAULT;
-- the VAT number now lives inside the ciphertext: the rule "a b2b buyer has a VAT number" is enforced by the service BEFORE sealing
-- (parseTaxProfile) and, for legacy plaintext rows, by this relaxed check
ALTER TABLE invoicing.tax_profiles DROP CONSTRAINT tax_profiles_check;
ALTER TABLE invoicing.tax_profiles ADD CONSTRAINT tax_profiles_b2b_has_vat CHECK (buyer_type <> 'b2b' OR vat_number IS NOT NULL OR pii_enc IS NOT NULL);
ALTER TABLE invoicing.tax_profiles ADD CONSTRAINT tax_profiles_no_plaintext_beside_ciphertext
  CHECK (pii_enc IS NULL OR (legal_name_ar IS NULL AND legal_name_en IS NULL AND vat_number IS NULL AND cr_number IS NULL AND address IS NULL));
ALTER TABLE invoicing.tax_profiles ADD CONSTRAINT tax_profiles_new_rows_sealed
  CHECK (pii_enc IS NOT NULL AND pii_enc ~ '^enc:v1:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{38,}$') NOT VALID;
