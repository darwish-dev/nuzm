-- AI Intelligence Center foundation (ADR-065 and SCR-K-01, accepted by the owner 2026-11-20): the library of admin-curated projects, themes, component libraries,
-- design systems and documentation, its immutable versions, derived analysis rows, retrieval documents, quality evidence and generation links.
--  * org_id NULL = the PLATFORM library (staff-owned, managed under the platform scope); org_id set = a customer's private template or import (isolated like every
--    tenant row). A customer never reads a platform row from these tables: it reads knowledge.v_published_templates, which exposes metadata, compatibility facts,
--    a design summary and preview references only. File contents, object keys of archives and snapshots, manifests' source excerpts stay unreachable.
--  * A resource version is immutable once created (identity, checksum, archive, provenance). Files, manifests, analysis results, quality scores, usage events and
--    generation evidence are append-only. Derived rows (components, dependencies, relationships, search documents, theme tokens and variants) may be replaced when
--    a version is analysed again.
--  * Nothing here stores a credential. Source bytes live in object storage (keys only); no uploaded code is ever executed by this schema or its workers.
--  * Licence rule enforced in the database as well as in the service: a version can be ACTIVE only when its licence verdict is ALLOWED (D-43).
--  * No embedding column: the semantic layer waits for D-47 and a capability probe. Retrieval starts with metadata, tsvector and the relationship tables.
CREATE SCHEMA IF NOT EXISTS knowledge;
GRANT USAGE ON SCHEMA knowledge TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('admin:ai_knowledge:read','platform','View the AI knowledge library, processing jobs and analytics'),
  ('admin:ai_knowledge:manage','platform','Upload resources, edit metadata, analyse, reindex, disable and archive library resources'),
  ('admin:ai_knowledge:publish','platform','Activate and approve resources (second person for third-party or licensed ones), set defaults and engine settings, allow AI processing of a resource');
INSERT INTO tenancy.role_permissions VALUES
  ('platform_admin','admin:ai_knowledge:read'),('support','admin:ai_knowledge:read'),('security','admin:ai_knowledge:read'),('compliance_officer','admin:ai_knowledge:read'),
  ('platform_admin','admin:ai_knowledge:manage'),
  ('platform_admin','admin:ai_knowledge:publish'),('security','admin:ai_knowledge:publish');

-- ---- Upload sessions (resumable, quarantined until completion) --------------------------------------------------------------------
CREATE TABLE knowledge.uploads (
  id uuid PRIMARY KEY,
  org_id uuid,                                   -- NULL = a platform library upload; set = a customer's own import
  resource_id uuid,                              -- set when the upload adds a version to an existing resource (logical reference)
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','COMPLETED','CANCELLED','EXPIRED')),
  declared_bytes bigint NOT NULL CHECK (declared_bytes > 0),
  received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  part_size int NOT NULL CHECK (part_size BETWEEN 262144 AND 67108864),
  parts jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(parts) = 'array'),   -- [{partNumber, sha256, bytes}]
  checksum_expected text NOT NULL CHECK (checksum_expected ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (received_bytes <= declared_bytes)
);
CREATE INDEX uploads_open_idx ON knowledge.uploads (state, expires_at);

