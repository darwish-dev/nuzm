-- DEV ONLY. Production is forward-fix: grants, links and statements are audit/financial evidence and are never dropped.
DROP TABLE IF EXISTS programs.reseller_statements, programs.reseller_sub_orgs, programs.resellers, programs.delegated_access, programs.agency_clients, programs.agencies CASCADE;
DROP FUNCTION IF EXISTS programs.sub_org_guard(), programs.link_guard(), programs.touch();
DELETE FROM tenancy.role_permissions WHERE permission IN ('agency:manage','agency:finance','partners:manage','reseller:manage','reseller:pricing','reseller:finance','admin:programs');
DELETE FROM tenancy.permissions WHERE name IN ('agency:manage','agency:finance','partners:manage','reseller:manage','reseller:pricing','reseller:finance','admin:programs');
