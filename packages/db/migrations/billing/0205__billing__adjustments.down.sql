-- DEV/STAGING ONLY. Adjustment requests are an approval record: never dropped in production.
DROP TABLE IF EXISTS billing.adjustment_requests;
DROP FUNCTION IF EXISTS billing.adjustment_guard();
DROP FUNCTION IF EXISTS billing.adjustment_no_truncate();
DELETE FROM tenancy.role_permissions WHERE permission = 'admin:billing:approve';
DELETE FROM tenancy.permissions WHERE name = 'admin:billing:approve';
