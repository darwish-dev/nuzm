-- DEV/STAGING ONLY. Production is forward-fix: jobs and their transitions are audit evidence. Documented reversal of 2310 (P3-S02): the flag `ai.agent.exec_tools` is off and the queue drained
-- first; no other schema references these tables (no cross-schema foreign keys), so dropping them only removes the stored job history.
DROP TABLE IF EXISTS execution.workspaces;
DROP FUNCTION IF EXISTS execution.workspace_transition_guard();
DROP TABLE IF EXISTS execution.job_transitions;
DROP TABLE IF EXISTS execution.jobs;
DROP FUNCTION IF EXISTS execution.job_identity_guard();
DROP FUNCTION IF EXISTS execution.job_transition_guard();
DROP FUNCTION IF EXISTS execution.deny_mutation();
DROP SCHEMA IF EXISTS execution; -- 2310 created the schema and is undone last (downs run in reverse: 2312, 2311, 2310)
