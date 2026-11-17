-- DEV ONLY. Production is forward-fix: evidence, validations and breach cases are compliance records and are never dropped.
DROP TABLE IF EXISTS compliance.breach_cases;
DROP FUNCTION IF EXISTS compliance.breach_guard();
DROP TABLE IF EXISTS compliance.regulatory_validations;
DROP TABLE IF EXISTS compliance.evidence_items;
DROP TABLE IF EXISTS compliance.control_mappings;
DROP FUNCTION IF EXISTS compliance.immutable_row();
DROP TABLE IF EXISTS compliance.control_catalog;
DELETE FROM tenancy.role_permissions WHERE permission IN ('admin:controls:manage','admin:breach:manage');
DELETE FROM tenancy.permissions WHERE name IN ('admin:controls:manage','admin:breach:manage');
