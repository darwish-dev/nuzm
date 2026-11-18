# S25 — scheduler, site lifecycle, domains/SSL, DB bindings (M06)

Owner-directed exception: built without M05 (ports + `docs/reports/M06-m05-interface-assumptions.md`). Committed together with S26 (the site read model joins the quota and usage tables, so the migrations and the wiring are one unit): see M06 report §B.

## A. Findings and assumptions
`ComputeProvisioningPort`, `DomainOwnershipVerifier`, `DatabaseBindingProvider`, `VaultPort`, `BackupSink` are mocks (assumptions A-02..A-07). `/v1/hosting/plans` is the plan catalogue filtered by capacity + residency; **prices are PLACEHOLDERS** (`plan_definitions.placeholder`) and a quote is refused (`kind_not_available`) unless the price book has a price for `hosting.site_months` or the plan carries an owner-approved non-placeholder price. Feature flag `hosting.enabled` (default OFF) gates every customer route (404).

## B. Changed files
Migrations `hosting/0810` (permissions, `site_domain_bindings`, `ssl_certificates`), `0833` (a failed site frees its name); code `capacity.service.ts` (scheduler), `plans.service.ts`, `hosting-pricer.ts`, `sites.service.ts`, `site-workflow.ts`, `hosting-jobs.ts`, `domains.service.ts`, `ssl.service.ts`, controllers (`hosting-plans`, `sites`, `site-domains`, `site-ssl`, `site-databases`, `admin-sites`), `mock/acme-test-server.ts`; spec: 14 operations (plans, sites, domains, ssl-certificates, databases, admin sites); error codes `quote_expired`, `no_capacity`, `unsupported_runtime`, `unsupported_capability`, `domain_in_use`, `ownership_unverified`, `restore_in_progress`, `no_backup_sink`, `site_not_active` (registry + `errors.yaml`).

## C. Implemented
- **Scheduler:** reservation = ONE conditional `UPDATE … reserved = reserved + n WHERE reserved + n <= sellable` per dimension inside the allocation transaction after the node's capacity rows are locked in a fixed order (no deadlocks); savepoint rolls back a partial update; strategies spread (default) / binpack (`HOSTING_PLACEMENT_STRATEGY`); region filter by the M04 residency service (`ResidencyService.evaluate`, hook `m06-node-selection` now `enforced`); overcommit only through a dual-approved factor (S24). Commit-time ledger trigger: `reserved == Σ allocations`.
- **Lifecycle** (`platform.operations`): quote consumed (409 `quote_expired`) → `OrderService.createFromQuote` (spend cap, quotas, dunning) → allocate → secrets in the vault by ref → `create_site(token)` with **findByToken first** → configure → activate; terminal failure → `failed` + reservation released. Runtime types = what the node probe reports.
- **Domains:** pending binding + verification record (201); unverified recheck → 422 `ownership_unverified`; verified → vhost operation (202); an unverified domain never reaches the node (API check + a permanent-failure safety net in the operation); domain unique among verified/active bindings across organizations (409 `domain_in_use`; pending bindings reserve nothing, so a domain cannot be squatted).
- **TLS:** managed issuance on the node (the control plane never speaks ACME); renewal at `notAfter − 30 days`; failure backoff 1h, 2h, 4h … ≤ 7 days, ≥ 6h after a CA rate-limit answer, 6 attempts; custom certificates: PEM + key validated structurally and as a pair, the key goes to the vault only.
- **DB bindings:** `POST` → 422 `unsupported_capability`, `GET` → `{items:[], available:false}`.

## D. Migrations and rollback
`0810`, `0833` with `.down.sql` (dev/staging); production forward-fix.

## E. Tests run (actual; Postgres :54332)
`hosting-sites.int.spec.ts` 13, `hosting-site-ops.int.spec.ts` 14, `hosting-domains-ssl.int.spec.ts` 13, `capacity.fuzz.int.spec.ts` (fuzz + AC-M06-03 + direct-SQL violation). See the M06 report for the totals and the 100,000-operation fuzz run.

## F. Security / tenancy / residency
Cross-tenant: org B gets 404 for another org's site, domains, certificates, databases, backups, abuse cases; direct SQL as org B reads 0 rows from every hosting org table and cannot insert (RLS suite in `hosting-site-ops.int.spec.ts`). Private key never found in `ssl_certificates`, operations, outbox, audit log, idempotency table or any response (scan test). Residency: placement only in regions the org policy allows (`residency_denied` 403).

## G. Human gates / live
Live issuance on a real domain/node (AC-M06-08) BLOCKED (HG-06-01 + M07 domain). ACME here is an ACME-STYLE test double (not RFC 8555). M07 verifier and M08 binding are mocks.

## H. Acceptance
AC-M06-03 PASS (100 parallel / capacity 10 → exactly 10, 0 leaked); AC-M06-05 PASS (mock: 500 injected lost-reply runs, 0 duplicates; plus the service-level reconcile flows); AC-M06-07 PASS on the test double (issue + renew at T-30d, no key material found); AC-M06-08 BLOCKED. All mock results NOT VERIFIED against a node.

## I. Handoff
S26 backups/quotas/migration build on the same scheduler (`resize`, `move`).
