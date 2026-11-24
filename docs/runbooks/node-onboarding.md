# Runbook — onboarding a hosting node (HestiaCP)

Status: the control-plane side is built and tested against a MOCK panel. Steps marked **[LIVE]** have never been run on a real node and need a human with a node and the owner's go-ahead. Nothing here is LIVE-VERIFIED.

Design: [ADR-067](../adr/ADR-067-hestiacp-hosting-panel.md). The platform talks to each node's HestiaCP through its REST API (`POST https://<panel fqdn>:<port>/api/`, `hash=ACCESS_KEY_ID:SECRET`, `cmd`, `arg1..N`) using an **allow-listed set of commands** (`apps/api/src/modules/hosting/internal/hestia/commands.ts`). There is no node agent.

Preconditions: a running compute instance known to compute provisioning (Saudi Arabia: Alibaba ECS via SCCC, Riyadh `me-central-1`; Europe: Contabo `EU`), a fixed panel FQDN pointing at it, and an OS image supported by the chosen Hestia version (Debian 12 or Ubuntu 24.04 LTS are the proposed presets: confirm against the Hestia release notes).

1. **Register** — admin console → Hosting → Servers → Register server (`POST /v1/admin/hosting/nodes {name, computeInstanceId}`, `Idempotency-Key`, `hosting_admin`, MFA step-up). The node starts in `maintenance` with no panel connection.
2. **[LIVE] Install HestiaCP** on the instance with the installer of a pinned, approved version (non-interactive options documented for that version), a fixed hostname, PHP-FPM and MariaDB. Record the panel version.
3. **[LIVE] Packages** — create the Hestia package that carries each plan's limits (`v-add-user-package`, on the server): the platform assigns a package, it does not create one. Until a node proves its packages, quota enforcement is not claimed.
4. **[LIVE] Panel API** — enable the API (`v-change-sys-api enable`), allow ONLY the control plane's egress address (`v-add-sys-api-ip <ip>`, never `allow-all`), and keep the panel port off the public internet where possible.
5. **[LIVE] Access key with a restricted profile** — create the file `/usr/local/hestia/data/api/nuzm-hosting` with:

