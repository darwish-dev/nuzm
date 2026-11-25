# S-AG5 — benchmarks, evaluation and rollout gates (OFFLINE)

Status: **the offline machinery is complete and tested; nothing has been measured on a model and no live benchmark has been run.** Code: `packages/domain/src/ai/benchmarks/` (specs beside it), `apps/api/src/modules/benchmarks/` (admin API, not yet registered), `apps/admin` (dashboard), migrations 1920-1921. Nothing in the domain code calls a model, a network or a clock. Session 03 (parallel AI-engine phase) built everything after the first 24 tasks; see `docs/parallel/sessions/REPORT-03.md` for evidence.

## 1. Labels (never blurred)
Every recording carries `origin`: `REFERENCE` (this repository's oracle, not a model), `MOCK` (a scripted test double, not a model), `RECORDED` (captured by the gated live runner from a verified provider, with capture provenance: run id, approval reference, provider evidence reference). A report states its evidence label: `OFFLINE_REFERENCE_ORACLE`, `OFFLINE_MOCK_REPLAY`, `OFFLINE_REPLAY_OF_RECORDED_RUN` or `MIXED_ORIGINS_NOT_COMPARABLE`, with a disclaimer. No label, text or field says "real-model performance". A `RECORDED` recording without provenance, or recorded against another dataset version, is rejected (listed, never scored).

## 2. The golden dataset (version 2.1.0, 83 tasks, 24 in Arabic)
Synthetic or owner-authored only, data class `public`, no customer data, no template content. 23 categories, each with at least 3 tasks; each category maps to one of the four **kinds** the original thresholds T05-T08 are scoped to:

| kind | categories (tasks) |
|---|---|
| website | landing page (3) · business website (6) · responsive design (3) · Arabic RTL (3) · accessibility (3) |
| webapp | e-commerce (3) · web application (6) · mobile application (3) · Flutter application (3) · full-stack software (3) · ERP (3) · CRM (3) · SaaS (3) · backend APIs (3) · database architecture (3) · authentication and authorization (3) · UI implementation (3) · build and deployment planning (4) |
| code-edit | code editing (5) · multi-file refactoring (3) · bug fixing (4) · security remediation (4) |
| tool-calling | tool calling (6) |

Each task: prompt, fixture project, structural checks (file exists/absent, contains, matches, JSON field, valid JSON, max files changed), tool expectations, budget, a reference solution, `revision`. Three tasks per category means one task moves a category's pass rate by a third: category figures are indicators, the gate also needs the per-kind and overall bars.
**Proofs (run in the spec for every task):** *satisfiable*: the reference solution passes with quality 100 and is clean on every applicable dimension; *non-vacuous*: the untouched fixture and every mutant of the reference (empty patch, dropping each file operation, blanking each file, moving each file) fail. `validateDataset` also refuses duplicate ids, unknown or mismatched categories, paths that are sensitive or outside the project, secret-like text, checks on paths the solution cannot produce, non-compiling patterns and unknown read tools; `GoldenTaskRegistry` throws on an ill-formed dataset (fail closed).

## 3. Dataset versioning
`buildManifest` lists every task with a content hash and revision plus a manifest hash; `dataset-lock.ts` is the published manifest. The spec fails if any task changed without a higher `revision`, and fails on any difference from the lock without a new `DATASET_VERSION` and a regenerated lock. `diffManifests`/`classifyChange`/`nextVersion` implement the semantic rule (added = minor; removed or changed = major). Reports, recordings, regression baselines and qualification records name their dataset version; versions are never mixed.

## 4. Replay and scoring (deterministic, offline)
Replay validates each recorded tool call with the gateway's own validator against the declared read-only tools and applies the patch to a copy of the fixture only without a mode violation. Per task: `passed`, `quality` 0-100 (checks 60, tools 15, budget 15, discipline 10; 0 on a violation) and four **dimensions**, all pure functions of the changed files:
- **functional correctness**: share of the task checks satisfied;
- **code quality** (10 rules Q01-Q10): `any`, debug leftovers, TODOs, ignored type errors, empty catch, `var`, very long lines, missing final newline, Dart `print`;
- **security** (14 rules S01-S14): secret-like text, `eval`, DOM injection, SQL by concatenation, weak hashes, disabled TLS, hard-coded credentials, insecure randomness for tokens, plain HTTP, CORS wildcard, shell injection, `target=_blank` without `noopener`, weak JWT settings, non-constant-time secret comparison;
- **UI quality** (13 rules U01-U13): alt text, document language and direction, physical CSS properties in Arabic tasks, empty/unlabelled controls, focus outline removal, clickable non-interactive elements, WCAG contrast < 4.5, viewport, fixed wide widths, tiny fonts, positive tabindex.
A dimension that does not apply to the changed files is `null` (never a free 100); only files the proposal changed are judged. Rules and weights are PROPOSED.
**Efficiency:** tokens (50 %: full at <= 25 % of the budget), turns (25 %), latency (25 %: full at <= 30 s, zero at 180 s); cost in credits (integer, rounded up) and credits per passed task.

## 5. Reports, comparison, regressions
Reports: overall, per kind, per category, dimensions, findings per rule, cost, evidence label, coverage (`missingRecordings`, `rejectedRecordings`); renderers: markdown, canonical JSON (sorted keys, fingerprint), CSV. `compareModels` compares same-dataset reports only: deterministic ranking (violations, pass rate, quality, security floor, cost, label), per-pair wins/ties and an exact sign test, per-category leaders, and `notModelEvidence` when any entry is not a recorded run. `detectRegressions` (blocking vs warning) covers rates, quality, violations, tokens, security mean and floor, per-category pass rate (wider tolerance), vanished coverage, a baseline of another dataset version (blocking); latency and efficiency are warnings. `taskRegressions` names tasks that passed before and fail now.

## 6. PROPOSED thresholds, version `2-proposed` (the owner accepts, changes or rejects; nothing here is a decision)
T01-T11 are exactly the original eleven (a spec pins them). Additions by Session 03:

| ID | Scope | Metric | Bar | Why |
|---|---|---|---|---|
| T12 | all | mean security | >= 95 | static security findings in changed code should be rare |
| T13 | all | lowest security score | >= 60 | one badly insecure proposal must stay visible |
| T14 | all | mean code quality | >= 90 | no `any`, leftovers, TODOs, empty catches |
| T15 | all | mean UI quality | >= 90 | alt, labels, direction, contrast, viewport, focus |
| T16 | all | mean functional | >= 90 | share of checks satisfied |
| T17 | all | mean efficiency | >= 50 | tokens, turns, latency vs budget |
| T18 | security-remediation | pass rate | >= 0.90 | a wrong fix is worse than none |
| T19 | Arabic RTL | pass rate | >= 0.85 | Arabic is the default locale (D-32) |
| T20 | accessibility | pass rate | >= 0.85 | WCAG 2.1 AA is a product target |
Also PROPOSED: every measured category >= 0.70 pass rate (`CATEGORY_PASS_FLOOR`); human acceptance >= 0.70 (review protocol below). **Regression rule** unchanged for the original metrics (fall > 0.02, any violation increase, tokens +10 % block rollout).

## 7. The rollout gate (`evaluateRolloutGate`; the older `rolloutDecision` stays for offline use)
Fails closed: every check must hold, an absent input fails. Checks: thresholds accepted for exactly this version; evidence is a replay of a RECORDED run (never REFERENCE, MOCK, mixed or none); current dataset; every task recorded and none rejected; every threshold PASS (an unmeasured metric fails); category floor and minimum category size; no blocking regression against a same-version baseline (a first run without baseline needs an explicit owner flag); human acceptance MEASURED and meeting the bar; agent security review recorded as passed. Status `NOT VERIFIED` when only owner/human inputs are missing, otherwise `BLOCKED`.

## 8. Human reviewer workflow (PROPOSED protocol; owner decision REV names the people)
`createReviewPlan`: at least two named reviewers, a seeded deterministic sample of at least 20 tasks, two distinct reviewers per task in balanced rotation, model identity hidden (blind ids). `validateReview`: assigned reviewer, one review per reviewer and task, integer scores 1-5 (correctness, quality, UI, security), `accept` needs correctness and security >= 3. `summarizeReviews`: acceptance rate, percent agreement, Cohen's kappa, disputes (not accepted until an unassigned reviewer adjudicates); `MEASURED` needs 20 decided tasks and 90 % coverage, else `INCOMPLETE` or `NOT MEASURED`, which never meet the bar.

## 9. Model qualification workflow
State machine `PROPOSED -> EVIDENCE_ATTACHED -> UNDER_REVIEW -> QUALIFIED` (+ `REJECTED`, `SUSPENDED`, effective `EXPIRED` when the dataset or thresholds version changes). Only a passing gate over RECORDED evidence attaches; reviews must be measured and passed; approval needs a person other than the proposer; suspension withdraws the approval; reinstatement needs fresh passing evidence and a new approval. `isQualified` is true only for an unexpired QUALIFIED record.

## 10. Budget enforcement and the live runner (prepared, NEVER run)
`BenchmarkBudget` (approval reference, approver, currency, integer money cap in minor units, token and request caps) is checked before the run (worst case of the whole suite must fit every cap), reserved per task, committed after each call, and an overrun stops the run for good. `runLiveBenchmark` records model behaviour through a `CaptureSource` port and **refuses without calling the source** unless: `BENCHMARK_LIVE_ENABLED` and the live-provider gate (D3) are on; the environment is named and not production; the provider is verified (evidence reference) and the source is exactly that provider and model; thresholds `2-proposed` are accepted by the owner; a budget is approved and large enough; at least two reviewers are named; the agent security review passed. A source declaring itself `mock` yields `MOCK`, never `RECORDED`. After an uncertain outcome it stops and names the task to reconcile before any retry. **No real `CaptureSource` exists**; the real one is an adapter-backed implementation behind the verified provider (S-AG4), written after the owner gates.

## 11. API, UI, migrations (Session 03 deliverables; registration and spec are requests to the Master)
Admin API `/v1/admin/ai/benchmarks` (flag `ai.benchmarks`, default off; reads `admin:ai:read`, writes `admin:ai:manage`/`approve`, audited, idempotent by `requestId`); the live-run endpoint only evaluates preconditions and is always refused today. Dashboard `/{locale}/ai/benchmarks` (Arabic and English). Tables `ai.benchmark_runs` and `ai.benchmark_records` (platform scope, append-only, RLS). Requests: `docs/parallel/sessions/CONTRACT-S03-1..3`.

## 12. What cannot be done offline (unchanged)
Recordings of a real model (needs S-AG4: the probe first, then recorded runs through the gated runner); human acceptance (needs reviewers); real latency; cost at the real rate card (D6); build and visual validation of generated apps (needs D-21, the execution gateway).

## 13. Commands (targeted; no repo-wide runs)
```bash
cd packages/domain && npx vitest run src/ai/benchmarks && npx tsc -p tsconfig.json --noEmit
cd apps/api && npx vitest run src/modules/benchmarks                         # unit
cd apps/api && NUZM_TEST_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54343/postgres npx vitest run -c vitest.integration.config.mts src/modules/benchmarks   # needs the manifest range of CONTRACT-S03-2
cd apps/admin && npx vitest run lib/benchmarks.spec.ts components/benchmarks-dashboard.spec.tsx
```
When a task changes: raise its `revision`, bump `DATASET_VERSION`, regenerate `dataset-lock.ts`, re-record baselines.

## 14. Next steps
1. Master applies CONTRACT-S03-1..3. 2. Owner decides AC-AG-10 (the 20 thresholds), REV (reviewers), BUD (budget), SEC-AG (security review). 3. After S-AG4 closes for Claude and D3/D4/D9 are decided: implement the real `CaptureSource` over the verified adapter, run the live runner once in a named non-production environment, store the recordings and a baseline report, run the gate. 4. Human review per section 8. 5. Add owner-authored golden tasks (never customer data).
