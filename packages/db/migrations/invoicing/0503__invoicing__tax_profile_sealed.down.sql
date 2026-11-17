-- DEV ONLY. Production is forward-fix. Sealed rows cannot be turned back into plaintext by this script (the key is in the vault): it only
-- removes the constraints and the column, so run it on a database whose tax profiles are disposable.
ALTER TABLE invoicing.tax_profiles DROP CONSTRAINT IF EXISTS tax_profiles_new_rows_sealed;
ALTER TABLE invoicing.tax_profiles DROP CONSTRAINT IF EXISTS tax_profiles_no_plaintext_beside_ciphertext;
DELETE FROM invoicing.tax_profiles WHERE pii_enc IS NOT NULL;
ALTER TABLE invoicing.tax_profiles DROP CONSTRAINT IF EXISTS tax_profiles_b2b_has_vat;
ALTER TABLE invoicing.tax_profiles ADD CONSTRAINT tax_profiles_check CHECK (buyer_type <> 'b2b' OR vat_number IS NOT NULL);
ALTER TABLE invoicing.tax_profiles DROP COLUMN IF EXISTS pii_enc;
ALTER TABLE invoicing.tax_profiles ALTER COLUMN legal_name_ar SET NOT NULL;
ALTER TABLE invoicing.tax_profiles ALTER COLUMN legal_name_en SET NOT NULL;
ALTER TABLE invoicing.tax_profiles ALTER COLUMN address SET DEFAULT '{}'::jsonb;
ALTER TABLE invoicing.tax_profiles ALTER COLUMN address SET NOT NULL;
