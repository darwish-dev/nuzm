-- DEV ONLY. Production is forward-fix.
DROP TABLE IF EXISTS ai.approvals;
DROP TABLE IF EXISTS ai.run_events;
DROP TABLE IF EXISTS ai.artifacts;
DROP TABLE IF EXISTS ai.runs;
DROP TABLE IF EXISTS ai.messages;
DROP TABLE IF EXISTS ai.sessions;
DROP FUNCTION IF EXISTS ai.run_guard();
DROP FUNCTION IF EXISTS ai.artifact_guard();
DROP FUNCTION IF EXISTS ai.approval_guard();
