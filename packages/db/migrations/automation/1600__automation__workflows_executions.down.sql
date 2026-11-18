-- DEV ONLY. Production is forward-fix: workflow definitions, executions and dead letters are customer data and evidence and are never dropped.
DROP TABLE IF EXISTS automation.anomaly_cases, automation.dead_letters, automation.execution_steps, automation.executions, automation.workflow_versions, automation.workflows CASCADE;
DROP FUNCTION IF EXISTS automation.execution_guard(), automation.immutable_row(), automation.workflow_guard();
DELETE FROM tenancy.role_permissions WHERE permission IN ('automation:read','automation:write','automation:run','connector:manage','webhook:manage','admin:automation');
DELETE FROM tenancy.permissions WHERE name IN ('automation:read','automation:write','automation:run','connector:manage','webhook:manage','admin:automation');
DROP FUNCTION IF EXISTS automation.enqueue_execution(uuid, uuid, uuid, text, text, text, jsonb, uuid, int, uuid, jsonb, uuid);
