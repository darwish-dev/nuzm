-- DEV/STAGING ONLY (fails if mobile/webapp projects exist: expand/contract applies in production).
ALTER TABLE builder.projects DROP CONSTRAINT IF EXISTS projects_type_check;
ALTER TABLE builder.projects ADD CONSTRAINT projects_type_check CHECK (type IN ('website'));