-- ---- Resources -----------------------------------------------------------------------------------------------------------------
CREATE TABLE knowledge.resources (
  id uuid PRIMARY KEY,
  org_id uuid,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 4000),
  resource_type text NOT NULL CHECK (resource_type IN ('PROJECT','THEME','COMPONENT_LIBRARY','DESIGN_SYSTEM','DOCUMENTATION','API_SPECIFICATION','DATABASE_SCHEMA','STARTER_KIT','REUSABLE_MODULE')),
  platform text CHECK (platform IS NULL OR platform IN ('WEB','MOBILE','BACKEND','FULL_STACK','CROSS_PLATFORM')),
  frameworks text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  category text CHECK (category IS NULL OR length(category) <= 80),
  tags text[] NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'PLATFORM_PRIVATE' CHECK (visibility IN ('PLATFORM_PRIVATE','PLATFORM_PUBLISHED','TENANT_PRIVATE')),
  source_kind text NOT NULL CHECK (source_kind IN ('upload','github','git','customer')),
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 300),
  status text NOT NULL DEFAULT 'UPLOADING' CHECK (status IN ('UPLOADING','QUARANTINED','VALIDATING','ANALYZING','INDEXING','AWAITING_REVIEW','ACTIVE','FAILED','DISABLED','ARCHIVED')),
  current_version_id uuid,                       -- the newest version (logical reference, same schema)
  default_eligible boolean NOT NULL DEFAULT false,
  data_region text NOT NULL CHECK (length(data_region) BETWEEN 2 AND 40),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((org_id IS NULL) = (visibility <> 'TENANT_PRIVATE'))
);
CREATE UNIQUE INDEX resources_platform_slug_idx ON knowledge.resources (slug) WHERE org_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX resources_org_slug_idx ON knowledge.resources (org_id, slug) WHERE org_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX resources_list_idx ON knowledge.resources (org_id, status, created_at DESC);
CREATE INDEX resources_type_idx ON knowledge.resources (resource_type, platform);
CREATE FUNCTION knowledge.resource_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'resources are archived, never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.slug <> OLD.slug OR NEW.source_kind <> OLD.source_kind
     OR NEW.resource_type <> OLD.resource_type OR NEW.data_region <> OLD.data_region THEN
    RAISE EXCEPTION 'the identity, owner, type, source and region of a resource are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_guard BEFORE UPDATE OR DELETE ON knowledge.resources FOR EACH ROW EXECUTE FUNCTION knowledge.resource_guard();

CREATE TABLE knowledge.resource_versions (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL,                     -- logical reference to knowledge.resources
  org_id uuid,                                   -- copy of the resource's owner (RLS)
  seq int NOT NULL CHECK (seq >= 1),
  semver text CHECK (semver IS NULL OR semver ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  state text NOT NULL DEFAULT 'QUARANTINED' CHECK (state IN ('UPLOADING','QUARANTINED','VALIDATING','ANALYZING','INDEXING','AWAITING_REVIEW','ACTIVE','FAILED','DISABLED','ARCHIVED')),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  archive_key text NOT NULL CHECK (length(archive_key) BETWEEN 1 AND 400),  -- original package in object storage (immutable, content-addressed)
  snapshot_key text CHECK (snapshot_key IS NULL OR length(snapshot_key) <= 400),
  provenance jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(provenance) = 'object'),  -- {sourceKind, repository?, ref?, uploadId?, uploadedBy, uploadedAt}
  source_commit text CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{40}$'),
  license_verdict text NOT NULL DEFAULT 'UNKNOWN' CHECK (license_verdict IN ('ALLOWED','RESTRICTED','UNKNOWN','BLOCKED')),
  parent_version_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  activated_by uuid,
  retired_at timestamptz,
  UNIQUE (resource_id, seq),
  CHECK (state <> 'ACTIVE' OR license_verdict = 'ALLOWED')
);
CREATE INDEX resource_versions_resource_idx ON knowledge.resource_versions (resource_id, seq DESC);
CREATE UNIQUE INDEX resource_versions_one_active_idx ON knowledge.resource_versions (resource_id) WHERE state = 'ACTIVE';
CREATE FUNCTION knowledge.resource_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'resource versions are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.id <> OLD.id OR NEW.resource_id <> OLD.resource_id OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.seq <> OLD.seq
     OR NEW.checksum_sha256 <> OLD.checksum_sha256 OR NEW.bytes <> OLD.bytes OR NEW.archive_key <> OLD.archive_key
     OR NEW.provenance <> OLD.provenance OR NEW.source_commit IS DISTINCT FROM OLD.source_commit OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the content, checksum and provenance of a resource version are immutable' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_version_guard BEFORE UPDATE OR DELETE ON knowledge.resource_versions FOR EACH ROW EXECUTE FUNCTION knowledge.resource_version_guard();

