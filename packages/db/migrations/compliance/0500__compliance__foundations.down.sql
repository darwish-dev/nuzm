-- DEV ONLY. Production is forward-fix (consent history is compliance evidence and is never dropped).
DROP TABLE IF EXISTS compliance.consents;
DROP FUNCTION IF EXISTS compliance.consents_append_only();
DROP TABLE IF EXISTS compliance.data_classes;
DELETE FROM tenancy.role_permissions WHERE permission IN ('privacy:consent:self','privacy:consent:manage');
DELETE FROM tenancy.permissions WHERE name IN ('privacy:consent:self','privacy:consent:manage');
