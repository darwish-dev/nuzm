-- M12 S55/S57: versioned policy documents (security, privacy, acceptable use) with effective dates (docs/04 §2.12 GET/PUT /v1/admin/policy-versions).
-- Platform-level (admin scope), immutable, one new row per version. The BODY lives in the document store: only a reference is kept here.
-- `approved_by` is a human platform user; the agent never approves a policy (HG-04-01 / HG-12-03): a row without an approver is a DRAFT.
CREATE TABLE compliance.policy_versions (
  id uuid PRIMARY KEY,
  policy_key text NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9_-]{2,40}$'),
  version int NOT NULL CHECK (version >= 1),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  body_ref text NOT NULL CHECK (length(body_ref) BETWEEN 3 AND 300),
  effective_from date NOT NULL,
  approved_by uuid,
  approval_ref text CHECK (approval_ref IS NULL OR length(approval_ref) BETWEEN 3 AND 300),
  change_note text CHECK (change_note IS NULL OR length(change_note) BETWEEN 1 AND 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_key, version),
  CHECK (approved_by IS NULL OR approval_ref IS NOT NULL)
);
CREATE FUNCTION compliance.policy_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev int;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'policy versions are immutable: publish a new version' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  SELECT max(version) INTO prev FROM compliance.policy_versions WHERE policy_key = NEW.policy_key;
  IF NEW.version <> coalesce(prev, 0) + 1 THEN
    RAISE EXCEPTION 'version must be %', coalesce(prev, 0) + 1 USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_versions_insert_guard BEFORE INSERT ON compliance.policy_versions FOR EACH ROW EXECUTE FUNCTION compliance.policy_versions_guard();
CREATE TRIGGER policy_versions_immutable BEFORE UPDATE OR DELETE ON compliance.policy_versions FOR EACH ROW EXECUTE FUNCTION compliance.policy_versions_guard();
CREATE TRIGGER policy_versions_no_truncate BEFORE TRUNCATE ON compliance.policy_versions FOR EACH STATEMENT EXECUTE FUNCTION audit.deny_mutation();
ALTER TABLE compliance.policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance.policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_admin ON compliance.policy_versions USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON compliance.policy_versions TO nuzm_app;
GRANT SELECT ON compliance.policy_versions TO nuzm_readonly_reporting;