CREATE TABLE knowledge.resource_files (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 500),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  language text CHECK (language IS NULL OR length(language) <= 40),
  is_binary boolean NOT NULL DEFAULT false,
  is_executable boolean NOT NULL DEFAULT false,
  object_key text CHECK (object_key IS NULL OR length(object_key) <= 400),     -- NULL for a file that was filtered (binary, sensitive configuration)
  secret_findings int NOT NULL DEFAULT 0 CHECK (secret_findings >= 0),          -- a COUNT; matched text is never stored
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, path)
);

CREATE TABLE knowledge.resource_permissions (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL UNIQUE,
  org_id uuid,
  reuse_scope text NOT NULL DEFAULT 'NONE' CHECK (reuse_scope IN ('NONE','ARCHITECTURE_ONLY','COMPONENTS','FULL_STARTER')),
  ai_processing boolean NOT NULL DEFAULT false,                                 -- D-49: off by default; turning it on needs admin:ai_knowledge:publish
  component_reuse boolean NOT NULL DEFAULT false,
  starter_eligible boolean NOT NULL DEFAULT false,
  architecture_reference boolean NOT NULL DEFAULT false,
  license_spdx text CHECK (license_spdx IS NULL OR length(license_spdx) <= 120),
  license_verdict text NOT NULL DEFAULT 'UNKNOWN' CHECK (license_verdict IN ('ALLOWED','RESTRICTED','UNKNOWN','BLOCKED')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- Derived analysis: manifests (versioned, with evidence), components, dependencies, relationships, retrieval documents ----------------
CREATE TABLE knowledge.resource_manifests (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  schema_version text NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 20),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),           -- every capability carries evidence and confidence; none without evidence
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, schema_version)
);

CREATE TABLE knowledge.resource_components (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  framework text CHECK (framework IS NULL OR length(framework) <= 40),
  path text NOT NULL CHECK (length(path) <= 500),
  props jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(props) = 'array'),
  dependencies text[] NOT NULL DEFAULT '{}',
  style_deps text[] NOT NULL DEFAULT '{}',
  assets text[] NOT NULL DEFAULT '{}',
  platforms text[] NOT NULL DEFAULT '{}',
  reuse_allowed boolean NOT NULL DEFAULT false,
  quality_score numeric(5,2) CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100),
  preview_key text CHECK (preview_key IS NULL OR length(preview_key) <= 400),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_components_version_idx ON knowledge.resource_components (version_id, name);

CREATE TABLE knowledge.resource_dependencies (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  ecosystem text NOT NULL CHECK (length(ecosystem) BETWEEN 1 AND 20),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 214),
  range text CHECK (range IS NULL OR length(range) <= 200),
  kind text NOT NULL DEFAULT 'runtime' CHECK (kind IN ('runtime','dev','peer','optional')),
  path text CHECK (path IS NULL OR length(path) <= 500),
  license text CHECK (license IS NULL OR length(license) <= 120),
  risk text CHECK (risk IS NULL OR risk IN ('none','low','medium','high')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_dependencies_version_idx ON knowledge.resource_dependencies (version_id, ecosystem, name);

CREATE TABLE knowledge.resource_relationships (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  from_kind text NOT NULL CHECK (length(from_kind) BETWEEN 1 AND 30),
  from_ref text NOT NULL CHECK (length(from_ref) BETWEEN 1 AND 500),
  to_kind text NOT NULL CHECK (length(to_kind) BETWEEN 1 AND 30),
  to_ref text NOT NULL CHECK (length(to_ref) BETWEEN 1 AND 500),
  relation text NOT NULL CHECK (length(relation) BETWEEN 1 AND 40),
  evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_relationships_from_idx ON knowledge.resource_relationships (version_id, from_kind, from_ref);
CREATE INDEX resource_relationships_to_idx ON knowledge.resource_relationships (version_id, to_kind, to_ref);

CREATE TABLE knowledge.resource_search_documents (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  doc_kind text NOT NULL CHECK (doc_kind IN ('SUMMARY','COMPONENT','SYMBOL','DOC_SECTION','FEATURE','DESIGN','API')),
  ref text NOT NULL CHECK (length(ref) <= 500),
  title text NOT NULL CHECK (length(title) <= 300),
  body text NOT NULL CHECK (length(body) <= 20000),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),           -- unchanged content is never re-indexed
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, doc_kind, ref)
);
CREATE INDEX resource_search_documents_tsv_idx ON knowledge.resource_search_documents USING gin (tsv);

