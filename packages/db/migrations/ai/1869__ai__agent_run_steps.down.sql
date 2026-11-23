-- DEV/STAGING ONLY. Production is forward-fix. Documented reversal of 1869 (S-AG3): the previous constraint. Run steps are append-only and never deleted, so rows written by the agent
-- loop stay; the old constraint is therefore re-added NOT VALID (it applies to every NEW row and is not re-checked against the existing ones).
ALTER TABLE ai.run_steps DROP CONSTRAINT run_steps_agent_check;
ALTER TABLE ai.run_steps ADD CONSTRAINT run_steps_agent_check
  CHECK (agent IN ('requirements','architecture','database','backend','frontend','qa','devops','test-fix')) NOT VALID;
