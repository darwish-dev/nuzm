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
