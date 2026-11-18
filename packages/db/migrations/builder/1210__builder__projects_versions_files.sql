-- M09 S39/S40/S41: website builder. Projects, immutable versions (the site model is the source of truth), rendered files per version, change sets (proposed or applied),
-- previews (hashed tokens, expiring), the page index, forms + their submissions (sealed, personal) and CMS collections/items.
--  * builder.project_versions and builder.project_files are IMMUTABLE: history is never rewritten; a restore creates a NEW head version.
--  * builder.projects.version is the ETag of the project head (single-writer lock with optimistic concurrency, S40).
--  * builder.projects.type is a CHECK list: M10 extends it with webapp|mobile in its own migration.
--  * a project delete is a soft delete with a retention window (deleted_purge_after); previews of a deleted project stop working.
--  * form submissions: `payload_enc` is field-sealed, `ip_hash` is a salted hash, never the address; `expires_at` is the retention end (D-34 proposal 90 days).
CREATE SCHEMA IF NOT EXISTS builder;
GRANT USAGE ON SCHEMA builder TO nuzm_app, nuzm_worker, nuzm_readonly_reporting, nuzm_admin_breakglass;

INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('builder:read','org','Read builder projects, versions, previews, forms and collections'),
  ('builder:write','org','Create and change builder projects, apply changes, restore versions, manage forms and collections'),
  ('builder:submissions:read','org','Read form submissions with personal data unmasked');
INSERT INTO tenancy.role_permissions VALUES
  ('owner','builder:read'),('admin','builder:read'),('billing_admin','builder:read'),('developer','builder:read'),('viewer','builder:read'),
  ('owner','builder:write'),('admin','builder:write'),('developer','builder:write'),
  ('owner','builder:submissions:read'),('admin','builder:submissions:read'),('developer','builder:submissions:read');

CREATE TABLE builder.projects (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  workspace_id uuid,
  type text NOT NULL DEFAULT 'website' CHECK (type IN ('website')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  locales text[] NOT NULL CHECK (cardinality(locales) BETWEEN 1 AND 2 AND locales <@ ARRAY['ar','en']),
  template_id text,
  head_version_id uuid,
  data_region text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_purge_after timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((deleted_at IS NULL) = (deleted_purge_after IS NULL))
);
CREATE UNIQUE INDEX projects_name_idx ON builder.projects (org_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX projects_org_idx ON builder.projects (org_id, created_at DESC, id);

CREATE TABLE builder.project_versions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES builder.projects (id),
  parent_id uuid REFERENCES builder.project_versions (id),
  seq int NOT NULL CHECK (seq >= 1),
  site_model jsonb NOT NULL,
  model_hash text NOT NULL CHECK (model_hash ~ '^[0-9a-f]{64}$'),
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 100),
  named boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('user','ai','restore','template','system')),
  run_id uuid,
  restored_from uuid REFERENCES builder.project_versions (id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, seq)
);
CREATE INDEX project_versions_project_idx ON builder.project_versions (org_id, project_id, seq DESC);
ALTER TABLE builder.projects ADD CONSTRAINT projects_head_fk FOREIGN KEY (head_version_id) REFERENCES builder.project_versions (id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION builder.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable (history is never rewritten)', TG_TABLE_NAME USING ERRCODE = 'check_violation', HINT = 'immutable'; END $$;
-- a version may only gain a name/label (named snapshot); the model, the parent and the sequence never change
CREATE FUNCTION builder.version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'versions are never deleted' USING ERRCODE = 'check_violation', HINT = 'immutable'; END IF;
  IF NEW.site_model IS DISTINCT FROM OLD.site_model OR NEW.model_hash <> OLD.model_hash OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.seq <> OLD.seq OR NEW.project_id <> OLD.project_id OR NEW.org_id <> OLD.org_id OR NEW.source <> OLD.source THEN
    RAISE EXCEPTION 'a version is immutable (only its label can be set)' USING ERRCODE = 'check_violation', HINT = 'immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER version_guard BEFORE UPDATE OR DELETE ON builder.project_versions FOR EACH ROW EXECUTE FUNCTION builder.version_guard();
CREATE TRIGGER versions_no_truncate BEFORE TRUNCATE ON builder.project_versions FOR EACH STATEMENT EXECUTE FUNCTION builder.deny_mutation();

CREATE TABLE builder.project_files (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES builder.projects (id),
  version_id uuid NOT NULL REFERENCES builder.project_versions (id),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 300 AND path !~ '(^/|\.\.|//|\\)'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  storage_ref text,
  size int NOT NULL CHECK (size >= 0 AND size <= 5242880),
  mime text NOT NULL CHECK (length(mime) BETWEEN 3 AND 100),
  content bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, path),
  CHECK (content IS NOT NULL OR storage_ref IS NOT NULL)
);
CREATE INDEX project_files_project_idx ON builder.project_files (org_id, project_id, version_id);
CREATE TRIGGER files_immutable BEFORE UPDATE OR DELETE ON builder.project_files FOR EACH ROW EXECUTE FUNCTION builder.deny_mutation();
CREATE TRIGGER files_no_truncate BEFORE TRUNCATE ON builder.project_files FOR EACH STATEMENT EXECUTE FUNCTION builder.deny_mutation();

