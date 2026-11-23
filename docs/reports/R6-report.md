# R6 report — browser E2E remediation (specs 01–14, isolated stack, ar + en)

Date: 2026-11-24 · Branch `claude/run-it-dc3d6a` · Nothing pushed or merged (D-01). **No live AI provider, customer-data transfer or executable tool was enabled or used.** The only model in these runs is the in-memory dev reference `mock-model` (NOT VERIFIED, `AI_LOCAL_REFERENCE`, non-production).

## A. Findings and assumptions
- Specs 01–13 had never passed as a suite: they were written against the pre-redesign console ("NOT RUN" headers), depended on each other's data (`run 01-customer first`), shared one database, hard-coded ports and the default database, and used substring locators that collide with the redesigned screens. Fixing them was not only text updates.
- Assumption: where the redesigned UI deliberately removed a screen entry (the builder category is not on the rail; the organization pages live in the account menu), the spec asserts the entry where it now is, or drops the assertion when the entry no longer exists and `apps/web/lib/nav.spec.ts` already covers the flag gating. Both cases are listed in §H.
- Real product defects found by the specs and fixed in the UI (not by weakening assertions): see §C.

## B. Plan and changed files
- **Isolation:** `e2e/global-setup.ts` seeds once and builds a template database; every spec file starts from it (`e2e/tests/reset.ts`, `test.beforeAll`); the database is created and migrated before the servers start (`e2e/prepare-db.mjs`); no spec depends on another spec's rows (each creates its organization through the UI, `fixtures/templates.ts`, `fixtures/domains.ts`, `fixtures/payments.ts`); ports, origins and database come from `env.ts`.
- **Stack tooling:** `scripts/e2e-stack.sh` (start/run/restart/status/stop a persistent isolated stack: free ports, its own database), `e2e/dev-stack.ts`, `scripts/e2e-isolated.sh` (drops the template too), `e2e/playwright.config.ts` (`E2E_REUSE_SERVERS`, `PAYMENT_RETURN_URL_ALLOWLIST`, `AI_LOCAL_REFERENCE`).
- **Specs:** 01–14 rewritten to the current UI; 15–18 only had their database/origin plumbing changed (assertions untouched).
- **UI fixes (axe, state persistence, honesty of status):** `NotificationsMenu`, inline links (`console-css.ts`), `DatabasePanels`, email domain page, `AiBudgetsForm`, `BuilderRunCard`, `WorkflowCanvas`, `WorkflowEditor`, `BuilderCode`, `ProgramsPanels` + reseller pricing page, `StoragePanels` + bucket page, builder start tiles (`console-css.ts`), i18n keys `m11.wf.canvas.step` and `bld.card.rejected`.

## C. Product defects the E2E found (all fixed, each with a unit or E2E assertion)
| # | Defect | Fix |
|---|---|---|
| 1 | A confirmation notice vanished when the page re-read its data (panels remounted by ETag/version): email domain re-check, database and bucket policy, reseller price rules | resync state in place; no remount key |
| 2 | AI budgets: after "reload" the stale-version error returned | clear the error when the new version arrives |
| 3 | A denied builder change finished as "Your site was updated" (the run succeeds with `rejected: true`) | the run card says "The change was not applied"; unit test added |
| 4 | axe: run progress bar without a name (`aria-progressbar-name`) | label added |
| 5 | axe: workflow step buttons named differently from their text (`label-content-name-mismatch`) | named by their content; step number is screen-reader text |
| 6 | axe: error list inside `role="status"` (`listitem`) | list moved inside the status wrapper |
| 7 | axe: tablist that contained the collapse button (`aria-required-children`) | button moved out of the tablist |
| 8 | axe: links in text and table cells indistinguishable from text (1.29:1) | underlined |
| 9 | axe: checked builder tile text 4.43:1 and "soon" tiles faded by opacity | muted text darkened on the checked tile; dashed border replaces the opacity |
| 10 | axe: notification bell name did not contain its visible text | aria-label |

