-- M01 / S01 bootstrap. Roles are created NOLOGIN: LOGIN and passwords are provisioned outside
-- migrations (dev: scripts/dev-services.sh + db CLI; prod: vault-managed). nuzm_migrator is the
-- role that runs migrations (the connecting admin) and is not created here.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['nuzm_app', 'nuzm_worker', 'nuzm_readonly_reporting', 'nuzm_admin_breakglass'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS platform;
GRANT USAGE ON SCHEMA platform TO nuzm_app, nuzm_worker, nuzm_readonly_reporting;
