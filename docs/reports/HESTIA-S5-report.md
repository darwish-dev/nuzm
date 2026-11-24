# HESTIA-S5: website tools and business email, 2026-11-24

Scope (Nuzm HestiaCP master prompt, sprint S05): (1) a file manager over SFTP as the site's own account; (2) cron, logs, FTP accounts, password protection, PHP version, capability display; (3) business email within the plan quota. Built on the S1 foundation ([HESTIA-S1-report](HESTIA-S1-report.md), [ADR-067](../adr/ADR-067-hestiacp-hosting-panel.md)).

**Every Hestia behaviour below is NOT VERIFIED.** No real HestiaCP node, SFTP server, mail server or DNS zone has been used. What was exercised is the production code of the API and services against (a) a local mock of the panel's REST API (`hestia/mock-server.ts`, shaped from the CLI reference), (b) a real local directory standing in for the SFTP server (`mock/local-sftp.ts`: real symbolic links, exclusive create, no-follow opens) and (c) a DNS table. The mock only proves our code; it is never vendor evidence.

## A. Findings and assumptions

- **Documentation read** (https://hestiacp.com/docs/reference/cli header v1.10.9, `server-administration/file-manager`, `server-administration/email`, read 2026-11-24): every command and its argument order is quoted in `docs/runbooks/node-onboarding.md`. Findings that shaped the design:
  - The CLI documents **no `v-list-` command for FTP accounts or HTTP-auth users**. The lists are read from `FTP_USER` / `FTP_PATH` / `AUTH_USER` of `v-list-web-domains` (the field names come from Hestia's own scripts; **NOT VERIFIED**). Hestia prefixes FTP account names with the site account (`<user>_<name>`); the service therefore reads the real name back after creating.
  - `v-change-cron-job` and `v-delete-cron-job` take no `RESTART`; `v-add-cron-job` takes an optional `JOB` id, which the service uses to make a retry idempotent (it chooses the next id and reconciles against `v-list-cron-jobs`).
  - The file-manager page documents the SFTP subsystem line only; **jail layout, shell and the `public_html` path are not documented there**. The platform assumes `<home>/web/<domain>/public_html` (Hestia's usual layout) and `v-add-user-sftp-jail` is in the allow-list for the operator; the runbook tells the operator to confirm the layout on the first node.
  - The email page names SnappyMail and `v-add-mail-domain-webmail USER DOMAIN [WEBMAIL]` accepts `roundcube`/`snappymail`; it gives no IMAP/SMTP ports and no PTR steps. The mail client ports shown (993/143, 465/587) are exim/dovecot defaults and are labelled NOT VERIFIED in the API answer.
  - **No panel version is documented for any of these commands.** `minPanelVersion` is therefore `null` for every tool: the catalog has the gate (`versionAtLeast`) and the report shows the node's panel version, but no minimum is claimed that a document does not state.
- **Capabilities come from the node, not from us**: `v-list-sys-config` (FTP_SYSTEM, MAIL_SYSTEM, IMAP_SYSTEM, WEBMAIL_SYSTEM) is read by the inventory and stored in the node's `last_inventory`; a node that does not report a service shows that tool as unavailable (`panel_service`), never guessed.
- The vault port had no read path (the earlier design let a node agent resolve secrets). The file manager must sign in as the site account, so `VaultPort.get` (optional) was added; production keeps the blocking vault (D-12), so **the file manager is unavailable in production until the vault decision**.
- No metering event was added: none of these tools is a separately billable action (limits are plan quotas). Recorded as an assumption; a future per-mailbox price would add a metering dimension through the central pipeline.
- Limits (cron jobs 5, FTP accounts 2, protection users 3, mailboxes 0, aliases 5, mailbox quota 1024 MB, upload 25 MB / ceiling 60 MB, edit 1 MiB, download 50 MB, cron interval ≥ 5 min, logs ≤ 500 lines) are **PROPOSALS** (`tools/tools-config.ts`, environment overrides, per-plan override with the same-named `quotas` keys). A plan without `mailboxes` sells no mail.

## B. Plan and changed files

New API: `hosting/internal/tools/{tool-context,site-tools.service,files.service,mail.service,path-guard,sftp,dns,cron-schedule,tools-config}.ts`, `hosting/internal/mock/local-sftp.ts`, controllers `site-tools.controller.ts`, `site-files.controller.ts`, `site-mail.controller.ts`, migration `hosting/1983__site_tools` (+ down), tests `tools.spec.ts` and `hosting-tools.int.spec.ts`.
Changed API: `hestia/commands.ts` (29 new allow-listed commands, 8 new argument kinds, plain-text reads), `hestia/client.ts` (plain mode), `hestia/mock-server.ts` (cron, logs, FTP, HTTP auth, mail, sys-config), `hestia/adapter.ts` (inventory reads installed services), `ports.ts`, `nodes.service.ts`, `hosting.module.ts` (client provider, tool services; the adapter is built on the shared client), `tokens.ts`.
Spec/SDK: `spec/openapi/openapi.yaml` (24 paths, 31 schemas), `packages/sdk/src/schema.ts` (regenerated), `spec/db/ownership.yaml` (one column class).
Web: `lib/hosting-tools.ts` (the "coming soon" list is replaced by the tool catalog), `lib/hosting-tools-client.ts`, `lib/hosting-tool-page.tsx`, components `HostingFiles`, `HostingTools` (cron, logs, FTP, protection, PHP), `HostingMail`, pages `hosting/sites/[id]/{files,cron,logs,ftp,protection,php,mail}`, the website overview page, `packages/i18n` (182 keys, ar + en), `packages/ui` console CSS.
Docs: `docs/runbooks/node-onboarding.md` (access-key profile = the allow-list; SFTP and optional-service steps), ADR-067 addendum, this report. New dependency: **`ssh2`** (+ `@types/ssh2`).

## C. Delivered

- **File manager** (`GET/DELETE …/files`, `GET …/files/download`, `GET/PUT …/files/text`, `PUT …/files/content`, `POST …/files/folders`, `POST …/files/renames`): list, download, upload (raw bytes), edit text with a content hash (409 when the file changed since it was opened), create folder, rename, delete (recursive only on request, bounded entries). SFTP as `s-<hex>`, never root. **Path containment on every action**: relative paths only, no `..`/controls/backslash; the website folder must resolve inside the account's home; every component is looked at without following links and a link anywhere on the path is refused (the only link action is removing the link itself); the walked path must equal the real path; writes go through a temporary file and a rename. Plan upload limit and disk quota are checked before a byte is written; downloads and edits are size-capped; listings capped at 1000 entries. Mutations are audited with path and size, never content. The node's SSH host key is pinned on first use.
- **Panel tools**: cron (create/list/change/delete, schedule parsed and interval-bounded, plan count under a per-site lock, lost answers reconciled), logs (bounded line count, cut again server-side, line length bounded, control characters removed), FTP accounts, password protection, PHP version (the existing site update with `v-change-web-domain-backend-tpl`; the tool page lists the versions the node offers that the plan allows). Memory and upload limits are **not offered**: they would need prepared templates on the node.
- **Capability report** `GET …/tools`: per tool `available | unavailable` with a reason (`role`, `site_state`, `connection`, `panel_version`, `panel_service`, `plan`), the plan limits, the panel version and the connection state. The API refuses an unavailable tool too (422/503), not only the screen. The website overview shows the seven tools from this answer; **no tool is "coming soon" any more** because each works against the mock panel in the tests below.
- **Business email**: enable mail on a customer domain (never the platform placeholder), mailboxes with password and quota (plan count and quota ceiling under the per-site lock), aliases (per-mailbox limit), webmail link, IMAP/SMTP settings, and **read-only** DNS checks: MX, SPF, DKIM (compared with the panel's key when it can be read), DMARC, mail and webmail hosts, forward-confirmed PTR. An MX or SPF that points elsewhere is `external` and kept; the DNS port has no write method.
- Screens (ar/en, RTL, keyboard-reachable forms with labels, loading/empty/error/forbidden states, localized error texts): files, cron, logs, FTP, protection, PHP, mail.

## D. Migrations and rollback

`hosting/1983__hosting__site_tools.sql`: eight permissions (`hosting:files:read|write`, `cron:manage`, `logs:read`, `ftp:manage`, `protection:manage`, `mail:read|manage`) with role grants (owner/admin all; developer all except `mail:manage`; viewer and billing_admin none) and `hosting.nodes.sftp_host_key_sha256` (classified `internal`). No new tenant table: jobs, accounts and mailboxes live on the panel. The ordinal 1983 is in the M06-INT range (1980–1984); parallel sprints (S04, S06) must not reuse it. Down script is dev-only; production is forward-fix.

## E. Tests run (actual results)

| Command | Result |
|---|---|
| `vitest run src/modules/health src/modules/hosting` (unit; includes `tools.spec.ts` and `hestia.spec.ts`; `health.spec` boots the whole `AppModule`, so it proves the new providers resolve) | 5 files, 51 passed (the S05 unit suite covers: cron schedule, allow-list argument order and refusal of newlines/`..`/short passwords, runbook profile = allow-list, plain-text reads through the real client, path containment on a real directory with real symlinks) |
| `vitest run --config vitest.integration.config.mts src/modules/hosting/hosting-tools.int.spec.ts` | 1 file, **42 passed** (run twice: 41 passed before the final lost-answer-on-delete test was added; the second run is the final state) |
| `pnpm --filter @nuzm/api exec vitest run` (all API unit tests) | first full run: 81 files passed, 1 failed (`health.spec.ts`, a 10 s `beforeAll` timeout while the machine was loaded: 1103 tests passed, 4 skipped); the same spec re-run alone with the hosting unit suites passed (row above) |
| `pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts src/modules/hosting` (all hosting integration suites, regression) | 9 files, **130 passed** (the S1 suites on the simulation and on the mock panel, nodes, sites, domains/SSL, S26/S27, site ops, and the S05 suite as it was at that run); the final S05 suite state is the 42-test row |
| `pnpm --filter @nuzm/web exec vitest run lib components/Hosting` | 45 files, 500 passed |
| `pnpm --filter @nuzm/i18n test` | 9 passed (identical keys and placeholders in ar and en) |
| `pnpm --filter @nuzm/web typecheck`, `tsc` of `@nuzm/api` (hosting files) | no errors |
| `pnpm spec:lint`, `pnpm spec:drift` (542 routes declared and implemented), `pnpm sdk:check` | spec:lint: no results at warn or higher; spec:drift: 542 routes implemented and declared; sdk:check: up to date |
| ESLint of the changed API and web files | clean |
| `pnpm scan:secrets`, `pnpm compliance:claims-guard` | secret scan OK (2830 files, 0 hits; it first flagged two literal passwords in the new test, now constants); claims guard OK (1311 files). On a throwaway migrated database (dropped afterwards): `compliance:classification-coverage` OK (3387 columns in 270 tables), `compliance:ropa-coverage` OK, `compliance:residency-hooks` OK; `db:migrate` applied `1983:site_tools` |

Integration suite coverage: capabilities per role (owner, developer, viewer), per plan, per panel service and per connection state; cron (concurrency on the plan limit, lost answer before/after the effect, idempotent replay); logs (bounds, foreign domain); FTP/protection (limits, password never stored/audited/returned); PHP; files (traversal, absolute paths, controls, three kinds of symbolic-link attack, upload/overwrite/413/409, hash-checked edit, recursive delete, wrong site password → 503 without the secret, audit without content); mail (concurrent mailbox limit, quota ceiling, aliases, external-record preservation and move to ok, PTR mismatch, plan without mail); every command that reached the mock panel is in the allow-list.

## F. Security, tenant isolation, billing, residency

- **Tenant isolation**: each tool resolves the site through the caller's organization (another organization's id is 404 and opens no SFTP session: asserted by counting sessions), then acts only on that site's own panel account; a domain or account of another customer is not in the account's own domain list, so it is 404. Cross-tenant tests exist for cron, logs, FTP, protection, files and mail.
- **Authorization**: eight new permissions; viewers get nothing; the API enforces them per route and per capability, and the capability report tells the caller why a tool is closed.
- **Secrets**: FTP/HTTP-auth/mailbox passwords are validated, sent to the panel once, and never stored, logged, audited or returned (asserted by scanning audit rows, the sites table and responses). The site SFTP password is read from the vault at call time and never leaves the process. Cron commands are not audited (they may contain tokens).
- **Idempotency/reconcile**: side-effecting POSTs need `Idempotency-Key`; a lost panel answer on a mutating command is reconciled against the list before any retry (cron create/delete, FTP, protection, mailbox, mail domain).
- **Residency/billing**: no new vendor call; DNS lookups are read-only resolver queries. No ledger or metering path is touched.
- **Honest limits of the containment check**: it is made over the network and cannot be atomic with the operation after it; the account's own operating-system permissions (and the SFTP jail, if the node has one) are the real boundary. A hard link inside the site to a file the same account owns elsewhere cannot be told apart by path. Both are said in `path-guard.ts` and the runbook.
- The SSH host key is pinned on first use over the network (an operator should compare it out of band). Open decision item.

## G. Human gates and live checks still needed

Nothing here is LIVE-VERIFIED. With a real node and the owner's go-ahead: (1) run the runbook probe and confirm the `v-list-web-domains` field names (`FTP_USER`, `FTP_PATH`, `AUTH_USER`), the FTP account-name prefix, the mail JSON shapes (`v-list-mail-accounts`, `v-list-mail-domain-dkim-dns`) and the plain log format; (2) confirm the SFTP subsystem/jail layout and `public_html` path, and the pinned host key; (3) provision FTP and mail services by installer option and re-run the inventory; (4) mail delivery: SMTP receive and send with external providers, PTR/relay on Alibaba (outbound port 25) and Contabo, per the master prompt, before mail is sold; (5) D-12 (production vault) for the file manager; (6) owner decisions on the proposed limits, the first-use host-key pin and the `ssh2` dependency. Browser E2E for the new screens was **not run** (see H).

## H. Acceptance

| Item | Status |
|---|---|
| File manager over SFTP under the site account, path and symlink containment on every action, plan upload limits | PASS against the local SFTP double; NOT VERIFIED on a real node |
| Cron, logs (bounded), FTP, password protection, PHP version through allow-listed documented commands | PASS against the mock panel; NOT VERIFIED live |
| Commands in the allow-list with documented argument order and in the access-key profile of the runbook | PASS (unit test keeps them identical) |
| "Coming soon" tiles replaced only by tools that work against the mock panel | PASS (all seven) |
| Capability display per panel version, role, plan and connection state | PASS (panel-version gate exists; no minimum version is documented, so none is claimed) |
| Business email: mailbox, password, quota, aliases, webmail link, IMAP/SMTP settings, MX/SPF/DKIM/DMARC/PTR checks, external records kept | PASS against the mock panel and DNS table; delivery tests with external providers NOT VERIFIED / BLOCKED (needs a node and mail ports) |
| Memory and upload limits for PHP | NOT BUILT (needs node templates) |
| Browser E2E and screenshots of the new screens (Arabic and English) | NOT RUN (the E2E stack has no Hestia/SFTP double; component specs cover the catalog and error texts) |
| Customer VPS file management over SSH | NOT BUILT (S04 territory) |

## I. Handoff and open decisions

- Merge notes: migration ordinal **1983** is taken; the allow-list, mock panel, `HESTIA_CLIENT` provider and `VaultPort.get` are shared extension points for S04/S06. `NodeState.services` is optional so older adapters keep working.
- Next: a live probe on one node (G), an E2E harness that starts the mock panel and the SFTP double, the DNS write path for zones Nuzm manages (M07; today the records are only shown), mail delivery checks, per-mailbox backup (S06), and a decision on whether mail becomes a billable dimension.
