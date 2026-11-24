-- DEV ONLY. Production is forward-fix.
ALTER TABLE hosting.nodes DROP CONSTRAINT IF EXISTS nodes_customer_vps_never_shared, DROP CONSTRAINT IF EXISTS nodes_customer_vps_owner;
DROP INDEX IF EXISTS hosting.nodes_network_class_idx;
ALTER TABLE hosting.nodes DROP COLUMN IF EXISTS owner_org_id, DROP COLUMN IF EXISTS network_class;
