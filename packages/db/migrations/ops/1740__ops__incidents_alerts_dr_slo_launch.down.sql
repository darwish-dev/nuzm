-- DEV/STAGING ONLY (M12 S57/S58); production is forward-fix.
DROP TABLE IF EXISTS ops.launch_gates, ops.probe_runs, ops.slo_definitions, ops.recovery_exercises, ops.provider_incidents, ops.alerts,
  ops.incident_updates, ops.incidents CASCADE;
DROP FUNCTION IF EXISTS ops.deny_mutation();
DELETE FROM tenancy.role_permissions WHERE permission IN ('admin:ops:read','admin:ops:manage');
DELETE FROM tenancy.permissions WHERE name IN ('admin:ops:read','admin:ops:manage');
DROP SCHEMA IF EXISTS ops;
