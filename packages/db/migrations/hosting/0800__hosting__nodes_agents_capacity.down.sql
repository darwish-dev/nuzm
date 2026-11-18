-- DEV/STAGING ONLY. Production is forward-fix: node and agent history is operational evidence and is never dropped.
DROP TABLE IF EXISTS hosting.node_command_log;
DROP TABLE IF EXISTS hosting.node_capacity;
DROP TABLE IF EXISTS hosting.node_enrolment_tokens;
DROP TABLE IF EXISTS hosting.node_agents;
ALTER TABLE hosting.nodes DROP CONSTRAINT IF EXISTS nodes_overcommit_change_fk;
DROP TABLE IF EXISTS hosting.node_overcommit_changes;
DROP TABLE IF EXISTS hosting.nodes;
DROP FUNCTION IF EXISTS hosting.node_capacity_guard();
DROP FUNCTION IF EXISTS hosting.node_factor_guard();
DROP FUNCTION IF EXISTS hosting.overcommit_change_guard();
DROP FUNCTION IF EXISTS hosting.immutable_row();
DELETE FROM tenancy.role_permissions WHERE permission LIKE 'admin:hosting:%' OR role = 'hosting_admin';
DELETE FROM tenancy.permissions WHERE name LIKE 'admin:hosting:%';
DELETE FROM tenancy.roles WHERE name = 'hosting_admin';
DROP SCHEMA IF EXISTS hosting;
