-- DEV/STAGING ONLY. Production is forward-fix (docs/05 §2): run history and approvals are evidence and are never dropped.
DROP TABLE IF EXISTS ai.approval_requests;
DROP FUNCTION IF EXISTS ai.approval_request_guard();
DROP TABLE IF EXISTS ai.tool_calls;
DROP TABLE IF EXISTS ai.run_steps;
DROP FUNCTION IF EXISTS ai.run_step_guard();
DELETE FROM tenancy.role_permissions WHERE permission IN ('ai:run','ai:read','ai:approve','ai:budget','builder:read','builder:write','builder:test','builder:export','builder:git','sandbox:use','deploy:read','deploy:create','deploy:rollback','admin:ai:read');
DELETE FROM tenancy.permissions WHERE name IN ('ai:run','ai:read','ai:approve','ai:budget','builder:read','builder:write','builder:test','builder:export','builder:git','sandbox:use','deploy:read','deploy:create','deploy:rollback','admin:ai:read');
