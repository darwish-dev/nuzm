# M09 — AI core & website builder: milestone report (PARTIAL, NOT SIGNED)

Status: **NOT DONE.** Backend S37–S41 built against a scripted mock model and a fake hosting publisher; nothing is signed; no HG is marked granted. Written at a usage-limit cut-off: sections are brief; per-sprint detail is in `S37-report.md`..`S41-report.md`, the contract for M10/M11 in `M09-interface-contract.md`.

## A. Findings and assumptions
M06 `HostingAdapter` has no deploy/upload method → `SitePublisherPort` (fake; production = 422 `unsupported_capability`). `packages/contracts` has no package → site model lives in `packages/domain`. `*_encrypted` columns are `*_enc` (M04 naming check). Audit names `deploy.deployment.*`. Credits are wallet money (ADR-061). Preview origin: ADR-060.
## B–D. Changed files / features / migrations
Migrations `1200`,`1201` (ai), `1210` (builder), `1220` (deploy), each with a dev-only `.down.sql`. Modules `apps/api/src/modules/{ai,builder,deploy}`; packages `@nuzm/adapter-model`, `packages/domain/src/{ai,builder}`; OpenAPI 44 routes; UI-M09-01..09 (customer, written, never rendered); runbooks, ADR-060/061, demo script.
## E. Tests actually run (worktree on main `4f5f754` fast-forwarded; Postgres :54351; no browser)
| Command / suite | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck`, `pnpm build` (second pass, after fixing two merge-exposed errors: `icon` missing in two `services.ts` entries, unused import in the deploy spec) | exit 0 each |
| `pnpm compliance:claims-guard`, `spec:lint`, `spec:drift` (328 routes), `sdk:check`, `scan:secrets` | exit 0 |
| `db:migrate` on a fresh DB (incl. main's 1701), `db:test-rls`, classification (2191 columns / 177 tables), ROPA, residency hooks | OK |
| Unit (`turbo run test --filter='!@nuzm/e2e'`): API 702, domain 518+ (renderer 199, templates 61, mock agents 47, ops 7 incl. 1000 fuzz sequences, evaluation 2), adapter-model 5, i18n 9, web 313 (builder 50, ai 32), admin (ai 37) | passed; the API `health.spec` hook timed out once under load and passed alone |
| API integration, M09 suites: gateway 27, runs 21, injection 64, builder 28, deploy 12 | **152/152 passed** |
| API integration, tenancy incl. cross-tenant with M09 fixtures (every new org-scoped route 404 for another org; positive control) | **409/409 passed** (the positive control timed out at `/v1/billing/invoices/{id}/pdf` only while the machine was under load; it passes alone and in the final run) |
| **NOT RUN:** Playwright (`10-builder-customer`, `10-ai-usage-budgets`, `10-ai-admin`), axe, screenshots, load tests (50 runs, 500 SSE, preview p95), any live provider/hosting check | NOT RUN / BLOCKED |

UI: customer builder screens UI-M09-01..09 and usage/budgets UI-M09-10..11, admin UI-M09-12..14 are all written with Arabic RTL + English; none was ever rendered in a browser (NOT VERIFIED). Known partial: CMS items cannot be edited after creation (API only creates), inspector edits text/props only, the deployment approval 403 body carries no `costDisclosure` (the dialog falls back to a localized line).

## F. Security
RLS + cross-tenant fixtures for every new route; preview isolation tests; 60-case injection suite and canary leak tests (mock obedient model: proves defences, not any real model). Independent preview review: BLOCKED.
## G–H. Acceptance (honest)
AC-M09-01 PASS (1000 calls property + 20 loops, mock) · 02 PARTIAL (residency matrix tests, not 200-case) · 03 PASS (60 cases, mock) · 04 NOT VERIFIED/BLOCKED (tests pass; reviewer + network policy pending) · 05 PASS (canaries) · 06 PASS (own validator, not W3C) · 07 PASS (1000 fuzz) · 08 PASS (fake node) · 09 PASS · 10 PASS · 11 NOT VERIFIED (UI written, e2e NOT RUN) · 12 BLOCKED (HG-09-01, D-18) · 13 BLOCKED · 14 BLOCKED (HG-05-01/02, HG-06-01) · 15 BLOCKED (HG-07-01) · 16 BLOCKED (HG-09-01).
## I. Handoff / open
D-18, HG-09-01, D-23/25, moderation policy, imagery licensing, M06 node-agent artifact command, PA-16 credit purchase endpoint, DSR export/erase for sessions/messages/submissions, consent notice, evaluation thresholds approval. Merge notes: shared files edited only in `>>> M09` blocks; regenerate `packages/sdk/src/schema.ts` and `pnpm-lock.yaml`; migrations 1200–1220.
