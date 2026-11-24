-- DEV ONLY. Production is forward-fix (rows already 'cancelled' would violate the old CHECK, so they are first moved to 'failed').
ALTER TABLE deploy.deployments DISABLE TRIGGER deployment_guard;
UPDATE deploy.deployments SET state = 'failed' WHERE state = 'cancelled';
ALTER TABLE deploy.deployments ENABLE TRIGGER deployment_guard;
ALTER TABLE deploy.deployments DROP CONSTRAINT IF EXISTS deployments_state_check, DROP CONSTRAINT IF EXISTS deployments_finished_check;
ALTER TABLE deploy.deployments
  ADD CONSTRAINT deployments_state_check CHECK (state IN ('queued','building','deploying','smoke_checking','succeeded','failed','rolled_back')),
  ADD CONSTRAINT deployments_finished_check CHECK ((state IN ('succeeded','failed','rolled_back')) = (finished_at IS NOT NULL));
CREATE OR REPLACE FUNCTION deploy.deployment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'deployments are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.version_id <> OLD.version_id OR NEW.target_ref <> OLD.target_ref OR NEW.environment <> OLD.environment OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the identity, version and target of a deployment are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.state IN ('succeeded','failed','rolled_back') AND NEW.state <> OLD.state AND NOT (OLD.state = 'succeeded' AND NEW.state = 'rolled_back') THEN
    RAISE EXCEPTION 'illegal deployment state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
