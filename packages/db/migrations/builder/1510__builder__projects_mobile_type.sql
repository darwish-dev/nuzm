-- M10B S48: builder.projects.type accepts `mobile` (M09 left the CHECK list at `website`; M10 extends it). The list is the full docs/04 set so that an identical extension by
-- the M10A web-app work is idempotent. A mobile project keeps its Flutter source in builder.project_files of its versions; the version `site_model` column holds the
-- mobile manifest (`{"kind":"mobile", ...}`), because the version table is the one history for every project type.
ALTER TABLE builder.projects DROP CONSTRAINT IF EXISTS projects_type_check;
ALTER TABLE builder.projects ADD CONSTRAINT projects_type_check CHECK (type IN ('website','webapp','mobile'));
