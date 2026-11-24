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
COMMANDS='v-list-sys-info,v-list-sys-php,v-list-web-templates-backend,v-list-user-packages,v-list-users,v-list-user,v-list-web-domains,v-list-web-domain-ssl,v-add-user,v-delete-user,v-suspend-user,v-unsuspend-user,v-change-user-package,v-add-web-domain,v-change-web-domain-backend-tpl,v-add-letsencrypt-domain'
```

   then `v-add-access-key admin nuzm-hosting nuzm-<node> json`. This is the complete list of commands the platform may run; a broader profile is a mistake. Keep one key per node.
6. **Connect** — admin console → Hosting → Servers → the node → Panel connection: host (FQDN), port (8083), the TLS fingerprint if the panel certificate is self-signed, and the access key (`ACCESS_KEY_ID:SECRET`, write-only; outside production only until the vault decision D-12, otherwise a `vault://` reference).
7. **Test** — "Test connection" runs the inventory: panel version, health, runtimes (PHP versions with a backend template, plus `static`) and capacity (measured by the compute provider, minus the platform reserve). A wrong key is an auth failure; an unreachable panel is an outage; neither is guessed around.
8. **Activate** — "Activate" (`PATCH … {status:'active'}`) needs a panel connection, healthy fresh inventory and reported runtimes. Changing the panel connection returns an active node to maintenance: test it again.
9. **Day 2** — certificate expiry of the panel itself (a pinned fingerprint must be updated when it changes), key rotation (create a new key, connect it, delete the old with `v-delete-access-key`), version updates (re-run the test), draining and migration (drain-and-migrate runbook).

Rollback: set the node `draining`, migrate sites, `retired` when empty; production data is never dropped by migration down files.
