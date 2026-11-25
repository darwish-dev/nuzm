-- HestiaCP becomes the hosting panel (owner request 2026-11-24; replaces the CloudPanel node-agent design, ADR-067).
--  * `cloudpanel_version` is the panel's version in general: renamed `panel_version`.
--  * A node is reached through its panel's REST API: host, port, an optional pinned TLS fingerprint and a vault REFERENCE of the access key.
--    The key itself is never stored here (the column is a vault reference, like every other `*_ref` column).
--  * The agent tables (`node_agents`, `node_enrolment_tokens`, `node_command_log`) stay: migrations are forward-only and they hold history; nothing writes to them any more.
ALTER TABLE hosting.nodes RENAME COLUMN cloudpanel_version TO panel_version;
ALTER TABLE hosting.nodes
  ADD COLUMN panel_kind text NOT NULL DEFAULT 'hestia' CHECK (panel_kind IN ('hestia')),
  ADD COLUMN panel_host text CHECK (panel_host IS NULL OR panel_host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  ADD COLUMN panel_port int CHECK (panel_port IS NULL OR panel_port BETWEEN 1 AND 65535),
  ADD COLUMN panel_key_ref text CHECK (panel_key_ref IS NULL OR panel_key_ref ~ '^vault://[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$'),
  ADD COLUMN panel_tls_pin text CHECK (panel_tls_pin IS NULL OR panel_tls_pin ~ '^([0-9A-F]{2}:){31}[0-9A-F]{2}$');
