-- DEV ONLY. Production is forward-fix (projects and form submissions are customer data).
DROP TABLE IF EXISTS builder.cms_items;
DROP TABLE IF EXISTS builder.cms_collections;
DROP TABLE IF EXISTS builder.form_submissions;
DROP TABLE IF EXISTS builder.forms;
DROP TABLE IF EXISTS builder.pages;
DROP TABLE IF EXISTS builder.previews;
DROP TABLE IF EXISTS builder.changes;
DROP TABLE IF EXISTS builder.project_files;
ALTER TABLE IF EXISTS builder.projects DROP CONSTRAINT IF EXISTS projects_head_fk;
DROP TABLE IF EXISTS builder.project_versions;
DROP TABLE IF EXISTS builder.projects;
DROP FUNCTION IF EXISTS builder.version_guard();
DROP FUNCTION IF EXISTS builder.deny_mutation();
DELETE FROM tenancy.role_permissions WHERE permission IN ('builder:read','builder:write','builder:submissions:read');
DELETE FROM tenancy.permissions WHERE name IN ('builder:read','builder:write','builder:submissions:read');
