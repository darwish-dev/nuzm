-- P3-S09 production version store (no `git` binary on the application host): content-addressed storage of project versions in PostgreSQL.
--  * Repositories are the existing `builder.git_repos` rows (same module, same RLS, `data_region` already there). A composite unique index (id, org_id) lets every
--    table below carry a composite foreign key: the database itself refuses a row whose org_id differs from its repository's.
--  * vcs_repo_state: per-repository quota counter and the LOCK ROW that serialises writers (a commit is one transaction that first locks this row).
--  * vcs_blobs: file contents, addressed by the git blob id (SHA-1 over "blob <len>\0<bytes>") AND carrying a sha256, re-verified on every read. Immutable.
CREATE UNIQUE INDEX git_repos_id_org_idx ON builder.git_repos (id, org_id);

CREATE FUNCTION builder.vcs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'version-store objects and events are immutable (% on %.%)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation', HINT = 'immutable';
END $$;

CREATE TABLE builder.vcs_repo_state (
  repo_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  stored_bytes bigint NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (repo_id, org_id) REFERENCES builder.git_repos (id, org_id)
);
CREATE INDEX vcs_repo_state_org_idx ON builder.vcs_repo_state (org_id);
CREATE FUNCTION builder.vcs_repo_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'version-store repository state is never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.repo_id <> OLD.repo_id OR NEW.org_id <> OLD.org_id OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'the identity and region of a version-store repository are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF NEW.stored_bytes < OLD.stored_bytes THEN
    RAISE EXCEPTION 'stored bytes only grow (objects are never removed)' USING ERRCODE = 'check_violation', HINT = 'append_only';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER vcs_repo_state_guard BEFORE UPDATE OR DELETE ON builder.vcs_repo_state FOR EACH ROW EXECUTE FUNCTION builder.vcs_repo_state_guard();

CREATE TABLE builder.vcs_blobs (
  repo_id uuid NOT NULL,
  oid text NOT NULL CHECK (oid ~ '^[0-9a-f]{40}$'),
  org_id uuid NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size >= 0 AND size <= 1000000),
  is_binary boolean NOT NULL,
  content bytea NOT NULL,
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, oid),
  CHECK (octet_length(content) = size),
  FOREIGN KEY (repo_id, org_id) REFERENCES builder.git_repos (id, org_id)
);
CREATE INDEX vcs_blobs_org_idx ON builder.vcs_blobs (org_id);
CREATE TRIGGER vcs_blobs_immutable BEFORE UPDATE OR DELETE ON builder.vcs_blobs FOR EACH ROW EXECUTE FUNCTION builder.vcs_immutable();

ALTER TABLE builder.vcs_repo_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.vcs_repo_state FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.vcs_repo_state USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.vcs_repo_state FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.vcs_repo_state TO nuzm_app, nuzm_worker;
GRANT UPDATE (stored_bytes, updated_at) ON builder.vcs_repo_state TO nuzm_app, nuzm_worker;
GRANT SELECT ON builder.vcs_repo_state TO nuzm_readonly_reporting;

ALTER TABLE builder.vcs_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.vcs_blobs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.vcs_blobs USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.vcs_blobs FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.vcs_blobs TO nuzm_app, nuzm_worker;
