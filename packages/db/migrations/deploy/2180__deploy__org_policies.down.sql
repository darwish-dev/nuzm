-- DEV ONLY. Production is forward-fix. Dropping the table returns every organization to the defaults (the pre-migration behaviour).
DROP TABLE IF EXISTS deploy.org_policies;
