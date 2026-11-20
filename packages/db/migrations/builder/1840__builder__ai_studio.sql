-- AI Studio (ADR-064, accepted 2026-11-20 for D-37/D-39/D-40; D-38 proof of concept only): Skills registry, project skills, project instructions,
-- GitHub App connections, and the Claude Code sandbox prototype state.
--  * No credential of any kind is stored here: GitHub installation tokens are minted per call from the App key (a vault reference in config), and
--    Claude Code credentials never reach Nuzm (the customer signs in inside their own sandbox).
--  * Platform skills have org_id NULL and are managed under the platform scope; tenants read only APPROVED platform skills. A customer's own skills
--    carry its org_id and are isolated like every tenant row.
--  * Skill versions, skill reviews, instruction versions and GitHub webhook deliveries are append-only evidence.

-- ---- Skills registry ---------------------------------------------------------------------------------------------------------------
CREATE TABLE builder.skills (
  id uuid PRIMARY KEY,
  org_id uuid,                                   -- NULL = platform skill; set = a customer's own skill
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 64),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  category text CHECK (category IS NULL OR category IN ('architecture','code-quality','testing','security','performance','documentation','frontend','backend','mobile','business','design')),
  scope text NOT NULL CHECK (scope IN ('global','framework','language','template','industry','customer')),
  frameworks text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  industries text[] NOT NULL DEFAULT '{}',
  source_kind text NOT NULL CHECK (source_kind IN ('nuzm','github','upload','customer')),
  source_repo text CHECK (source_repo IS NULL OR source_repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  status text NOT NULL DEFAULT 'in_review' CHECK (status IN ('in_review','approved','rejected','disabled')),
  current_version_id uuid,                       -- the approved version customers install (same schema, logical reference)
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CHECK ((org_id IS NULL) = (scope <> 'customer')),
  CHECK (status <> 'approved' OR current_version_id IS NOT NULL)
);
CREATE UNIQUE INDEX skills_platform_slug_idx ON builder.skills (slug) WHERE org_id IS NULL;
CREATE UNIQUE INDEX skills_org_slug_idx ON builder.skills (org_id, slug) WHERE org_id IS NOT NULL;
CREATE FUNCTION builder.skill_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'skills are disabled, never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.slug <> OLD.slug OR NEW.source_kind <> OLD.source_kind THEN
    RAISE EXCEPTION 'the identity, owner and source of a skill are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_guard BEFORE UPDATE OR DELETE ON builder.skills FOR EACH ROW EXECUTE FUNCTION builder.skill_guard();
ALTER TABLE builder.skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.skills FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON builder.skills USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY runtime_read_approved ON builder.skills FOR SELECT USING (org_id IS NULL AND status = 'approved');
CREATE POLICY org_isolation ON builder.skills USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT ON builder.skills TO nuzm_app;
GRANT UPDATE (description, category, frameworks, languages, industries, status, current_version_id) ON builder.skills TO nuzm_app;
GRANT SELECT ON builder.skills TO nuzm_worker, nuzm_readonly_reporting;

CREATE TABLE builder.skill_versions (
  id uuid PRIMARY KEY,
  skill_id uuid NOT NULL,                        -- logical reference to builder.skills
  org_id uuid,                                   -- copy of the skill's owner (RLS)
  semver text NOT NULL CHECK (semver ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  source_commit text CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{40}$'),
  source_path text CHECK (source_path IS NULL OR length(source_path) <= 240),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),   -- [{path, content, executable}] text only; binaries are refused at import
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  bytes int NOT NULL CHECK (bytes BETWEEN 1 AND 2000000),
  license text CHECK (license IS NULL OR length(license) <= 64),
  scan jsonb NOT NULL CHECK (jsonb_typeof(scan) = 'object'),     -- {ruleset, verdict, executable, findings[]} — findings never quote matched text
  executable boolean NOT NULL DEFAULT false,
  review_state text NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','approved','rejected')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, semver)
);
CREATE INDEX skill_versions_skill_idx ON builder.skill_versions (skill_id, created_at DESC);
CREATE FUNCTION builder.skill_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'skill versions are append-only' USING ERRCODE = 'check_violation', HINT = 'append_only'; END IF;
  IF NEW.id <> OLD.id OR NEW.skill_id <> OLD.skill_id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.semver <> OLD.semver
     OR NEW.files <> OLD.files OR NEW.manifest <> OLD.manifest OR NEW.content_hash <> OLD.content_hash OR NEW.scan <> OLD.scan
     OR NEW.source_commit IS DISTINCT FROM OLD.source_commit OR NEW.executable <> OLD.executable THEN
    RAISE EXCEPTION 'the content of a skill version is immutable' USING ERRCODE = 'check_violation', HINT = 'append_only';
  END IF;
  IF OLD.review_state <> 'pending' AND NEW.review_state <> OLD.review_state THEN
    RAISE EXCEPTION 'a reviewed skill version cannot change its decision' USING ERRCODE = 'check_violation', HINT = 'state_machine';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_version_guard BEFORE UPDATE OR DELETE ON builder.skill_versions FOR EACH ROW EXECUTE FUNCTION builder.skill_version_guard();
