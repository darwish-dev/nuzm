-- DEV ONLY. Production is forward-fix: data-subject requests are compliance evidence and are never dropped.
DROP TABLE IF EXISTS compliance.dsr_tasks;
DROP FUNCTION IF EXISTS compliance.dsr_task_guard();
DROP TABLE IF EXISTS compliance.dsr_requests;
DROP FUNCTION IF EXISTS compliance.dsr_request_guard();
DELETE FROM tenancy.role_permissions WHERE permission IN ('privacy:dsr:self','privacy:dsr:manage','privacy:export:manage');
DELETE FROM tenancy.permissions WHERE name IN ('privacy:dsr:self','privacy:dsr:manage','privacy:export:manage');
