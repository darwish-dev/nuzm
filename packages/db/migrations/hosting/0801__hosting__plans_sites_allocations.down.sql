-- DEV/STAGING ONLY. Production is forward-fix: sites hold customer data references and are never dropped.
DROP TABLE IF EXISTS hosting.site_allocations;
DROP TABLE IF EXISTS hosting.sites;
DROP TABLE IF EXISTS hosting.plan_definitions;
DROP FUNCTION IF EXISTS hosting.check_reserved_trg();
DROP FUNCTION IF EXISTS hosting.check_node_reserved(uuid);