```
ROLE='admin'
COMMANDS='v-list-sys-info,v-list-web-templates-backend,v-list-user-packages,v-list-user,v-list-users,v-list-web-domains,v-list-web-domain,v-list-sys-php,v-list-web-domain-ssl,v-add-user,v-delete-user,v-suspend-user,v-unsuspend-user,v-change-user-package,v-add-web-domain,v-delete-web-domain,v-change-web-domain-backend-tpl,v-add-letsencrypt-domain,v-list-sys-config,v-list-cron-jobs,v-add-cron-job,v-change-cron-job,v-delete-cron-job,v-list-web-domain-accesslog,v-list-web-domain-errorlog,v-add-web-domain-ftp,v-delete-web-domain-ftp,v-change-web-domain-ftp-password,v-add-web-domain-httpauth,v-delete-web-domain-httpauth,v-add-user-sftp-jail,v-list-mail-domains,v-list-mail-domain,v-add-mail-domain,v-delete-mail-domain,v-add-mail-domain-webmail,v-list-mail-domain-dkim,v-list-mail-domain-dkim-dns,v-list-mail-accounts,v-add-mail-account,v-delete-mail-account,v-change-mail-account-password,v-change-mail-account-quota,v-add-mail-account-alias,v-delete-mail-account-alias'
```

   then `v-add-access-key admin nuzm-hosting nuzm-<node> json`. This is the complete list of commands the platform may run (it is generated from `commands.ts`; a test keeps the two in step); a broader profile is a mistake. Keep one key per node.

   The S05 commands in that list and their documented argument order (https://hestiacp.com/docs/reference/cli, read 2026-11-24; **NOT VERIFIED on a real node**):

   | Tool | Command and arguments |
   |---|---|
   | Cron | `v-add-cron-job USER MIN HOUR DAY MONTH WDAY CRON_COMMAND [JOB] [RESTART]` · `v-change-cron-job USER JOB MIN HOUR DAY MONTH WDAY CRON_COMMAND` · `v-delete-cron-job USER JOB` · `v-list-cron-jobs USER [FORMAT]` |
   | Logs | `v-list-web-domain-accesslog USER DOMAIN [LINES] [FORMAT]` · `v-list-web-domain-errorlog USER DOMAIN [LINES] [FORMAT]` (asked as `plain`, at most 500 lines) |
   | FTP | `v-add-web-domain-ftp USER DOMAIN FTP_USER FTP_PASSWORD [FTP_PATH]` · `v-delete-web-domain-ftp USER DOMAIN FTP_USER` · `v-change-web-domain-ftp-password USER DOMAIN FTP_USER FTP_PASSWORD` (accounts are read back from `FTP_USER`/`FTP_PATH` of `v-list-web-domains`: the CLI documents no FTP list command) |
   | Password protection | `v-add-web-domain-httpauth USER DOMAIN AUTH_USER AUTH_PASSWORD [RESTART]` · `v-delete-web-domain-httpauth USER DOMAIN AUTH_USER [RESTART]` (listed from `AUTH_USER` of `v-list-web-domains`) |
   | PHP version | `v-change-web-domain-backend-tpl USER DOMAIN TEMPLATE [RESTART]` (already used by site creation) |
   | SFTP | `v-add-user-sftp-jail USER [RESTART]` (the file manager signs in over SFTP, see below) |
   | Mail | `v-add-mail-domain USER DOMAIN` · `v-delete-mail-domain USER DOMAIN` · `v-list-mail-domains USER` · `v-list-mail-domain USER DOMAIN` · `v-add-mail-domain-webmail USER DOMAIN [WEBMAIL]` · `v-list-mail-domain-dkim USER DOMAIN` · `v-list-mail-domain-dkim-dns USER DOMAIN` · `v-list-mail-accounts USER DOMAIN` · `v-add-mail-account USER DOMAIN ACCOUNT PASSWORD [QUOTA]` · `v-delete-mail-account USER DOMAIN ACCOUNT` · `v-change-mail-account-password USER DOMAIN ACCOUNT PASSWORD` · `v-change-mail-account-quota USER DOMAIN ACCOUNT QUOTA` · `v-add-mail-account-alias USER DOMAIN ACCOUNT ALIAS` · `v-delete-mail-account-alias USER DOMAIN ACCOUNT ALIAS` |
   | Capability probe | `v-list-sys-config` (the installed services: `FTP_SYSTEM`, `MAIL_SYSTEM`, `IMAP_SYSTEM`, `WEBMAIL_SYSTEM`) |
6. **Connect** — admin console → Hosting → Servers → the node → Panel connection: host (FQDN), port (8083), the TLS fingerprint if the panel certificate is self-signed, and the access key (`ACCESS_KEY_ID:SECRET`, write-only; outside production only until the vault decision D-12, otherwise a `vault://` reference).
6a. **[LIVE] File manager prerequisites** — the file manager is SFTP, not a panel command: the node's `sshd` must accept the SFTP subsystem for the site accounts (the Hestia file-manager page names `Subsystem sftp internal-sftp`), reachable from the control plane at `HOSTING_SFTP_PORT` (default 22) on the panel FQDN, and each site account must be allowed to use it (`v-add-user-sftp-jail` confines it to its home: confirm the jailed layout, because the platform expects the website folder at `<home>/web/<domain>/public_html`). The first connection pins the node's SSH host key (`hosting.nodes.sftp_host_key_sha256`); **compare it with the node's own `ssh-keygen -lf` output**, because a first use over the network cannot prove it. Every later connection must match it (a mismatch refuses the session).
6b. **[LIVE] Optional services** — FTP (vsftpd/proftpd) and the mail stack (exim, dovecot, a webmail) are installed or not by the Hestia installer options of the node. The platform offers FTP and business email only where `v-list-sys-config` reports them; a node without them shows those tools as unavailable.
7. **Test** — "Test connection" runs the inventory: panel version, health, runtimes (PHP versions with a backend template, plus `static`) and capacity (measured by the compute provider, minus the platform reserve). A wrong key is an auth failure; an unreachable panel is an outage; neither is guessed around.
8. **Activate** — "Activate" (`PATCH … {status:'active'}`) needs a panel connection, healthy fresh inventory and reported runtimes. Changing the panel connection returns an active node to maintenance: test it again.
9. **Day 2** — certificate expiry of the panel itself (a pinned fingerprint must be updated when it changes), key rotation (create a new key, connect it, delete the old with `v-delete-access-key`), version updates (re-run the test), draining and migration (drain-and-migrate runbook).

Rollback: set the node `draining`, migrate sites, `retired` when empty; production data is never dropped by migration down files.
