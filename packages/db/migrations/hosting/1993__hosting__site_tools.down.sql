-- DEV ONLY (production is forward-fix): removes the S05 permissions and the pinned host key column.
DELETE FROM tenancy.role_permissions WHERE permission IN ('hosting:files:read','hosting:files:write','hosting:cron:manage','hosting:logs:read','hosting:ftp:manage','hosting:protection:manage','hosting:mail:read','hosting:mail:manage');
DELETE FROM tenancy.permissions WHERE name IN ('hosting:files:read','hosting:files:write','hosting:cron:manage','hosting:logs:read','hosting:ftp:manage','hosting:protection:manage','hosting:mail:read','hosting:mail:manage');
ALTER TABLE hosting.nodes DROP COLUMN IF EXISTS sftp_host_key_sha256;
