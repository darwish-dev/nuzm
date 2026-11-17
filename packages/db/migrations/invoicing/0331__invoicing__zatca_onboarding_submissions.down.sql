-- DEV ONLY. Production is forward-fix (onboarding and submission history are compliance records and are never dropped).
DROP FUNCTION IF EXISTS invoicing.zatca_pending(text, text, timestamptz, int);
DROP FUNCTION IF EXISTS invoicing.zatca_unprocessed(text, timestamptz, int);
DROP TABLE IF EXISTS invoicing.zatca_submissions;
DROP FUNCTION IF EXISTS invoicing.zatca_submission_guard();
ALTER TABLE invoicing.zatca_documents DROP CONSTRAINT IF EXISTS zatca_cleared_chk;
ALTER TABLE invoicing.zatca_documents DROP COLUMN IF EXISTS cleared_xml, DROP COLUMN IF EXISTS cleared_at, DROP COLUMN IF EXISTS cleared_archive_ref;
DROP FUNCTION IF EXISTS invoicing.zatca_active_credential(uuid, text);
DROP TABLE IF EXISTS invoicing.zatca_credentials_refs;
DROP TABLE IF EXISTS invoicing.zatca_onboarding;
DROP FUNCTION IF EXISTS invoicing.zatca_credentials_guard();
DROP FUNCTION IF EXISTS invoicing.zatca_onboarding_guard();
DELETE FROM tenancy.role_permissions WHERE permission IN ('admin:zatca:manage','admin:zatca:approve') OR (role = 'security' AND permission = 'admin:billing:read');
DELETE FROM tenancy.permissions WHERE name IN ('admin:zatca:manage','admin:zatca:approve');
