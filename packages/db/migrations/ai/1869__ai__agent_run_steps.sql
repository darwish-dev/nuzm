-- S-AG3 (SCR-K-10 §5): the agent loop persists one run step per model turn plus a validate and an apply step. `ai.run_steps.agent` is a CHECK over the agent names of the web-app
-- build graph; the loop is a new agent, `agent`. Expand only: the new constraint is a strict superset of the old one, so no row is affected and nothing is rewritten.
ALTER TABLE ai.run_steps DROP CONSTRAINT run_steps_agent_check;
ALTER TABLE ai.run_steps ADD CONSTRAINT run_steps_agent_check
  CHECK (agent IN ('requirements','architecture','database','backend','frontend','qa','devops','test-fix','agent'));
