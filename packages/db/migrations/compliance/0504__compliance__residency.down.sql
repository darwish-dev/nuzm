-- DEV ONLY. Production is forward-fix: residency policies and transfer assessments are compliance evidence and are never dropped.
DROP TABLE IF EXISTS compliance.transfer_assessments;
DROP FUNCTION IF EXISTS compliance.transfer_assessment_guard();
DROP TABLE IF EXISTS compliance.residency_policies;
DROP FUNCTION IF EXISTS compliance.residency_policy_guard();
DELETE FROM tenancy.role_permissions WHERE permission IN ('privacy:residency:read','privacy:residency:manage');
DELETE FROM tenancy.permissions WHERE name IN ('privacy:residency:read','privacy:residency:manage');
