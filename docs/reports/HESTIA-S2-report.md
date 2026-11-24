# HESTIA-S2: backups, Managed WordPress, monitoring, node setup (HestiaCP sprint S06 + WordPress part of S03), 2026-11-24

Brief: `Nuzm_HestiaCP_Hosting_Master_Prompt.md` sprint S06 and S03 §4 on the Hestia layer of [HESTIA-S1](HESTIA-S1-report.md). Design: [ADR-068](../adr/ADR-068-hestia-backups-wordpress-monitoring.md). Everything below ran against LOCAL MOCK PANELS: **NOT VERIFIED against a real node, no real credentials, no paid calls.**

## A. Findings and assumptions
- The first session's work was uncommitted in the `merge-branches-run-import` worktree; it was committed there (`3460525c`, without the stray `apps/api/.dev-vault.bak-new/` seal key) and this branch was fast-forwarded onto it.
- **Hestia's WordPress "Quick Install" cannot be called**: it is panel PHP (`WordPressSetup.php`) with no CLI command and no REST entry. It is reproduced from the commands it itself calls (`v-delete-fs-file`, `v-add-user-wp-cli`, `v-add-database`, `v-run-cli-cmd … wp core download|config create`, then install, then `v-change-web-domain-tpl … wordpress`). The official file installs through an HTTP POST because of a WP-CLI quirk with spaces in the title; here the title is the domain (no space) and `wp core install` is used. `v-run-cli-cmd` lets the key run a command as a site user: risk R-1 (ADR-068 §3).
- **Hestia documents no encryption of its archives and no return codes for the backup commands.** The platform therefore measures the archive in the off-server store instead of trusting a return code, and records `encrypted: false` instead of claiming the old per-site-key encryption.
- **Whether `v-restore-user` fetches an archive from the remote backup host by itself is NOT DOCUMENTED.** Restore needs the archive in the node's `/backup`; an `ArchiveStager` port copies it. There is NO real stager yet (it needs an SFTP path): on a real node restore and restore drills answer `unsupported` until it is built or a live check shows Hestia fetches it. The mock simulates staging.
- `v-add-backup-host` (password) and `v-schedule-user-restore` (completion unobservable) are deliberately NOT in the REST allow-list; `v-add-user-package` takes a file on the node, so packages are created by the node setup script, not over REST.
- Request format of the REST API, JSON field names of `v-list-user-backups`/`v-list-databases`/`v-list-sys-services`, the database name Hestia gives, the `BACKUPS` package key and the `v-add-sys-api-ip` / `v-list-cron-jobs` forms come from Hestia's repository or earlier sessions' reading, not from a live call. Each is on the live-check list of the runbook.
- No real CloudPanel node ever existed (HESTIA-S1), so "existing CloudPanel sites keep working" is N/A.

## B. Plan and changed files
New: `hosting/internal/hestia/{directory-sink,site-probe,wordpress,packages}.ts`; `hosting/internal/{wordpress,restore-drill,monitor}.service.ts`; `hosting/{site-wordpress,admin-ops}.controller.ts`; migration `1981__hosting__backups_wordpress_monitoring` (+down, dev only); `infra/hosting/node-setup.sh`, `infra/hosting/hestia/nuzm-hosting.profile`; ADR-068; D-53; tests (below). Changed: `commands.ts` (14 more allow-listed commands, 6 new argument patterns), `adapter.ts` (backup, restore, listBackups, deleteBackup, probe, services health), `mock-server.ts`, `ports.ts` (optional sink/adapter methods, WordPress and probe ports, `VaultPort.read`), `backups.service.ts` (schedule/retry state, daily schedule, retention on the node), `site-workflow.ts`/`sites.service.ts`/`plans.service.ts`/`nodes.service.ts`/`hosting-jobs.ts`/`hosting.module.ts`, OpenAPI + SDK, `spec/db/ownership.yaml`, the runbook `docs/runbooks/node-onboarding.md`.

## C. Implemented
- **Backups**: daily `scheduled` backup per active site with a backup quota (oldest scheduled expires first at the limit), on demand, off-server in the node's region store (`RegionDirectorySink`: `HOSTING_BACKUP_DIR_<REGION>`; production stays `none` until D-07), size and streamed sha256 measured in the store, stable-size rule, snapshot of the account, retention (store + node copy), expiring download links, pre-restore safety backup, integrity check before restore, verification after. Idempotent across retries and restarts (one schedule per backup row).
- **Restore drills** (`/v1/admin/hosting/restore-drills`): isolated `restore_drill` node in the backup's region, per-check result, wipe verification, duration.
- **Managed WordPress**: plan `app_kind`, `site_apps`, state machine driven by the observed phase, one-time handover, admin reset, retry, secret clean-up on site deletion. API: `GET …/wordpress`, `POST …/wordpress/{retry,admin-resets,handover}`.
- **Monitoring**: `GET /v1/admin/hosting/alerts`, `POST …/monitor-runs`; 11 alert kinds, idempotent open/refresh/resolve; the panel health now includes Hestia's web, database and PHP-FPM services.
- **Node setup**: `node-setup.sh` (packages per plan, access profile and key, API on + allow-listed addresses, backup host, nightly job off, hidepid), `GET /v1/admin/hosting/node-packages`, runbook steps 3–12 and a live-check list.

