# Phase 3 security qualification: plan and state (P3-S08)

Updated 2026-11-24 on `claude/p3-s08-qualification-2cddc5`. Owner of this document: P3-S08. **Every result in this document is OFFLINE or SIMULATED unless its row says LIVE-VERIFIED with an evidence file; today no row is LIVE-VERIFIED.** Phase 2 state and the reviewer brief for the isolating runtime: `PHASE2-SECURITY-QUALIFICATION.md`. Defects: `DEFECT-REGISTER.md` section 4.

## 1. Gates that run on every `pnpm verify` (offline, no services)
| Gate | Where | What it stops |
|---|---|---|
| Evidence verifier + repository evidence check | `apps/api/src/qa/evidence/*.spec.ts` (92 tests) | a committed evidence record that mixes SIMULATED with LIVE-VERIFIED, has a wrong hash, no approvals, a stand-in identity, a secret, or an e-mail address |
| Route inventory (public routes pinned, admin = platform permission, POST idempotency) | `qa-route-inventory.spec.ts` (was `.int.spec.ts`; it never needed a database) | a new public route or a new organization POST without `@Idempotent` |
| O-9 static gate | `qa-o9-static-gate.spec.ts` + `O9-ROUTE-CLASSIFICATION.json` | a new GET route in the AI, builder, deployment, execution, benchmark, sandbox, mobile, website or preview areas that nobody classified; a `content` route that lost its guard; disagreement with the dynamic audit table |
| Validation scripts lint | `validate-scripts.spec.ts` | a mutating command or a printed secret in `docs/phase3/validate/` |
| Harness | `qa/harness/harness.spec.ts` | live mode that does not stop at the first missing approval, falls back to a simulated result, or keeps a rejected record |
| P3-S02 egress proxy address policy | `qa-p3-egress-proxy.spec.ts` (skipped until `@nuzm/runtime-agent` is in the tree) | DEFECT-18 |
| Test-environment allocator (collision, foreign lease, protected ports, expired lease, stray URLs, release safety) | `qa-p3-testenv-allocator.spec.ts` (runs since the merge of `integration/ai-engine` `dd3ad2bb`: 14 passed) | a lease leaking into another session; DEFECT-19 |
When a Phase 3 session merges a new route, these gates fail until the route is classified: **the failure is the review request**. Sessions cannot edit the pinned lists (they are P3-S08 files): send the route and the reason through the Master, or the Master asks P3-S08 after the merge.

## 2. Gates that need services (`pnpm test:integration`, own PostgreSQL)
`qa-o9-content-access.int.spec.ts` (dynamic O-9 audit: 11 passed on this branch, own PostgreSQL :54358, 2026-11-24), `qa-authz-matrix`, `qa-credential-custody`, `qa-ai-integrity`, `qa-run-concurrency`, the exec, deploy, mobile-signing and migration round-trip suites from Phase 2 (20 files, 510 tests at `c0043cbd`; re-run at the Phase 3 head is acceptance Q3/Q5).

## 3. Negatives per Phase 3 component: plan and state
| Component (session) | State of the code (read 2026-11-24) | Negatives planned (run when it is in the tree) | State |
|---|---|---|---|
| Live executor, credentials, key rotation, REST adapters (P3-S01) | service-level code on `claude/p3-s01-providers-b70a0d`; credential routes are a CONTRACT request, not yet routes | credential custody scan over logs/DB/artifacts after a (twin) run; non-admin cannot rotate/revoke; evidence envelope verified by `native-provider.ts` (done, 12 tests); leak scan at Q01 | envelope verifier DONE; the rest waits for the merge |
| Node agent, egress proxy, workspace FS (P3-S02) | `packages/runtime-agent` on `claude/p3-s02-runtime-999326` | address-policy differential (**DEFECT-18 fixed on the S02 branch (074ef411)**), tunnel-slot starvation (O-17), path-confinement corpus against `fs-safe.ts`, mutual-TLS refusal, escape suite re-run as an independent brief | DEFECT-18 proven; rest waits for the merge |
| Repair engine, guards (P3-S03) | domain code on `claude/p3-s03-agent-loop-1c2f7a` (uncommitted parts) | repair cannot touch forbidden paths, cannot widen scope, injection through build logs and fixer output changes no permission or limit | waits |
| Website QA gates, static build, preview tamper corpus (P3-S04) | `claude/p3-s04-website-1c5609` | preview origin isolation and tag guessing (ADR-060), CSP strictness on generated sites, QA evidence mapped into the `website` track | waits |
| Full-stack templates, generated-app DB (P3-S05) | nothing committed yet | cross-user isolation in the generated app, DB isolation proof, no platform secret in the app env | waits |
| Mobile build engine (P3-S06) | `claude/p3-s06-mobile-e5a3e5`: guard, parsers, scripts | `infra/mobile/android/*.sh` review (no host secret read, no production key), build-log redaction corpus, signing routes viewer-forbidden (exists) | waits; script label wording raised (see the Flutter plan) |
| Hosting join, deploy transport (P3-S07) | join merge only | publish/rollback approvals on the merged hosting routes (O-1/O-2 matrix), transport conformance T-01..T-19 on the real transport, O-9 for new deployment routes | waits |
Each negative is written as the secure expectation; while a defect is open it is an `it.fails` (the Phase 2 convention) so the first run after the fix goes red and is flipped.

