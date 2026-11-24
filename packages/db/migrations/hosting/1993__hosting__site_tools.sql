-- HestiaCP S05: customer permissions of the website tools (file manager over SFTP, cron, logs, FTP accounts, password protection, business email) and the pinned SSH host key of
-- a node (the file manager signs in over SFTP; the key it saw on first use is kept and every later connection must match it).
--  * owner and admin: everything. developer: everything except managing mailboxes. billing_admin and viewer: none of these (a file, a log line or a mailbox is not billing data).
--  * No new tenant table: cron jobs, FTP accounts, HTTP-auth users and mailboxes live on the panel (the site's own account), and the platform reads them from there for every
--    check, so nothing here can drift from what the node really has. Counts are enforced against the plan under a per-site lock in the service.
INSERT INTO tenancy.permissions (name, scope, description) VALUES
  ('hosting:files:read','org','Browse and download the files of a hosting site (SFTP, site account)'),
  ('hosting:files:write','org','Upload, edit, rename and delete the files of a hosting site'),
  ('hosting:cron:manage','org','Create, change and delete the scheduled jobs of a hosting site'),
  ('hosting:logs:read','org','Read the access and error logs of a hosting site (bounded line count)'),
  ('hosting:ftp:manage','org','Create, change and delete the FTP accounts of a hosting site'),
  ('hosting:protection:manage','org','Protect a domain of a hosting site with a password'),
  ('hosting:mail:read','org','See the business email of a hosting site (mailboxes, settings, DNS checks)'),
  ('hosting:mail:manage','org','Create and change mailboxes and aliases of a hosting site');
INSERT INTO tenancy.role_permissions SELECT r, p FROM unnest(ARRAY['owner','admin']) r, unnest(ARRAY['hosting:files:read','hosting:files:write','hosting:cron:manage','hosting:logs:read','hosting:ftp:manage','hosting:protection:manage','hosting:mail:read','hosting:mail:manage']) p;
INSERT INTO tenancy.role_permissions SELECT 'developer', p FROM unnest(ARRAY['hosting:files:read','hosting:files:write','hosting:cron:manage','hosting:logs:read','hosting:ftp:manage','hosting:protection:manage','hosting:mail:read']) p;

ALTER TABLE hosting.nodes ADD COLUMN sftp_host_key_sha256 text CHECK (sftp_host_key_sha256 IS NULL OR sftp_host_key_sha256 ~ '^SHA256:[A-Za-z0-9+/]{43}$');
COMMENT ON COLUMN hosting.nodes.sftp_host_key_sha256 IS 'SSH host key fingerprint of the node as OpenSSH prints it; set on the first file-manager connection, then every connection must match (a mismatch refuses the session).';