-- ---- Processing, analysis evidence, quality, usage ------------------------------------------------------------------------------
CREATE TABLE knowledge.processing_jobs (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  kind text NOT NULL CHECK (kind IN ('VALIDATE','EXTRACT','DETECT','ANALYZE','COMPONENTS','DESIGN','DOCUMENT','INDEX','QUALITY','PREVIEW','EMBED')),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER')),
  attempt int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  progress numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,60}$'),
  error_detail text CHECK (error_detail IS NULL OR length(error_detail) <= 1000),  -- actionable, never quotes secret text
  operation_id uuid,                             -- platform.operations (logical reference)
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processing_jobs_version_idx ON knowledge.processing_jobs (version_id, created_at DESC);
CREATE INDEX processing_jobs_state_idx ON knowledge.processing_jobs (state, created_at);

CREATE TABLE knowledge.analysis_results (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  analyzer text NOT NULL CHECK (length(analyzer) BETWEEN 1 AND 60),
  analyzer_version text NOT NULL CHECK (length(analyzer_version) BETWEEN 1 AND 20),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),           -- same hash + same analyzer version = nothing is analysed again
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  evidence jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, analyzer, analyzer_version, content_hash)
);

CREATE TABLE knowledge.quality_scores (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  dimension text NOT NULL CHECK (dimension IN ('BUILD','TEST','ARCHITECTURE','DESIGN','SECURITY','COMPLETENESS')),
  score numeric(5,2) CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  method text NOT NULL CHECK (length(method) BETWEEN 1 AND 80),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 200),
  measured boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (measured = (score IS NOT NULL AND evidence_ref IS NOT NULL)),          -- a score exists only with its evidence ...
  CHECK (score IS NULL OR measured)                                              -- ... otherwise the dimension is "not measured", never a number
);
CREATE INDEX quality_scores_version_idx ON knowledge.quality_scores (version_id, dimension, computed_at DESC);

