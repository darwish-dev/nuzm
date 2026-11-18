# M09 — AI core & website builder: milestone report (PARTIAL, NOT SIGNED)

Status: **NOT DONE.** Backend S37–S41 built against a scripted mock model and a fake hosting publisher; nothing is signed; no HG is marked granted. Written at a usage-limit cut-off: sections are brief; per-sprint detail is in `S37-report.md`..`S41-report.md`, the contract for M10/M11 in `M09-interface-contract.md`.

## A. Findings and assumptions
M06 `HostingAdapter` has no deploy/upload method → `SitePublisherPort` (fake; production = 422 `unsupported_capability`). `packages/contracts` has no package → site model lives in `packages/domain`. `*_encrypted` columns are `*_enc` (M04 naming check). Audit names `deploy.deployment.*`. Credits are wallet money (ADR-061). Preview origin: ADR-060.
## B–D. Changed files / features / migrations
Migrations `1200`,`1201` (ai), `1210` (builder), `1220` (deploy), each with a dev-only `.down.sql`. Modules `apps/api/src/modules/{ai,builder,deploy}`; packages `@nuzm/adapter-model`, `packages/domain/src/{ai,builder}`; OpenAPI 44 routes; UI-M09-01..09 (customer, written, never rendered); runbooks, ADR-060/061, demo script.
## E. Tests actually run (this worktree, Postgres :54351)
domain 518+ unit; adapter-model 5; API unit 702; API integration: gateway 27, runs 21, injection 64, builder 28, deploy 12 — all passed; `spec:lint`, `spec:drift` (328 routes), `sdk:check`, `scan:secrets`, `db:test-rls`, classification/ROPA/residency-hooks/claims-guard OK. Cross-tenant suite: 366/367 passed; the positive control passes alone but times out at `/v1/billing/invoices/{id}/pdf` under CPU load (environmental, not M09 routes). **NOT RUN:** Playwright (specs written: `10-builder-customer.spec.ts`; admin/usage specs by the second UI agent, if delivered), full `pnpm verify`/`pnpm build` after the UI work, load tests.
## F. Security
RLS + cross-tenant fixtures for every new route; preview isolation tests; 60-case injection suite and canary leak tests (mock obedient model: proves defences, not any real model). Independent preview review: BLOCKED.
## G–H. Acceptance (honest)
AC-M09-01 PASS (1000 calls property + 20 loops, mock) · 02 PARTIAL (residency matrix tests, not 200-case) · 03 PASS (60 cases, mock) · 04 NOT VERIFIED/BLOCKED (tests pass; reviewer + network policy pending) · 05 PASS (canaries) · 06 PASS (own validator, not W3C) · 07 PASS (1000 fuzz) · 08 PASS (fake node) · 09 PASS · 10 PASS · 11 NOT VERIFIED (UI written, e2e NOT RUN) · 12 BLOCKED (HG-09-01, D-18) · 13 BLOCKED · 14 BLOCKED (HG-05-01/02, HG-06-01) · 15 BLOCKED (HG-07-01) · 16 BLOCKED (HG-09-01).
## I. Handoff / open
D-18, HG-09-01, D-23/25, moderation policy, imagery licensing, M06 node-agent artifact command, PA-16 credit purchase endpoint, DSR export/erase for sessions/messages/submissions, consent notice, evaluation thresholds approval. Merge notes: shared files edited only in `>>> M09` blocks; regenerate `packages/sdk/src/schema.ts` and `pnpm-lock.yaml`; migrations 1200–1220.
