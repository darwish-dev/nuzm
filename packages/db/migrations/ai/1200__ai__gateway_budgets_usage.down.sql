-- DEV ONLY. Production is forward-fix (usage rows are financial records and are never dropped).
DROP TABLE IF EXISTS ai.model_usage;
DROP TABLE IF EXISTS ai.reservations;
DROP TABLE IF EXISTS ai.credit_balances;
DROP TABLE IF EXISTS ai.budgets;
DROP TABLE IF EXISTS ai.model_providers;
DROP FUNCTION IF EXISTS ai.deny_mutation();
DELETE FROM tenancy.role_permissions WHERE permission IN ('ai:read','ai:write','ai:budgets:write','admin:ai:read','admin:ai:manage','admin:ai:approve');
DELETE FROM tenancy.permissions WHERE name IN ('ai:read','ai:write','ai:budgets:write','admin:ai:read','admin:ai:manage','admin:ai:approve');
