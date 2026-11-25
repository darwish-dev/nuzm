-- P3-S09: append-only journal of every version-store mutation, written in the SAME transaction as the mutation (so a commit without its record cannot exist).
-- The platform audit log (`audit.audit_logs`, hash-chained) additionally receives builder.version.* events from the service layer.
CREATE TABLE builder.vcs_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  repo_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('repo.initialised','commit.created','ref.moved','checkpoint.created','remote_ref.set')),
  ref_name text,
  commit_oid text CHECK (commit_oid IS NULL OR commit_oid ~ '^[0-9a-f]{40}$'),
  actor_user_id uuid,
  trace_id text CHECK (trace_id IS NULL OR length(trace_id) <= 100),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  data_region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (repo_id, org_id) REFERENCES builder.git_repos (id, org_id)
);
CREATE INDEX vcs_events_repo_idx ON builder.vcs_events (repo_id, created_at DESC, id);
CREATE INDEX vcs_events_org_idx ON builder.vcs_events (org_id, created_at DESC);
CREATE TRIGGER vcs_events_immutable BEFORE UPDATE OR DELETE ON builder.vcs_events FOR EACH ROW EXECUTE FUNCTION builder.vcs_immutable();
ALTER TABLE builder.vcs_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.vcs_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.vcs_events USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.vcs_events FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.vcs_events TO nuzm_app, nuzm_worker;
GRANT SELECT ON builder.vcs_events TO nuzm_readonly_reporting;