## 4. Live-run checks (all BLOCKED today: no approval is recorded)
| Check | Needs | Evidence track | State |
|---|---|---|---|
| Credential leak scan of logs, database, artifacts, responses, audit rows, evidence files after a real run | D2, D5, D6, D4, D3, D9 | `security` (`kind: credential-leak-scan`) | BLOCKED (D2..D9): the harness scenario Q01 stops at the missing approvals |
| Wallet, ledger and usage reconcile to the cent after every real paid run | the same | `security` (`kind: ledger-wallet-reconciliation`) | BLOCKED |
| Prompt injection through real model outputs and project files | the same + runtime | `security` | BLOCKED |
| Independent re-run of the escape suite (reviewer brief, `PHASE2-SECURITY-QUALIFICATION.md` section 5) | D-21, HG-10-02, ADR-069, a Linux node | `security` (`runtime-escape-independent`) | BLOCKED |
| SSRF/egress on a real network (metadata endpoint, DNS rebinding) | the node | `security` | BLOCKED |
| Audit chain verification after real spend | the same | `security` | BLOCKED |
The exact blocker per row is generated into `docs/phase3/EVIDENCE/ACCEPTANCE-MATRIX.md`.

## 5. E2E conventions for `p3-*.spec.ts` (lessons of the Phase 2 E2E run: 102 passed, 8 failed in four new specs)
- **Strict-mode locators:** a locator that can match several elements (`section:has(...)` + `getByRole('button')` matched 3) must be narrowed by name or `data-testid`; never rely on first-match.
- **Assert on visible text, not raw HTML:** leak and error-text patterns run on `locator('body').innerText()` and on markup with `<script>`/`<style>` bodies removed (inline bundles contain words like `SELECT ` and `at Object.`); secrets (markers, project names, keys) are still checked on the full HTML. `qa-negatives.spec.ts` was changed this way (commit `91570be9`, **NOT RUN**: the E2E needs a heavy slot).
- **Staff users:** fixtures for admin/staff users on the dev IdP are created in `global-setup` or the spec's own `reset`, never assumed to exist; a missing staff login must fail with the missing fixture named, not as a click timeout (the 120 s `locator.click` timeouts of the run).
- **Route announcer:** Next's route announcer exposes a `role=alert`/live region; a test that expects "no alert" or counts `getByRole('alert')` must scope to the page's own region.
- **Unregistered IdP users:** a user that is not registered on the dev IdP fails the login with a generic page; the spec's reset must register every user it logs in as and name the missing one.
- **Duplicate headings:** assert a single `h1`/title per screen (the `bt.lc.title` duplicate found by `qa-negatives`).
- Every new screen: ar and en, axe, a screenshot outside git, loading/empty/error/forbidden states (CLAUDE.md section 4).

## 6. Non-vacuity method for a guard of a defect whose fix is on an unmerged branch (used for DEFECT-21 and 22)
`git archive <fix commit> packages/domain` into three scratch directories (outside the repository, under `/private/tmp`), symlink the producer's `packages/domain/node_modules`, copy `tsconfig.base.json`. Variant C = the fix tree unchanged (control: must pass); variant A/B = the fix tree with ONLY the defective lines put back (a scripted text edit, checked with `diff` against the fix). Run the guard specs with the scratch tree's own `vitest`. A guard counts as non-vacuous only when its control passes and each re-introduction fails. Nothing in the producer's worktree is edited. Result 2026-11-25: control 18/18 pass; DEFECT-21 re-introduced: 8 tests fail; DEFECT-22 re-introduced: 9 tests fail.
