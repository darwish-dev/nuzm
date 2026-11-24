-- Session 06 (migration id 2213 (renumbered from 1980 when the hosting line joined), range 2210-2219): a website deployment can be CANCELLED before it is switched live.
-- Expand-only: the state CHECK gains 'cancelled' (terminal, with finished_at), the transition guard treats it as terminal. No column is added: who cancelled is
-- in the audit event `deploy.deployment.cancelled`; the cancel request itself is `platform.operations.cancel_requested`.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'deploy.deployments'::regclass AND contype = 'c'
       AND (pg_get_constraintdef(oid) LIKE '%state = ANY%' OR pg_get_constraintdef(oid) LIKE '%rolled_back%')
       AND pg_get_constraintdef(oid) NOT LIKE '%approval_id%'
  LOOP
    EXECUTE format('ALTER TABLE deploy.deployments DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE deploy.deployments
  ADD CONSTRAINT deployments_state_check CHECK (state IN ('queued','building','deploying','smoke_checking','succeeded','failed','rolled_back','cancelled')),
  ADD CONSTRAINT deployments_finished_check CHECK ((state IN ('succeeded','failed','rolled_back','cancelled')) = (finished_at IS NOT NULL));

CREATE OR REPLACE FUNCTION deploy.deployment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'deployments are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id OR NEW.target_ref <> OLD.target_ref OR NEW.environment <> OLD.environment OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity, version and target of a deployment are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state IN ('succeeded','failed','rolled_back','cancelled') AND NEW.state <> OLD.state AND NOT (OLD.state = 'succeeded' AND NEW.state = 'rolled_back') THEN
    RAISE EXCEPTION 'illegal deployment state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
