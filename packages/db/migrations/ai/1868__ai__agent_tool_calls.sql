-- S-AG2 (SCR-K-10): the read-only agent tool gateway records every call in the existing append-only `ai.tool_calls`. Expand only: three nullable columns and one partial unique index.
--   call_id      the tool-call id the MODEL used (unique within a run), so a replayed or resumed call is recorded once
--   result_bytes the size of the result that was handed back to the model: the per-run byte limit is the sum of these
--   error_code   a fixed code of the refusal (invalid_arguments, not_permitted, limit_exceeded, ...): never a message, never an argument
-- Nothing is backfilled: calls recorded by the app-builder graph keep NULL here and are not counted by the agent limits.
ALTER TABLE ai.tool_calls
  ADD COLUMN call_id text CHECK (call_id IS NULL OR length(call_id) BETWEEN 1 AND 128),
  ADD COLUMN result_bytes int CHECK (result_bytes IS NULL OR result_bytes >= 0),
  ADD COLUMN error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,39}$');
CREATE UNIQUE INDEX tool_calls_run_call_idx ON ai.tool_calls (org_id, run_id, call_id) WHERE call_id IS NOT NULL;
