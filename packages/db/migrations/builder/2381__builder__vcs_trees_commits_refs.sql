-- P3-S09: trees, commits and references of the PostgreSQL version store. See 2380 for the model.
--  * vcs_trees: `entries` = [[name, mode, oid], ...] in git order. Immutable. The store recomputes the tree id on read.
--  * vcs_commits: parents/author/time/message; `replay_key` = sha256(first parent | tree | message) makes a retried commit idempotent. Immutable.
--  * vcs_refs: `refs/heads/*` move by compare-and-swap and are never deleted; `refs/tags/cp-*` (checkpoints) are immutable; `refs/remotes/github/*` mirror a remote.
CREATE TABLE builder.vcs_trees (
  repo_id uuid NOT NULL,
  oid text NOT NULL CHECK (oid ~ '^[0-9a-f]{40}$'),
  org_id uuid NOT NULL,
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, oid),
  FOREIGN KEY (repo_id, org_id) REFERENCES builder.git_repos (id, org_id)
);
CREATE INDEX vcs_trees_org_idx ON builder.vcs_trees (org_id);
CREATE TRIGGER vcs_trees_immutable BEFORE UPDATE OR DELETE ON builder.vcs_trees FOR EACH ROW EXECUTE FUNCTION builder.vcs_immutable();

CREATE TABLE builder.vcs_commits (
  repo_id uuid NOT NULL,
  oid text NOT NULL CHECK (oid ~ '^[0-9a-f]{40}$'),
  org_id uuid NOT NULL,
  tree_oid text NOT NULL CHECK (tree_oid ~ '^[0-9a-f]{40}$'),
  parents text[] NOT NULL DEFAULT '{}' CHECK (cardinality(parents) <= 16),
  author text NOT NULL CHECK (length(author) BETWEEN 3 AND 300),
  committed_at timestamptz NOT NULL,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  replay_key text NOT NULL CHECK (replay_key ~ '^[0-9a-f]{64}$'),
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, oid),
  FOREIGN KEY (repo_id, org_id) REFERENCES builder.git_repos (id, org_id)
);
CREATE INDEX vcs_commits_replay_idx ON builder.vcs_commits (repo_id, replay_key, created_at, oid);
CREATE INDEX vcs_commits_org_idx ON builder.vcs_commits (org_id);
CREATE TRIGGER vcs_commits_immutable BEFORE UPDATE OR DELETE ON builder.vcs_commits FOR EACH ROW EXECUTE FUNCTION builder.vcs_immutable();

CREATE TABLE builder.vcs_refs (
  repo_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^refs/(heads/[a-z][a-z0-9/_-]{0,60}|tags/cp-[0-9a-z][0-9a-z-]{0,60}|remotes/[a-z][a-z0-9-]{0,30}/[a-z][a-z0-9/_-]{0,60})$'),
  org_id uuid NOT NULL,
  oid text NOT NULL CHECK (oid ~ '^[0-9a-f]{40}$'),
  version integer NOT NULL DEFAULT 1,
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, name),
  FOREIGN KEY (repo_id, org_id) REFERENCES builder.git_repos (id, org_id)
);
CREATE INDEX vcs_refs_org_idx ON builder.vcs_refs (org_id);
CREATE FUNCTION builder.vcs_ref_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'version-store references are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.repo_id <> OLD.repo_id OR NEW.org_id <> OLD.org_id OR NEW.name <> OLD.name OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'the identity of a reference is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  IF OLD.name LIKE 'refs/tags/%' THEN
    RAISE EXCEPTION 'a checkpoint never moves' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER vcs_ref_guard BEFORE UPDATE OR DELETE ON builder.vcs_refs FOR EACH ROW EXECUTE FUNCTION builder.vcs_ref_guard();

ALTER TABLE builder.vcs_trees ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.vcs_trees FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.vcs_trees USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.vcs_trees FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.vcs_trees TO nuzm_app, nuzm_worker;

ALTER TABLE builder.vcs_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.vcs_commits FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.vcs_commits USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.vcs_commits FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.vcs_commits TO nuzm_app, nuzm_worker;

ALTER TABLE builder.vcs_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.vcs_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.vcs_refs USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.vcs_refs FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.vcs_refs TO nuzm_app, nuzm_worker;
GRANT UPDATE (oid, version, updated_at) ON builder.vcs_refs TO nuzm_app, nuzm_worker;
