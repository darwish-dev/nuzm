-- DEV ONLY. Production is forward-fix (docs/05 §2): domain records, orders and eligibility evidence are never dropped there.
DROP FUNCTION IF EXISTS domains.resolve_domain(text);
DROP TABLE IF EXISTS domains.eligibility_checks;
DROP TABLE IF EXISTS domains.domain_orders;
DROP TABLE IF EXISTS domains.domains;
DROP TABLE IF EXISTS domains.registrar_accounts;
DROP TABLE IF EXISTS domains.registrars;
DROP FUNCTION IF EXISTS domains.order_guard();
DROP FUNCTION IF EXISTS domains.deny_mutation();
DELETE FROM tenancy.role_permissions WHERE permission IN ('domain:search','domain:read','domain:write','domain:renew','dns:read','dns:write','admin:domains:read','admin:domains:manage');
DELETE FROM tenancy.permissions WHERE name IN ('domain:search','domain:read','domain:write','domain:renew','dns:read','dns:write','admin:domains:read','admin:domains:manage');
DROP SCHEMA IF EXISTS domains;