ALTER TABLE builder.skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.skill_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON builder.skill_versions USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
CREATE POLICY runtime_read_approved ON builder.skill_versions FOR SELECT USING (org_id IS NULL AND review_state = 'approved');
CREATE POLICY org_isolation ON builder.skill_versions USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT ON builder.skill_versions TO nuzm_app;
GRANT UPDATE (review_state) ON builder.skill_versions TO nuzm_app;
GRANT SELECT ON builder.skill_versions TO nuzm_worker, nuzm_readonly_reporting;

CREATE TABLE builder.skill_reviews (
  id uuid PRIMARY KEY,
  skill_version_id uuid NOT NULL,                -- logical reference to builder.skill_versions
  reviewer_id uuid NOT NULL,                     -- platform staff user (identity.users)
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_version_id, reviewer_id)
);
CREATE FUNCTION builder.skill_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill reviews are append-only' USING ERRCODE = 'check_violation', HINT = 'append_only';
END $$;
CREATE TRIGGER skill_review_guard BEFORE UPDATE OR DELETE ON builder.skill_reviews FOR EACH ROW EXECUTE FUNCTION builder.skill_review_guard();
ALTER TABLE builder.skill_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.skill_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON builder.skill_reviews USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.skill_reviews TO nuzm_app;
GRANT SELECT ON builder.skill_reviews TO nuzm_readonly_reporting;

-- ---- Project skills ----------------------------------------------------------------------------------------------------------------
CREATE TABLE builder.project_skills (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,                      -- logical reference to builder.projects
  skill_id uuid NOT NULL,                        -- logical reference to builder.skills
  skill_version_id uuid NOT NULL,                -- the exact version installed
  slug text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('recommended','requested','template','dependency','customer')),
  state text NOT NULL DEFAULT 'installed' CHECK (state IN ('installed','removed')),
  installed_by uuid,
  installed_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK ((state = 'removed') = (removed_at IS NOT NULL))
);
CREATE UNIQUE INDEX project_skills_active_idx ON builder.project_skills (project_id, skill_id) WHERE state = 'installed';
CREATE INDEX project_skills_org_idx ON builder.project_skills (org_id, project_id);
ALTER TABLE builder.project_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.project_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.project_skills USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.project_skills FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.project_skills TO nuzm_app;
GRANT UPDATE (state, removed_at) ON builder.project_skills TO nuzm_app;
GRANT SELECT ON builder.project_skills TO nuzm_worker, nuzm_readonly_reporting;

-- ---- Project instructions (CLAUDE.md) ----------------------------------------------------------------------------------------------
CREATE TABLE builder.project_instructions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,                      -- logical reference to builder.projects
  project_layer jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(project_layer) = 'array'),
  customer_layer jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(customer_layer) = 'array'),
  customer_block text NOT NULL DEFAULT '' CHECK (length(customer_block) <= 20000),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX project_instructions_project_idx ON builder.project_instructions (project_id);
CREATE FUNCTION builder.project_instructions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'project instructions are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'the owner of project instructions is immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER project_instructions_guard BEFORE UPDATE OR DELETE ON builder.project_instructions FOR EACH ROW EXECUTE FUNCTION builder.project_instructions_guard();
ALTER TABLE builder.project_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.project_instructions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.project_instructions USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.project_instructions FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.project_instructions TO nuzm_app;
GRANT UPDATE (project_layer, customer_layer, customer_block, updated_by) ON builder.project_instructions TO nuzm_app;
GRANT SELECT ON builder.project_instructions TO nuzm_worker, nuzm_readonly_reporting;

CREATE TABLE builder.instruction_versions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version int NOT NULL CHECK (version >= 1),
  project_layer jsonb NOT NULL,
  customer_layer jsonb NOT NULL,
  customer_block text NOT NULL,
  markdown text NOT NULL CHECK (length(markdown) <= 200000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);
CREATE FUNCTION builder.instruction_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'instruction versions are append-only' USING ERRCODE = 'check_violation', HINT = 'append_only';
END $$;
CREATE TRIGGER instruction_version_guard BEFORE UPDATE OR DELETE ON builder.instruction_versions FOR EACH ROW EXECUTE FUNCTION builder.instruction_version_guard();
ALTER TABLE builder.instruction_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.instruction_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.instruction_versions USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.instruction_versions FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.instruction_versions TO nuzm_app;
GRANT SELECT ON builder.instruction_versions TO nuzm_readonly_reporting;

