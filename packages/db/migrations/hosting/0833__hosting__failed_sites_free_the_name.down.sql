-- DEV/STAGING ONLY.
DROP INDEX IF EXISTS hosting.sites_org_name_idx;
CREATE UNIQUE INDEX sites_org_name_idx ON hosting.sites (org_id, lower(name)) WHERE status <> 'deleted';
