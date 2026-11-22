-- DEV/STAGING ONLY. Production is forward-fix (the columns hold derived records of tool calls). Documented reversal of 1868 (S-AG2).
DROP INDEX IF EXISTS ai.tool_calls_run_call_idx;
ALTER TABLE ai.tool_calls DROP COLUMN IF EXISTS error_code, DROP COLUMN IF EXISTS result_bytes, DROP COLUMN IF EXISTS call_id;
