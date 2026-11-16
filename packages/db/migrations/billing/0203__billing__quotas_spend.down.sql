-- DEV/STAGING ONLY. Production uses forward fixes. Spend approvals are an approval record: never dropped in production.
DROP TABLE IF EXISTS billing.spend_approvals;
DROP FUNCTION IF EXISTS billing.spend_approval_guard();
DROP FUNCTION IF EXISTS billing.spend_approval_no_delete();
DROP TABLE IF EXISTS billing.spending_limits;
DROP FUNCTION IF EXISTS billing.evaluate_quotas(uuid, timestamptz);
DROP TABLE IF EXISTS billing.quotas;
DROP FUNCTION IF EXISTS billing.effective_limits(uuid);
DROP TABLE IF EXISTS billing.quota_meters;
DELETE FROM tenancy.role_permissions WHERE permission IN ('usage:read','spend:request');
DELETE FROM tenancy.permissions WHERE name IN ('usage:read','spend:request');