## D. Migrations and rollback
None. (Test fixtures write rows with SQL to the throw-away e2e database only.)

## E. Tests run with actual results
| Command | Result |
|---|---|
| Full E2E, project `ar` (isolated stack, 1 worker, axe in every spec) | 43 passed, 2 skipped, 1 failed (`08-managed-data-email` managed data: bucket policy notice lost on refresh, defect #1; fixed afterwards) |
| Full E2E, project `en` | **44 passed, 2 skipped, 0 failed** (exit 0) |
| Re-run after the bucket fix: `08-managed-data-email` + `05-admin-finance`, `ar` and `en` | 6 passed |
| Specs 15–18 (ar and en, inside the full runs) | passed (not edited beyond plumbing) |
| `pnpm test` (unit, `TEST_CONCURRENCY=2`) | exit 0, 52 of 52 tasks |
| `apps/web` unit tests | part of `pnpm test` (exit 0); `BuilderRunCard` 5 passed incl. the new test |
| `pnpm lint` (eslint + prettier), `pnpm typecheck` | exit 0 / exit 0 (52 of 52 tasks) |
| `pnpm spec:lint`, `spec:drift`, `scan:secrets`, `sdk:check`, `zatca:guard`, `compliance:claims-guard` | all exit 0 |
| `pnpm test:integration` (`TEST_CONCURRENCY=2`) | db 102, platform 32, worker 92 passed; api 2118 passed, 2 failed, 2 skipped. Both failures investigated: `email.int.spec` usage reconciliation was **time-zone dependent** (it counted the day with a bare date in the database session's zone; failed on this machine, UTC+3, between 00:00 and 03:00 local) and is fixed (31 of 31 pass); `agent-loop.int.spec` "a cancel request stops the loop" is a **load-sensitive timing flake** (passes alone; the machine had just rebooted with load average 70). Not re-run as a whole suite after the fix: **NOT VERIFIED as a complete run** |

Skipped on purpose (both locales), not hidden:
1. `08-compute-customer` "offer → quote → create → delete on the mock catalog": needs `M05_E2E_MOCK_CATALOG` (the S17 mock-compute catalog); an opt-in environment precondition.
2. `10-app-builder` deploy / rollback leg: needs a hosting site and a deploy target (HG-05/HG-06); skipped with that reason, not faked.

## F. Security, isolation, billing, residency
- Every spec starts from a clean template database; no cross-spec data. Tenant isolation specs (14 test 4, 15–18) still pass.
- No weakened assertion: collisions were fixed with exact/role/scoped locators; the stale-version, residency, MFA step-up and data-terms gates were exercised, not bypassed. Test tooling that touches gates: staff sessions are marked MFA-fresh in SQL (the enrolment itself is covered by 02); the dev-reference `mock-model` row carries a data-terms attestation marked `LOCAL-REFERENCE-NOT-VERIFIED` and a ROPA processor entry, in the throw-away database only; the `security` platform role is granted to the e2e staff user in the access-review test (that screen needs `admin:security:manage`).
- `AI_LOCAL_REFERENCE=true` is set only in the e2e API environment (dev reference model and in-memory site publisher, never production).

## G. Human gates and live checks still needed
Unchanged by R6: D1, D2, D4, D5, D6, D12 (and D3/D9 execution) — see §I. HG-05/HG-06 (deploy target) for the skipped deploy leg.

## H. Acceptance checklist
| Item | Status |
|---|---|
| Specs 01–14 updated to the current UI | PASS (ar and en) |
| Locator collisions resolved without changing UI behavior | PASS |
| Database isolation between spec files | PASS |
| Specs 15–18 preserved | PASS (ar and en) |
| Isolated environment used | PASS |
| axe in every spec (WCAG 2 A/AA, 2.1 A/AA tags) | PASS, with the exclusions below |
| Unit, lint, typecheck, compliance, spec checks | PASS |
| Integration | PASS except as noted in §E (one fixed test re-run alone; one load flake re-run alone); no full re-run |
| Assertions weakened or tests skipped to get green | NO; two documented precondition skips (§E) |
| Dropped assertions (listed, with reason) | builder-category nav entries (not on the rail; `nav.spec.ts` covers the flags); 10b "viewer cannot open signing" (the step signed in as a user the dev IdP does not have and asserted nothing; **NOT covered**, to be rebuilt with a real viewer membership) |
| axe settings | legacy mode and one exclusion for the sandboxed, script-less email preview iframe (default mode cannot finish a run against it) |
| Behavior not covered by E2E | viewer signing forbidden state (above); mobile real builds (no runner: spec asserts the screens say so) |

## I. Readiness of S-AG4, S-AG5, S-AG6 (assessment, nothing enabled)
**S-AG4 (real provider adapters and verification): NOT READY — BLOCKED on owner/legal/contract items, not on engineering.** Done: Claude adapter at contract 1.1 behind a closed live gate (`AI_LIVE_PROVIDERS`), capability evidence table (migration 1870), evidence-gated tool declarations, bounded probe prepared but not executed, D7/D8/D10/D11 approved and implemented. Exact blockers:
1. **D1** residency option and whether Claude may receive `customer-content`/`personal` data (legal) — not needed for the probe (public content only), needed before any customer use.
2. **D2 / HG-09-01** Claude API agreement and data terms; the human attestation reference and flags.
3. **D4** a dedicated non-production key with a vendor-side spend cap (who creates, stores via `save_claude_key`, rotates).
4. **D5** region statement and ROPA processor entry for `claude`.
5. **D6** customer rate card for `claude-opus-5-5` (the provider cannot be enabled without it).
6. **D3** opening `AI_LIVE_PROVIDERS=claude` in a named non-production environment; two-person enable; connection test `ok`.
7. **D9** execution approval of the probe (worst case about 11.7k tokens) — the wrapper that runs it through the gateway is not built until approved.
8. OpenAI/Google adapters: either built with their own D1/D2/D4/D5/D6 cycles or a recorded `DEFERRED` change-log entry (D11 sequencing: Claude first).
Next implementation steps once D2/D4/D5/D6 exist: build the probe wrapper and internal probe organization (D9), run it once, record `VERIFIED`/`NOT VERIFIED` evidence rows, write AC-AG-09 with links.

**S-AG5 (golden tasks, benchmarks, rollout gates): NOT READY — depends on S-AG4 closing for Claude.** Can start now without owner input: the synthetic/owner-authored golden task suite with expected outcomes and an offline replay mode (recorded fixtures) for CI; the static part of the S-K8 quality evidence. Needs the owner: accepted thresholds (valid-patch rate, mode-rule violations, tool-call/token cost, latency, human acceptance), named human reviewers, an approved benchmark spend budget and vendor cap, the agent security review (injection, tenant isolation, secrets, tool abuse) with a named reviewer. D1 only if golden tasks use customer content (they should not).

**S-AG6 (execution tools): BLOCKED (D-21).** Needs: D-21 decided (gVisor/Firecracker/Kata on dedicated nodes) after the HG-10-02 sandbox isolation security review; the escape suite passing on a real isolating runtime (only the mock runtime has run: NOT VERIFIED); a new ADR for the Execution Gateway; implementation of `ai.agent.exec_tools` behind it (today only a name) with approval gates, audit, metering, kill switch, runbook and tests; S-AG5 thresholds met on a verified provider; legal review of running customer code; D-42 and owner sign-off before production. Nothing here may start while D-21 is open.

The E2E suite is no longer a blocker for any of the three: the specs that cover the AI screens (10, 10b, 14–18) pass in both languages on the isolated stack with the dev reference only.