CREATE TABLE builder.changes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES builder.projects (id),
  base_version_id uuid NOT NULL REFERENCES builder.project_versions (id),
  ops jsonb NOT NULL,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  risks jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('proposed','applied','rejected','superseded')),
  result_version_id uuid REFERENCES builder.project_versions (id),
  source text NOT NULL CHECK (source IN ('user','ai')),
  run_id uuid,
  inverse_ops jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK ((status = 'applied') = (result_version_id IS NOT NULL))
);
CREATE INDEX changes_project_idx ON builder.changes (org_id, project_id, created_at DESC);

CREATE TABLE builder.previews (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES builder.projects (id),
  version_id uuid NOT NULL REFERENCES builder.project_versions (id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  viewport text NOT NULL DEFAULT 'desktop' CHECK (viewport IN ('mobile','tablet','desktop')),
  origin text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX previews_project_idx ON builder.previews (org_id, project_id, created_at DESC);

CREATE TABLE builder.pages (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES builder.projects (id),
  version_id uuid NOT NULL REFERENCES builder.project_versions (id),
  page_id text NOT NULL,
  locale text NOT NULL CHECK (locale IN ('ar','en')),
  slug text NOT NULL,
  path text NOT NULL,
  title text NOT NULL,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (version_id, page_id, locale)
);
CREATE INDEX pages_version_idx ON builder.pages (org_id, version_id);

CREATE TABLE builder.forms (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES builder.projects (id),
  form_key text NOT NULL CHECK (form_key ~ '^[a-z][a-z0-9_-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  fields jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  notify_email_enc text,
  retention_days int NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  spam_count int NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, form_key)
);

CREATE TABLE builder.form_submissions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES builder.projects (id),
  form_id uuid NOT NULL REFERENCES builder.forms (id),
  payload_enc text NOT NULL,
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  classification text NOT NULL DEFAULT 'personal' CHECK (classification = 'personal'),
  data_region text NOT NULL,
  notified boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_submissions_form_idx ON builder.form_submissions (org_id, form_id, created_at DESC, id);
CREATE INDEX form_submissions_expiry_idx ON builder.form_submissions (expires_at);

CREATE TABLE builder.cms_collections (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES builder.projects (id),
  collection_key text NOT NULL CHECK (collection_key ~ '^[a-z][a-z0-9_-]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  fields jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, collection_key)
);
CREATE TABLE builder.cms_items (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  collection_id uuid NOT NULL REFERENCES builder.cms_collections (id),
  data jsonb NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  version int NOT NULL DEFAULT 1,
  CHECK ((state = 'published') = (published_at IS NOT NULL))
);
CREATE INDEX cms_items_collection_idx ON builder.cms_items (org_id, collection_id, created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['projects','project_versions','project_files','changes','previews','pages','forms','form_submissions','cms_collections','cms_items'] LOOP
    EXECUTE format('ALTER TABLE builder.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE builder.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY org_isolation ON builder.%I USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
    EXECUTE format($p$CREATE POLICY platform_read ON builder.%I FOR SELECT USING (coalesce(current_setting('app.platform_scope', true), '') = 'admin')$p$, t);
    EXECUTE format('GRANT SELECT ON builder.%I TO nuzm_readonly_reporting', t);
  END LOOP;
END $$;
-- public form ingest runs without an organization context: it resolves the form by id through a narrow policy and inserts with the form's own org
CREATE POLICY public_form_lookup ON builder.forms FOR SELECT USING (coalesce(current_setting('app.auth_scope', true), '') = 'public_form');
CREATE POLICY public_project_lookup ON builder.projects FOR SELECT USING (coalesce(current_setting('app.auth_scope', true), '') = 'public_form');
CREATE POLICY public_form_insert ON builder.form_submissions FOR INSERT WITH CHECK (coalesce(current_setting('app.auth_scope', true), '') = 'public_form');
GRANT SELECT, INSERT, UPDATE ON builder.projects, builder.forms, builder.cms_collections, builder.cms_items, builder.previews, builder.changes TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT, UPDATE ON builder.project_versions TO nuzm_app, nuzm_worker;
GRANT SELECT, INSERT ON builder.project_files, builder.pages, builder.form_submissions TO nuzm_app, nuzm_worker;
GRANT UPDATE (notified) ON builder.form_submissions TO nuzm_app, nuzm_worker;
GRANT DELETE ON builder.form_submissions, builder.pages TO nuzm_app, nuzm_worker;
