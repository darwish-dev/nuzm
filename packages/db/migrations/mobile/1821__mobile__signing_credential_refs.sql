-- M10B S49: signing credential REFERENCES. Key material is never stored here or anywhere in Nuzm databases: `vault_ref` is a `vault://` reference; the signing stage
-- (a worker project code cannot reach, HG-10-01) receives short-lived material at use time. `authorized_by` is the owner/admin who authorized the use of the credential.
--  * Rows are never deleted; revocation sets `revoked_at` (the revocation endpoint needs an approved spec change request, see SCR-M10B-01).
CREATE TABLE mobile.signing_credential_refs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android','ios')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  vault_ref text NOT NULL CHECK (vault_ref ~ '^vault://[A-Za-z0-9][A-Za-z0-9._/@:+-]{2,250}$'),
  authorized_by uuid NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX signing_label_idx ON mobile.signing_credential_refs (org_id, platform, lower(label)) WHERE revoked_at IS NULL;
CREATE FUNCTION mobile.signing_ref_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'signing credential references are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.platform <> OLD.platform OR NEW.vault_ref <> OLD.vault_ref OR NEW.authorized_by <> OLD.authorized_by
     OR NEW.authorized_at <> OLD.authorized_at OR NEW.label <> OLD.label OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'a signing credential reference is immutable (only revocation can change)' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'a revoked reference cannot change' USING ERRCODE = 'check_violation', HINT = 'state_machine'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signing_ref_guard BEFORE UPDATE OR DELETE ON mobile.signing_credential_refs FOR EACH ROW EXECUTE FUNCTION mobile.signing_ref_guard();
ALTER TABLE mobile.signing_credential_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile.signing_credential_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON mobile.signing_credential_refs USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON mobile.signing_credential_refs FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON mobile.signing_credential_refs TO nuzm_app, nuzm_worker;
GRANT UPDATE (revoked_at, revoked_by) ON mobile.signing_credential_refs TO nuzm_app, nuzm_worker;
GRANT SELECT ON mobile.signing_credential_refs TO nuzm_readonly_reporting;
