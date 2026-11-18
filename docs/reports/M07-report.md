# M07 report — Domains & DNS reseller (S28–S31)

**Status: NOT DONE (not signed).** Implemented and tested against **local mock registrars**; every row that needs vendor evidence is BLOCKED or NOT VERIFIED. Reports: [S28](S28-report.md) · [S29](S29-report.md) · [S30](S30-report.md) · [S31](S31-report.md) · [M05/M06 assumptions](M07-m05-interface-assumptions.md) · gate review draft [M07-gate-review.md](M07-gate-review.md).

## A. Repository findings and assumptions
* **Owner-directed exception (recorded as required):** the milestone prompt says to stop when M05 is missing. The owner directed M06, M07 and M08 to start now. M05 is being written in another session (`claude/m05-provider-core-05b775`, S16 committed); M07 codes against ports it defines, mirrors M05's S16 contract **read-only**, and lists every assumption in [M07-m05-interface-assumptions.md](M07-m05-interface-assumptions.md). Integration with the real M05 is a mechanical follow-up, **not yet done**.
* Base = main's M04 + M03 S12d (`integration/main-m04-s12d` lineage); M03/M04 gate reviews were unsigned when this started.
* Conflicts between sources (CLAUDE.md §2): (1) migration range — manifest `0900–0999` followed over the task's "800–899"; (2) `platform.resources_index` (prompt) vs docs/05 (no inventory in `platform`) — events only; (3) audit action `registrar.verified` has two segments, the audit table needs three — used `registrar.account.verified`; (4) payment model — wallet reservation instead of M05's hold table; (5) statements → RC-04 bill lines instead of cost records. None needs an ADR beyond the owner approving these notes; no spec/ADR was changed beyond the additive M07 blocks.
* **Spec additions needing owner approval (not granted):** `M07-ADD-1` `GET /v1/admin/domains`, `GET /v1/admin/domains/{id}`; `M07-ADD-2` `POST/GET /v1/domains/{id}/hosting-links`.

## B. Plan and changed files
See the sprint reports. New packages: `packages/adapters/{registrar-contracts,registrar-conformance,openprovider,resellerclub}`; `packages/domain/src/dns-validate`. New module `apps/api/src/modules/domains` (+ dev hook `src/dev/domains-dev.ts`). Migrations `0900`, `0910`, `0920` (+ down scripts). Spec: OpenAPI (23 operations), errors, `spec/providers/tld-policy.yaml`, ownership/classification, purposes, residency hooks. UI: 8 customer + 4 admin screens, 172 i18n keys (ar/en).

## C. Features, API and UI
FR-DOM-01..08 implemented as described in the sprint reports. All customer endpoints are feature-flagged (`domains.enabled`, default **off**; `DOMAINS_ENABLED=true` only outside production). Screens UI-M07-01..12 built (ar RTL + en; loading/empty/error/forbidden via the shared `view()` helpers).

## D. Migrations and rollback
`0900`/`0910`/`0920`: new tables only; dev `.down.sql` drops in reverse order; production rollback = forward fix (docs/05 §2). Registry seeds: `openprovider`, `resellerclub` rows, **disabled**, no accounts.

## E. Tests run (actual results)
See the per-sprint tables. Summary of what exists: conformance kit 18 cases × 2 adapters (mock); 120 DNS-validation tests; policy, pricing, contacts, guard unit tests; integration suites `domains-search` (12), `domains-quote` (8), `domains-orders` (17), `domains-webhooks` (6), `domains-dns` (9), `domains-s31` (11), `domains-dsr` (2). Full-repo gates: see §E.2.

### E.2 Repository gates run on this branch
Run on 2026-11-18 against a project-local Postgres on :54333 (Redis is not installed; nothing here needs it).

| Gate | Result |
|---|---|
| `pnpm lint` (`eslint .` + `prettier --check .`) | first full run found 55 unused imports in the new UI pages; fixed; the complete verify then passed lint and typecheck. After later edits `eslint` was re-run on every touched tree (api, web, admin, adapters, domain, db, e2e) and `prettier --check` on `apps packages e2e spec docs`: clean. `eslint .` on the whole repository was **not** re-run after the last edits |
| `pnpm typecheck` + `pnpm test` (turbo, **excluding `@nuzm/e2e`**) | 41/41 tasks pass. `pnpm test` as defined also starts the Playwright package, which refuses to start here because ports 3000/3001/4000/4010 belong to other sessions: so `pnpm verify` **as a single command did not complete** on this machine; every step after `test` was run individually |
| `pnpm build`, `spec:lint`, `spec:drift`, `sdk:check`, `scan:secrets`, `zatca:guard`, `compliance:claims-guard` | all exit 0 (169 routes declared and implemented; secret scan 0 hits after two mock literals were rewritten) |
| `pnpm db:test-rls`, `compliance:classification-coverage` (1174 columns), `compliance:ropa-coverage`, `compliance:residency-hooks` | all exit 0 |
| `pnpm test:integration` (full suite, 40 files) | 843 passed, 4 failed, 4 skipped; all 4 failures were in `domains-orders.int.spec` (the per-account rate limiter tripped by 50 fast quotes). Fixed by making the limiter configurable (`DOMAINS_ACCOUNT_BURST`, `DOMAINS_ACCOUNT_RATE_PER_SECOND`; the tests raise it); the 7 domains files were then re-run: **65/65 pass**. The full suite was **not** re-run after that last fix |
| Pre-existing tests I had to change (they assumed M07 did not exist) | `commerce.int.spec` (kind `domain` now has a pricer), `dsr.int.spec` (handler list gains `domain-contacts`), `tenancy/cross-tenant.int.spec` (fixtures for the new `{id}` routes), `packages/db residency-hooks.spec` (one hook is now enforced) |
| `pnpm test:e2e` / `pnpm verify:full` | **NOT RUN** (forbidden here: ports and DB of other sessions) |


