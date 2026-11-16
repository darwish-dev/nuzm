-- Dev/staging reversal ONLY. Production ledger data is never dropped (forward fix; docs/05 §6, M02 §7).
DELETE FROM tenancy.role_permissions WHERE permission = 'admin:billing:read';
DELETE FROM tenancy.permissions WHERE name = 'admin:billing:read';
DROP SCHEMA IF EXISTS billing CASCADE;
