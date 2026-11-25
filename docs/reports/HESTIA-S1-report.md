# HESTIA-S1: HestiaCP replaces CloudPanel (foundations), 2026-11-24

Owner request: remove CloudPanel completely; add HestiaCP according to the attached master prompt (S01-S06); redesign website, hosting and server management. This sprint is the foundation (S01 and S02 control-plane side, the core of S03). The rest is split into separate sessions (see G).

## A. Findings and assumptions
- Hestia documents a CLI (`v-*` commands, with argument order) and an access-key mechanism with command profiles and return codes. Its REST page does NOT document the request format; the format used here is the official examples repository's (`POST https://<host>:8083/api/`, form fields `hash`, `cmd`, `argN`, `returncode`). **Confirmed only by a live probe.** JSON shapes of `v-list-*` come from Hestia's own scripts in its repository.
- The existing hosting contract (`HostingAdapter`) was already panel-agnostic: the site is the on-node account named `s-<hex>`, so reconcile-before-retry is `v-list-user`. No node agent is needed with Hestia (ADR-067 supersedes ADR-020).
- Removing CloudPanel "completely" was confirmed by the owner. No real CloudPanel node ever existed (demo data on a simulation). The old simulation is kept only as test doubles (`hosting/internal/mock/sim/`) so the platform's own logic stays tested; the agent tables stay in the database (forward-only) but nothing writes to them.
- `ADR-067`, `D-52` (D-20 superseded), runbook `docs/runbooks/node-onboarding.md` (rewritten), `docs/adapters` not needed (Hestia is cited in the ADR).

## B. Changed files (main)
New: `hosting/internal/hestia/{commands,client,adapter,connections,mock-server}.ts` + `hestia.spec.ts`; migrations `hosting/1980__hestia_panel`, `cloud/1985__hestia_provider`; admin `HostingNodeForms`, `lib/hosting-node`, Servers list and detail pages; `hosting-hestia.int.spec.ts`. Changed: `nodes.service` (panel connection instead of agent enrolment), `hosting.module` (Hestia adapter + sealed vault port), `admin-nodes.controller`, OpenAPI (+`PUT …/nodes/{id}/panel`, −enrolment tokens, command log, agents), SDK, i18n, website page. Removed: the CloudPanel adapter, agent envelope/runtime/transport, agent and isolation test suites, the admin agents page, the node-agent threat-model runbook, CloudPanel texts.

## C. Delivered
- **HestiaCP adapter** (NOT VERIFIED): probe (documented read commands), inventory, create/find/update/suspend/resume/delete site (a Hestia account + domain + PHP template), managed TLS (Let's Encrypt, expiry read from `v-list-web-domain-ssl`, key dropped), usage. A 16-command allow-list with documented argument order and per-argument patterns; documented return codes mapped to errors; a lost answer on a mutating command is `uncertain`. Panel host is a fixed FQDN (no IP), TLS validated or pinned by fingerprint.
- **Server management (admin)**: Hosting → Servers: register a server, connect its panel (host, port, TLS pin, access key typed once: write-only, sealed, only a vault reference stored; production waits on D-12), test connection (inventory), activate / maintenance / drain, setup steps, capacity.
- **Website management (customer)**: header, one Insights block with every plan limit, tiles to open each part, planned tools as "Coming soon" (file manager, cron, runtime settings, logs, FTP, protection: each has a documented Hestia way and is S05).

## D. Migrations and rollback
`hosting/1980` renames `cloudpanel_version` to `panel_version` and adds `panel_kind/host/port/key_ref/tls_pin`; `cloud/1985` renames the seeded provider row to `hestia`. Down scripts are dev-only; production is forward-fix.

## E. Tests run
`hestia.spec.ts` 14 (adapter against the mock panel incl. lost-answer reconcile, return codes, wrong key); `@nuzm/api` unit 1088 passed; hosting integration (existing suites on the simulation + `hosting-nodes` rewritten for the panel flow + `hosting-hestia.int.spec.ts` 4: the whole workflow through the REAL adapter against the mock panel); admin tests; spec lint/drift/sdk checks; classification coverage (3386 columns); claims guard; secret scan. **Not run:** browser E2E (`07-hosting-admin` updated, NOT RUN), the admin Servers pages in a browser (no admin credentials; covered by component tests), Arabic/light theme of the new screens.

## F. Security
Typed panel key: write-only, sealed, canary test asserts it is absent from responses, database and audit. Allow-listed commands only; arguments validated by pattern; nothing from a browser request becomes a host, command or key. The certificate command's private key is parsed away. Per-site password is generated server-side and held only in the vault.

## G. Human gates and what is NOT done
- **Live check** (owner supplies a node, the access key and an approved Hestia version): probe, create/delete, TLS, suspend. Everything above is NOT VERIFIED until then; production typed keys need D-12.
- **Not built in this sprint (separate sessions):** S04 VPS with auto-installed Hestia on Alibaba (SCCC Riyadh `me-central-1`) and Contabo (`EU`) with cloud-init, bootstrap steps and registration tokens; S05 SFTP file manager, cron, logs, FTP, HTTP-auth, PHP tools, business email; S06 off-server backups and restores (the adapter reports backups `unsupported`), isolation tests on a real node, WordPress; node setup script and packages (`v-add-user-package`); migration of customers; Node.js/Python runtimes (`unsupported`).
- Customer "server management" for VPS (compute) is unchanged here and belongs to S04.

## H. Acceptance
| Item | Status |
|---|---|
| CloudPanel removed from code, UI, spec and runbooks | PASS (history in ADRs/reports kept) |
| Hestia adapter + allow-list + node registry + admin screens | PASS against the mock; NOT VERIFIED live |
| Shared site activation through Hestia (platform workflow) | PASS (mock panel) |
| WordPress, VPS + Hestia, file manager, email, backups | NOT BUILT (S03 WordPress, S04, S05, S06) |