CREATE TABLE knowledge.usage_events (
  id uuid PRIMARY KEY,
  org_id uuid,                                   -- the consuming organization (NULL for staff previews)
  resource_id uuid NOT NULL,
  version_id uuid,
  kind text NOT NULL CHECK (kind IN ('RECOMMENDED','SELECTED','COPIED','COMPONENT_REUSED','RETRIEVED','REJECTED')),
  run_id uuid,
  outcome text CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED','FAILED','ABANDONED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_resource_idx ON knowledge.usage_events (resource_id, created_at DESC);

-- ---- Theme intelligence ---------------------------------------------------------------------------------------------------------
CREATE TABLE knowledge.theme_tokens (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  category text NOT NULL CHECK (category IN ('color','typography','spacing','radius','shadow','breakpoint','motion','other')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  value text NOT NULL CHECK (length(value) <= 400),
  source_path text CHECK (source_path IS NULL OR length(source_path) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX theme_tokens_version_idx ON knowledge.theme_tokens (version_id, category, name);

CREATE TABLE knowledge.theme_variants (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL,
  org_id uuid,
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),                     -- layout, sidebar, header, page-template, chart, form, card ...
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  descriptor jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(descriptor) = 'object'),
  preview_key text CHECK (preview_key IS NULL OR length(preview_key) <= 400),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX theme_variants_version_idx ON knowledge.theme_variants (version_id, kind);

-- ---- Defaults (platform-only preferences: compatibility and permissions are still checked at use) -----------------------------------
CREATE TABLE knowledge.template_defaults (
  id uuid PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('WEB','MOBILE','BACKEND','FULL_STACK','CROSS_PLATFORM')),
  framework text NOT NULL DEFAULT '*' CHECK (length(framework) <= 40),
  category text NOT NULL DEFAULT '*' CHECK (length(category) <= 80),
  plan text NOT NULL DEFAULT '*' CHECK (length(plan) <= 40),
  mode text NOT NULL DEFAULT '*' CHECK (mode IN ('*','STRICT','ADAPTIVE','CREATIVE')),
  resource_id uuid NOT NULL,
  version_pin uuid,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, framework, category, plan, mode)
);

-- ---- Generation links, plans, evaluations (always tenant-owned) -------------------------------------------------------------------
CREATE TABLE knowledge.generation_plans (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,                      -- logical reference to builder.projects
  run_id uuid,                                   -- logical reference to ai.runs, set when the plan is executed
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  selection_strategy text NOT NULL CHECK (selection_strategy IN ('AUTO_SELECT','USER_SELECTED','ADMIN_DEFAULT','GENERATE_FROM_SCRATCH')),
  adaptation_mode text NOT NULL DEFAULT 'ADAPTIVE' CHECK (adaptation_mode IN ('STRICT','ADAPTIVE','CREATIVE')),
  requirements jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(requirements) = 'object'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX generation_plans_project_idx ON knowledge.generation_plans (org_id, project_id, created_at DESC);

CREATE TABLE knowledge.generation_resource_links (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  plan_id uuid,
  run_id uuid,
  resource_version_id uuid NOT NULL,             -- the pinned immutable version the customer's copy came from
  role text NOT NULL CHECK (role IN ('STARTER','THEME','COMPONENT','DOCUMENTATION','API_SPEC')),
  strategy text NOT NULL CHECK (strategy IN ('COPY','COMPONENT_REUSE','REFERENCE')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generation_resource_links_version_idx ON knowledge.generation_resource_links (resource_version_id);

CREATE TABLE knowledge.generation_evaluations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  plan_id uuid,
  run_id uuid,
  build_result text CHECK (build_result IS NULL OR build_result IN ('PASSED','FAILED','BLOCKED','NOT_RUN')),
  test_result text CHECK (test_result IS NULL OR test_result IN ('PASSED','FAILED','BLOCKED','NOT_RUN')),
  user_outcome text CHECK (user_outcome IS NULL OR user_outcome IN ('ACCEPTED','REVISED','ABANDONED')),
  tokens_in bigint CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out bigint CHECK (tokens_out IS NULL OR tokens_out >= 0),
  cost_minor bigint CHECK (cost_minor IS NULL OR cost_minor >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((cost_minor IS NULL) = (currency IS NULL))                              -- money is integer minor units plus a currency, never a bare number
);

-- ---- Append-only evidence --------------------------------------------------------------------------------------------------------
CREATE FUNCTION knowledge.append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'append_only';
END $$;
CREATE TRIGGER resource_files_append_only BEFORE UPDATE OR DELETE ON knowledge.resource_files FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();
CREATE TRIGGER resource_manifests_append_only BEFORE UPDATE OR DELETE ON knowledge.resource_manifests FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();
CREATE TRIGGER analysis_results_append_only BEFORE UPDATE OR DELETE ON knowledge.analysis_results FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();
CREATE TRIGGER quality_scores_append_only BEFORE UPDATE OR DELETE ON knowledge.quality_scores FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();
CREATE TRIGGER usage_events_append_only BEFORE UPDATE OR DELETE ON knowledge.usage_events FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();
CREATE TRIGGER generation_resource_links_append_only BEFORE UPDATE OR DELETE ON knowledge.generation_resource_links FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();
CREATE TRIGGER generation_evaluations_append_only BEFORE UPDATE OR DELETE ON knowledge.generation_evaluations FOR EACH ROW EXECUTE FUNCTION knowledge.append_only();

-- ---- Row-level security ----------------------------------------------------------------------------------------------------------
-- Tables whose rows are either platform (org_id NULL) or a customer's own: staff manage platform rows under the platform scope; a tenant session sees only its
-- own rows. There is deliberately NO policy that lets a tenant read a platform row from these tables: the published view below is the only way.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['uploads','resources','resource_versions','resource_files','resource_permissions','resource_manifests','resource_components',
                           'resource_dependencies','resource_relationships','resource_search_documents','processing_jobs','analysis_results','quality_scores',
                           'usage_events','theme_tokens','theme_variants']
  LOOP
    EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY platform_all ON knowledge.%I USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
                      WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format($p$CREATE POLICY org_isolation ON knowledge.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  END LOOP;
  -- always tenant-owned: a customer's plans, links and evaluations; staff may read them for analytics
  FOREACH t IN ARRAY ARRAY['generation_plans','generation_resource_links','generation_evaluations']
  LOOP
    EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON knowledge.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
                      WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON knowledge.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
  END LOOP;
  -- platform-only preferences
  ALTER TABLE knowledge.template_defaults ENABLE ROW LEVEL SECURITY;
  ALTER TABLE knowledge.template_defaults FORCE ROW LEVEL SECURITY;
  CREATE POLICY platform_all ON knowledge.template_defaults USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')
    WITH CHECK (coalesce(current_setting('app.platform_scope', true), '') = 'admin');
END $$;

-- ---- Grants (the database guards above enforce immutability; the grants keep the surface small) --------------------------------------
GRANT SELECT, INSERT, UPDATE ON knowledge.uploads, knowledge.resources, knowledge.resource_versions, knowledge.resource_permissions, knowledge.processing_jobs,
  knowledge.template_defaults, knowledge.generation_plans TO nuzm_app;
GRANT SELECT, INSERT, DELETE ON knowledge.resource_components, knowledge.resource_dependencies, knowledge.resource_relationships, knowledge.resource_search_documents,
  knowledge.theme_tokens, knowledge.theme_variants TO nuzm_app;
GRANT SELECT, INSERT ON knowledge.resource_files, knowledge.resource_manifests, knowledge.analysis_results, knowledge.quality_scores, knowledge.usage_events,
  knowledge.generation_resource_links, knowledge.generation_evaluations TO nuzm_app;
GRANT DELETE ON knowledge.template_defaults TO nuzm_app;
GRANT SELECT ON ALL TABLES IN SCHEMA knowledge TO nuzm_worker, nuzm_readonly_reporting;

-- ---- What a customer may read of the platform library -------------------------------------------------------------------------------
-- A definer view (owner: the migration role, which bypasses row-level security): the WHERE clause is the whole contract. Only ACTIVE, published versions whose licence
-- allows reuse and whose permissions allow at least architecture reference are listed; a customer also sees its own private templates. Columns are metadata,
-- compatibility facts, a design summary and preview references: never archive or snapshot keys, file paths, manifests or source excerpts.
CREATE VIEW knowledge.v_published_templates WITH (security_barrier = true) AS
  SELECT r.id AS resource_id, v.id AS version_id, v.seq AS version_seq, v.semver, r.org_id, r.name, r.description, r.resource_type, r.platform, r.frameworks,
         r.languages, r.category, r.tags, p.reuse_scope, p.component_reuse, p.starter_eligible, p.architecture_reference, p.license_verdict,
         (SELECT m.manifest -> 'designDna' FROM knowledge.resource_manifests m WHERE m.version_id = v.id ORDER BY m.created_at DESC LIMIT 1) AS design_dna,
         (SELECT coalesce(jsonb_agg(tv.preview_key ORDER BY tv.name) FILTER (WHERE tv.preview_key IS NOT NULL), '[]'::jsonb)
            FROM knowledge.theme_variants tv WHERE tv.version_id = v.id) AS preview_keys
    FROM knowledge.resources r
    JOIN knowledge.resource_versions v ON v.resource_id = r.id AND v.state = 'ACTIVE'
    JOIN knowledge.resource_permissions p ON p.resource_id = r.id
   WHERE r.deleted_at IS NULL
     AND v.license_verdict = 'ALLOWED' AND p.license_verdict = 'ALLOWED'
     AND (
       (r.org_id IS NULL AND r.visibility = 'PLATFORM_PUBLISHED' AND r.status = 'ACTIVE' AND p.reuse_scope <> 'NONE')
       OR (r.org_id IS NOT NULL AND r.org_id = nullif(current_setting('app.org_id', true), '')::uuid)
     );
GRANT SELECT ON knowledge.v_published_templates TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;