## D. Migrations and rollback
`1981` (range M06-INT, forward-only): `nodes.purpose` (+CHECK: a drill node is never `active`), `plan_definitions.app_kind`, `sites.app_kind`, `site_backups.archive_name/provider_state`, tables `site_apps` (org RLS), `restore_drills`, `monitor_alerts` (admin scope). The down script is dev only; production is forward-fix.

## E. Tests run (results in section H)
Commands and results (run in this worktree, Node 22, own Postgres 16 on :54360):
- `pnpm exec tsc --noEmit` in `apps/api`: exit 0.
- `pnpm exec vitest run` in `apps/api` (unit): 1123 passed, 4 skipped; one file (`health.spec.ts`) hit its 10 s boot hook timeout while the machine was loaded by parallel runs and **passed alone (4/4)**. New unit tests: `hestia-backup.spec.ts` 15 (adapter backup/restore against the mock panel and a store), `hestia-wordpress.spec.ts` 15 (WordPress steps, allow-list patterns, `HttpSiteProbe` against a local server), `packages.spec.ts` 6 (packages, profile drift, `RegionDirectorySink` path safety), `node-setup.spec.ts` 3 (the script's dry run with stubbed Hestia CLI, argument refusal).
- Integration: `hosting` + `cloud` + `ops` suites, 15 files, **217 passed** (includes the 4 earlier `hosting-hestia` tests and the new `hosting-hestia-s06.int.spec.ts`, **35 tests**: Shared and WordPress orders, duplicate submission of a quote, one-time handover incl. parallel read, reset, expiry, second worker on the same install, provider timeout, restart before completion, lost answer, bootstrap failure + alert, retry keeping the database and content, capacity exhausted, restart-safety sweep, scheduled/on-demand backups, backup retry without a second archive, stuck backup, restore with staging, tampered archive, retention, backup limit, restore drills (passed / failed / refused), monitoring, customer isolation incl. RLS, secret clean-up on delete). One earlier run of the hosting suite hit a 60 s boot-hook timeout under load on `hosting-hestia.int.spec.ts`; it passed alone and in the final run.
- `pnpm spec:lint` clean, `pnpm spec:drift` OK (522 routes), `pnpm sdk:generate` (SDK regenerated), `pnpm compliance:classification-coverage` OK (3437 columns), `compliance:ropa-coverage` OK, `compliance:residency-hooks` OK, `compliance:claims-guard` OK, `pnpm scan:secrets` OK, `prettier --check` and `eslint apps/api/src/modules/hosting` clean on the changed files.
- **Not run:** browser E2E and `pnpm verify:full` (no UI was built; the full repo `pnpm lint/typecheck/test/build` and the admin/web apps were not re-run), `pnpm db:test-rls`, any live check.

## F. Security, tenant isolation, billing, residency
- Secrets: admin/database passwords generated server-side, vault by reference, never in a table, response, log or audit entry (asserted by scanning every table, the audit log and responses for the actual passwords); handover read-once (parallel calls: exactly one 200 and one 409), `no-store`, no Idempotency-Key by design; expiry deletes the secret; the site's deletion deletes the vault entries.
- Allow-list: WP-CLI arguments one token each; `php` must be `/usr/bin/php<x.y>`, `wp` must be the account's own `.wp-cli/wp`; `v-delete-fs-file` only the two placeholder files of a docroot; backup archive names only `<account>.<timestamp>.tar`; the committed access profile equals the allow-list (drift test); the node setup script refuses shell fragments.
- Isolation (platform side): another organization gets 404 on every WordPress/backup/restore/download route; RLS hides `site_apps` and `site_backups` from a direct query; drills are platform-scope only. **Isolation between accounts ON A NODE is NOT tested here** (needs a real node): runbook live check 6.
- Residency: backups need an allowed region for the organization and are stored in the node's region; a drill refuses a node of another region (403 `residency_denied`).
- Billing/metering: no new billable action; WordPress activation follows payment-confirmed site creation (quote consumed once: a duplicate request returns the same site and operation).

## G. Human gates and live checks still needed
D-07 (production backup store and encryption at rest, `HOSTING_BACKUP_SINK_PRODUCTION=yes`), D-12 (production vault), a real node + key + backup host + drill node (runbook live checks 1–7), the restore **staging path** (SFTP `ArchiveStager`), owner thresholds for the alerts, a decision on a second key for the WordPress role (R-1). Provider-side VPS bootstrap, file manager, cron/logs/FTP, business email are other sessions (S04, S05).

## H. Acceptance (each criterion of the master prompt: local test, live test, or pending a named setup)
Legend: **LOCAL** = proven by a test in this repository against a mock panel/sink; **LIVE** = needs a real node (none run: nothing here is LIVE-VERIFIED); **PENDING** = needs the named setup.

| Master-prompt item | Result |
|---|---|
| S02 repeatable node setup, restricted per-command keys | LOCAL: `node-setup.sh` dry run + argument refusal; access profile generated from the allow-list, drift test. LIVE: run on a real node (runbook 3–5). |
| S03 §4 WordPress: Hestia documented path, dedicated DB, random password by one-time handover | LOCAL: reproduced from documented commands (not a Quick Install call: impossible, ADR-068); dedicated DB, 32-char secrets in the vault, handover once (parallel-safe). LIVE: node with PHP CLI + Hestia. |
| S03 §4 real verification (installs, answers, admin page exists) before "ready" | LOCAL: state `ready` only after the HTTP look (no installer redirect, `wp-login.php` served); `HttpSiteProbe` tested on a local server. LIVE: against a real node and DNS. |
| S03 §4 safe retry keeps content and database | LOCAL: phase-driven resume, WP-CLI refuses to overwrite; tests: timeout, restart, lost answer, second worker, failed + retry. |
| S06 data: entities, no duplicate account/server per order, locks, payment/activation separate | LOCAL: `site_apps` unique per site, quote uniqueness (duplicate returns the same site/op), conditional updates, site active before WordPress ready. |
| S06 scheduled backups of sites, databases and mail | LOCAL: daily schedule, on demand, quota-aware. Sites and databases are inside Hestia's user archive; mail is included by Hestia's archive design but untestable until S05 mail exists: PENDING (S05) + LIVE. |
| S06 stored OFF the server, inside the committed region | LOCAL: archive found and measured in the node's region store, residency hook, drill refuses another region. PENDING: D-07 production store + backup host; encryption at rest (Hestia documents none: `encrypted:false`). |
| S06 retention and permissions | LOCAL: retention deletes store + node copy; expiring signed links; org-bound API, RLS. PENDING: directory/account permissions on the real backup host (runbook 4). |
| S06 restore tested in an isolated site, duration and result recorded | LOCAL: restore drills on a `restore_drill` node (passed / failed / refused), checks, wipe, `durationMs`. LIVE + PENDING: real drill node and the archive staging path (no real stager: restore is `unsupported` on a real node today). |
| S06 monitoring: capacity, activation failure, certificates, backups, panel link | LOCAL: 11 alert kinds, idempotent, auto-resolving, panel link includes web/db/PHP-FPM services. PENDING: scheduler on (`HOSTING_SCHEDULER_INTERVAL_SECONDS`), owner thresholds. |
| S06 tests: Shared and WordPress orders | LOCAL (this session). |
| S06 tests: VPS + Hestia per provider, clean VPS | Not this session (S04). |
| S06 tests: duplicate payment notification | LOCAL for site creation by quote (same site and operation); the payment webhook dedupe itself is M03's. |
| S06 tests: concurrent workers, provider timeout, capacity exhausted, bootstrap failure, restart before completion, restore | LOCAL (WordPress bootstrap and Hestia calls; VPS bootstrap is S04). |
| S06 isolation of customers and folders | LOCAL: organization isolation (404, RLS). LIVE: account-to-account isolation on a node (runbook live check 6) — NOT TESTED. |
| S06 existing CloudPanel sites keep working | N/A: no CloudPanel node ever existed (HESTIA-S1). |
| Acceptance: WordPress order → working site | LOCAL on mocks; LIVE pending. |
| Acceptance: Shared activation with account, site, manageable files | Account and site: LOCAL. Manageable files: S05 (file manager). |
| Acceptance: VPS + Hestia on both providers; email verification | Not this session (S04, S05). |
| Node setup script and packages (`v-add-user-package`) per plan, documented | LOCAL: packages rendered per plan and served; script tested with stubs; runbook rewritten. LIVE: real node. |

## I. Handover and open decisions
Not built (record, do not assume): customer and admin SCREENS for WordPress status/handover, alerts and restore drills (API + SDK only; every screen must be AR/EN with an e2e test: next UI session), custom domain rewrite inside WordPress, drill scheduling (drills are started by an admin), the SFTP stager, per-role Hestia keys, mail data in backups (Hestia's archive includes mail by design; verified only when the mail feature exists, S05).
