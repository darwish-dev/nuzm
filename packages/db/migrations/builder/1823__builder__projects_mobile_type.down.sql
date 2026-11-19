-- DEV/STAGING ONLY (fails if mobile projects exist: expand/contract applies in production). Restores the list set by 1800, which already includes `mobile`; the contraction to 'website' is 1800's down file.
ALTER TABLE builder.projects DROP CONSTRAINT IF EXISTS projects_type_check;
ALTER TABLE builder.projects ADD CONSTRAINT projects_type_check CHECK (type IN ('website','webapp','mobile'));
