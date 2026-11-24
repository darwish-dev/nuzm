# ADR-067: HestiaCP is the hosting panel (replaces the CloudPanel node-agent design, ADR-020)

- Status: **Proposed** (owner request 2026-11-24; binding once the owner accepts it)
- Supersedes: ADR-020 (CloudPanel automation path). D-20 is answered by this record.
- Evidence: HestiaCP CLI reference https://hestiacp.com/docs/reference/cli and REST API page https://hestiacp.com/docs/server-administration/rest-api (read 2026-11-24); the output of Hestia's own `v-list-*` scripts in https://github.com/hestiacp/hestiacp (`bin/`), and the API examples https://github.com/hestiacp/hestiacp-api-examples.

## Context
Shared hosting ran on a design built around CloudPanel: its CLI has no remote surface, no site listing, no cron/logs/SSH/FTP/PHP-settings commands, a licence question (ADR-020, HG-06-01) and a history of privilege escalations, so ADR-020 proposed a bespoke signed-envelope node agent. That agent was never built beyond a simulation.

## Decision
1. **HestiaCP is the only hosting panel.** Each node runs HestiaCP; the platform reaches it through Hestia's **REST API** (`POST https://<panel fqdn>:<port>/api/`, `hash=ACCESS_KEY_ID:SECRET`, `cmd`, `arg1..N`, `returncode`), with a per-node access key restricted to an allow-listed command profile. No node agent, no shell strings, no browser-supplied host, command or key.
2. The **site is a Hestia account** whose name is the token-derived `s-<hex>` of the hosting contract: `findByToken` is `v-list-user`, so reconcile-before-retry needs nothing else (a lost answer on a mutating command is `uncertain`).
3. The panel connection (FQDN, port, optional pinned TLS fingerprint, vault reference of the access key) lives on `hosting.nodes`; the key is typed once in the admin console (write-only, sealed; production waits on D-12) or supplied as a vault reference.
4. Limits are Hestia **packages** assigned by the platform; the node setup creates them. No CPU/RAM guarantee is claimed until a measurement and enforcement mechanism is proven on a real node.
5. Not in this decision (later sprints, each its own session): VPS with an auto-installed Hestia (Alibaba SCCC Riyadh, Contabo EU), WordPress, SFTP file manager, cron/logs/FTP/HTTP-auth/PHP tools, business email, off-server backups, per-site isolation tests on a real node.
6. The previous simulation is kept only as test doubles under `hosting/internal/mock/sim/` (platform logic tests: capacity, reconcile, quotas, abuse); it is not a product path.

## Consequences
- Everything is NOT VERIFIED until a human-run probe against a real node (the owner supplies the node and the key). The REST page documents the return codes and the access-key mechanism but not the request format; the format used here is that of the official examples repository (`POST /api/`, form fields) and must be confirmed by the live probe.
- Hestia's `v-list-web-domain-ssl` returns the private key with the certificate: the adapter parses the expiry only and drops the rest.
- Backups, custom certificates, databases (M08), Node.js/Python runtimes and reverse proxies are `unsupported` in the adapter until built and tested.
- CloudPanel data (the old node-agent tables) stays in the database (forward-only migrations) but nothing writes to it. Existing sites in this repository's dev databases are demo data on a simulation; no real CloudPanel node ever existed.

## Addendum S05 (2026-11-24): website tools and business email

- **Panel-backed tools** (cron, logs, FTP accounts, password protection, PHP version, business email) use only commands added to the same allow-list (`hestia/commands.ts`, documented argument order from https://hestiacp.com/docs/reference/cli, read 2026-11-24); the access-key profile in `docs/runbooks/node-onboarding.md` is the same list and a unit test keeps the two identical. The CLI documents no FTP or HTTP-auth *list* command: those lists are read from `FTP_USER`/`FTP_PATH`/`AUTH_USER` of `v-list-web-domains` (shape from Hestia's own scripts, **NOT VERIFIED**).
- **The file manager is SFTP, not a panel command.** The control plane signs in over SFTP as the site's own account with the password it holds in the vault (never root, never a shell; `VaultPort.get` is the one new read path). Every path is proven inside `<home>/web/<domain>/public_html` on the live session, and links are never followed (`internal/tools/path-guard.ts`). This is defence in depth; the node's own permissions/jail remain the boundary. **New dependency: `ssh2`** (pure JavaScript; its optional native add-on was not built). **Decision item:** the node's SSH host key is pinned on first use (`hosting.nodes.sftp_host_key_sha256`); the runbook asks an operator to compare it out of band. Until an owner decision, a first-use pin over the network is the accepted limit.
- **Business email never writes DNS.** The DNS port is read-only; an MX/SPF/DKIM set that points elsewhere is reported `external` and kept. Moving mail is the customer publishing the displayed records.
- **Limits are proposals** (`tools/tools-config.ts`, per-plan overrides with the same-named `quotas` keys); a plan without a `mailboxes` quota sells no mail.
- No new tenant table: the panel is the source of truth for jobs, accounts and mailboxes; counts are enforced under a per-site advisory lock.