-- ---- GitHub App ----------------------------------------------------------------------------------------------------------------------
CREATE TABLE builder.github_connections (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  account_login text NOT NULL CHECK (account_login ~ '^[A-Za-z0-9-]{1,39}$'),
  account_type text NOT NULL CHECK (account_type IN ('User','Organization')),
  repository_selection text CHECK (repository_selection IS NULL OR repository_selection IN ('all','selected')),
  adapter text NOT NULL CHECK (adapter IN ('github-app','fake')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended','removed')),
  connected_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX github_connections_org_active_idx ON builder.github_connections (org_id) WHERE state <> 'removed';
CREATE INDEX github_connections_installation_idx ON builder.github_connections (installation_id);
ALTER TABLE builder.github_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.github_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.github_connections USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_all ON builder.github_connections USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.github_connections TO nuzm_app;
GRANT UPDATE (state, repository_selection, updated_at) ON builder.github_connections TO nuzm_app;
GRANT SELECT ON builder.github_connections TO nuzm_readonly_reporting;

CREATE TABLE builder.github_repos (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,                      -- logical reference to builder.projects
  connection_id uuid NOT NULL,                   -- logical reference to builder.github_connections
  repo_id bigint NOT NULL CHECK (repo_id > 0),
  full_name text NOT NULL CHECK (full_name ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9_.-]{1,100}$'),
  default_branch text NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 255),
  private boolean NOT NULL,
  last_synced_sha text CHECK (last_synced_sha IS NULL OR last_synced_sha ~ '^[0-9a-f]{40}$'),
  last_synced_version_id uuid,                   -- the project version that last matched the remote (logical reference)
  state text NOT NULL DEFAULT 'linked' CHECK (state IN ('linked','unlinked')),
  linked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX github_repos_project_active_idx ON builder.github_repos (project_id) WHERE state = 'linked';
CREATE INDEX github_repos_org_idx ON builder.github_repos (org_id, created_at DESC);
ALTER TABLE builder.github_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.github_repos FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.github_repos USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_all ON builder.github_repos USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.github_repos TO nuzm_app;
GRANT UPDATE (last_synced_sha, last_synced_version_id, state, default_branch, updated_at) ON builder.github_repos TO nuzm_app;
GRANT SELECT ON builder.github_repos TO nuzm_readonly_reporting;

CREATE TABLE builder.github_events (
  id uuid PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE CHECK (length(delivery_id) BETWEEN 1 AND 100),  -- X-GitHub-Delivery: the dedupe key
  event text NOT NULL CHECK (event ~ '^[a-z_]{1,60}$'),
  action text CHECK (action IS NULL OR action ~ '^[a-z_]{1,60}$'),
  installation_id bigint,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION builder.github_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'webhook deliveries are append-only' USING ERRCODE = 'check_violation', HINT = 'append_only';
END $$;
CREATE TRIGGER github_event_guard BEFORE UPDATE OR DELETE ON builder.github_events FOR EACH ROW EXECUTE FUNCTION builder.github_event_guard();
ALTER TABLE builder.github_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.github_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON builder.github_events USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
  WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.github_events TO nuzm_app;
GRANT SELECT ON builder.github_events TO nuzm_readonly_reporting;

-- ---- Claude Code sandbox prototype (D-38: proof of concept only) --------------------------------------------------------------------
CREATE TABLE builder.claude_code_sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,                      -- logical reference to builder.projects
  sandbox_id uuid NOT NULL,                      -- logical reference to builder.sandboxes
  state text NOT NULL CHECK (state IN ('NOT_CONFIGURED','AUTHENTICATION_REQUIRED','AUTHENTICATING','READY','AUTHENTICATION_EXPIRED','ERROR','STOPPED')),
  binary_version text CHECK (binary_version IS NULL OR binary_version ~ '^[0-9A-Za-z .()+-]{1,60}$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,60}$'),
  started_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claude_code_sessions_project_idx ON builder.claude_code_sessions (org_id, project_id, created_at DESC);
ALTER TABLE builder.claude_code_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder.claude_code_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON builder.claude_code_sessions USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY platform_read ON builder.claude_code_sessions FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
GRANT SELECT, INSERT ON builder.claude_code_sessions TO nuzm_app;
GRANT UPDATE (state, binary_version, error_code, updated_at) ON builder.claude_code_sessions TO nuzm_app;
GRANT SELECT ON builder.claude_code_sessions TO nuzm_readonly_reporting;
