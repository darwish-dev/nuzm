-- DEV ONLY. Production is forward-fix: panel connection settings are platform configuration and are never dropped there.
ALTER TABLE hosting.nodes DROP COLUMN IF EXISTS panel_tls_pin, DROP COLUMN IF EXISTS panel_key_ref, DROP COLUMN IF EXISTS panel_port, DROP COLUMN IF EXISTS panel_host, DROP COLUMN IF EXISTS panel_kind;
ALTER TABLE hosting.nodes RENAME COLUMN panel_version TO cloudpanel_version;