## F. Security, tenant isolation, billing, residency
* Tenant isolation: RLS on all tenant tables (`pnpm db:test-rls` passes), cross-tenant matrix tests for domains, orders, transfers, eligibility, zones, records, hosting links; a second organization ordering a taken name gets `409 domain_unavailable` without any owner information.
* Money: integer minor units; exact FX/markup arithmetic rounded up; ledger keyed by order id (replays post nothing); funds reserved before the registrar is called and released by a reversing entry on failure.
* Secrets/PII: vault references only; auth codes write-only; contacts sealed; scans for the auth code and the contact e-mail over audit, operations, outbox, notifications, transfers, orders and webhook tables returned zero hits.
* Residency: enforced hook `m07-registrant-contacts` (checked at quote, order and immediately before PII leaves; stored with the order).

## G. Human gates and live checks still needed
HG-07-01 (reseller accounts, API access/IP allow-list, sandbox credentials) · HG-07-02 / D-19 (`.sa` route and TLD portfolio) · HG-03-02 (PSP production) · HG-04-01 (counsel: cross-border registrant data, registry retention) · D-31 (variance threshold) · D-23 (margin policy; default markup 0) · D-12 (vault) · owner approval of M07-ADD-1/2. The agent did **not** mark any gate granted.

## H. Acceptance checklist
| ID | Status | Evidence / reason |
|---|---|---|
| AC-M07-01 | **PASS on mock evidence; vendor NOT VERIFIED** | kit 18/18 per adapter (R15/R16 skipped for ResellerClub because the vendor documents no webhooks/atomic DNS) |
| AC-M07-02 | PASS (mock) | `domains-webhooks.int.spec` ×100: 1 registration, 1 meter event, 1 ledger transaction |
| AC-M07-03 | PASS (mock) | 50 seeded fault-injection runs, all terminal, 0 duplicates; **the 15-minute bound is not timed** (runs are driven synchronously) |
| AC-M07-04 | PASS | 100 attempts incl. every Saudi suffix ⇒ 422, 0 orders/authorizations/ledger rows |
| AC-M07-05 | PASS | 60 valid / 64 invalid fixtures |
| AC-M07-06 | PASS (mock) | 20 injected positions |
| AC-M07-07 | PASS for the endpoints tested | matrix in `domains-orders`, `domains-dns`, `domains-s31`; the admin endpoints are staff-only and tested for role refusal; no cross-org read found. Not every §6 endpoint has its own cross-org case (renewals/transfers use the shared helper) |
| AC-M07-08 | PASS (scans written) | auth code, contact e-mail and last name: 0 hits in audit/operations/outbox/notifications/transfers/orders/webhooks. A repository-wide log scanner for adapters' own logs was not written |
| AC-M07-09 | **NOT RUN** | no load test; proposal values only |
| AC-M07-10 | PASS (mock) | RC-04 reports exactly the injected variances |
| AC-M07-11 | **NOT VERIFIED** | e2e spec written, **NOT RUN** (ports owned by other sessions); axe not run |
| AC-M07-12 | **BLOCKED (HG-07-01)** | no credentials |
| AC-M07-13 | **BLOCKED (HG-07-02, D-19)** | Saudi TLDs blocked by policy; no route |
| AC-M07-14 | **BLOCKED (HG-07-01 + M06)** | hosting site is a fake |
| AC-M07-15 | **BLOCKED (HG-07-01, D-31)** | mock statement only |

## I. Next-milestone handoff and open decisions
* **Integrate with the real M05** (assumptions file): re-export contracts, move the kit, write `cloud.provider_capabilities`, unify hold semantics, register M05's bill source, regenerate the SDK.
* M06: implement `HostingSiteReadPort`; call `DnsLinkageService`. M08: use the `email-verification` writer. M11: reuse the screens.
* Open: authoritative DNS hosting decision, `.sa` route (HG-07-02), optional registrars, D-23/D-31, vault `put`, a scheduler host for `DomainJobs` (M12), per-order PSP payment, entitlement-backed `records per zone`, a repository-wide log scanner for AC-M07-08.
