# Phase 2 plan: real integration and production readiness (parallel)

Date: 2026-11-24 · Master: session 01 · Baseline: `integration/ai-engine` @ `fac94541` (all six worker branches merged; full regression green; nothing live).

Goal: take every capability from "offline / simulated" to "verified real" **as each owner approval arrives**, and in the meantime finish all engineering that needs no approval: the builder agent loop, runtime and deployment preparation, QA coverage, and live runners that are built, tested against mocks and sealed behind gates.

Non-negotiables (unchanged from CLAUDE.md and the parallel phase): no live provider call, real credential, agreement, probe, customer-code execution, real deployment or paid resource without the recorded owner decision for that environment; every capability behind a default-off flag; never convert BLOCKED/NOT VERIFIED to PASS with mocks; evidence labels `LIVE-VERIFIED` / `SIMULATED` / `NOT VERIFIED` on every claim; nothing pushed, nothing merged into `main` (D-01).

## 1. Sessions and assignments (the six existing sessions are resumed, not duplicated)
| Session | Workstream | Primary Phase 2 deliverables (offline-complete, live-ready) | Hard stop (needs owner) |
|---|---|---|---|
| 02 Providers | real provider readiness | cost recomputation from current official rates with a hard maximum; probe plan; secure admin provider configuration (key typed into the admin console, sealed in the vault, never in code, logs or reports); spending-cap procedure; capability, streaming, cancel, structured-output, tool-call, usage-accounting, retry/breaker, health and fallback verification as a runnable live-verification suite with a mock twin; real-provider smoke script behind D9; D1–D9 package; `LIVE-PROVIDER-PLAN.md` | D2, D4, D5, D6, D3, D9 |
| 03 Benchmarks | qualification | orchestration across stages A–E with per-stage estimated and maximum cost; threshold recommendations with rationale; reviewer and budget controls; rollout eligibility; admin UI completion; live runner finished and sealed | verified provider (S02), budget, thresholds, reviewers |
| 04 Sandbox | real isolated runtime | evaluation against the actual infrastructure; staging runtime preparation (workspace, FS/process/network isolation, quotas, timeouts, kill, cleanup, secret isolation, dependency policy, artifact extraction, health, scheduling, audit, emergency stop, accounting) as a real-runtime port implementation that **refuses to start unless an isolation attestation for the target exists**; escape suite runner that targets a runtime endpoint; `RUNTIME-QUALIFICATION.md` | D-21, HG-10-02, ADR-069 acceptance (numbered ADR-067 before the hosting join), a Linux non-production node |
| 05 Builder tools | **priority**: agent loop | the 18-step lifecycle wired into the agent-loop run kind and run engine; tool registry, permissions, review/repair, memory, context, multi-file edit, diff/rollback, build/test orchestration, retry and iteration limits, budget and token accounting, cancellation, progress, customer UI (ar/en), HTTP integration and E2E; investigate and resolve the release-build-needs-AI-wallet issue by separating inference cost from build/execution cost | real runtime and provider (mocks until then) |
| 06 Deployment | staging deployment | staging target model and project-type-to-target mapping, artifact deployment, preview URLs, temporary subdomains, SSL, env handling, health, logs, cancel, versioned releases, rollback, failure recovery, approvals; a deployment target port that reuses the hosting provider abstraction; `STAGING-DEPLOYMENT-PLAN.md` | HG-05, HG-06, a staging target and its credentials |
| 07 QA / security | independent verification | builder-tools, provider-admin and benchmark-admin E2E; agent-loop integration tests; audit-chain, ledger, wallet reserve/settle, duplicate-charge, concurrency, idempotency suites; authz matrix extended (viewer, developer, billing admin, deploy, rollback); credential protection; prompt injection; accessibility ar/en; re-examine the two skipped integration tests; independent review of provider/runtime/deployment changes | none for offline work |
| 01 Master | coordination | O-10 seed fix; O-1/O-2/O-9 as policy switches defaulting to current behaviour (§4); approval pack; contract/migration/SDK ownership; merges; serialized heavy regression; reports | owner |

## 2. Resource and conflict rules
- Machine: 4 CPUs, 8 GB. Workers run **targeted** unit and integration tests only. Full `pnpm test:integration`, `pnpm test:e2e:isolated` and `pnpm verify:full*` are run by the Master, or by a worker holding the heavy lock: take it with `mkdir /private/tmp/nuzm-heavy.lock`, release with `rmdir /private/tmp/nuzm-heavy.lock`; if `mkdir` fails, work on something else and try later. TEST_CONCURRENCY stays 2.
- Each worker keeps its own Postgres and E2E ports (54342–54347); the Master uses 54341. The owner's dev stack (3000/3001/4000/54329) is never touched.
- Migrations in Phase 2 use a **new, non-colliding block** (§3): S02 2100–2119, S03 2120–2139, S04 2140–2159, S05 2160–2179, S06 2180–2199, S07 2200–2219 (Master-approved only). Phase 1 files (1900, 1920, 1921, 1980) stay untouched on this branch.
- Shared-contract changes go through `docs/parallel/sessions/CONTRACT-*.md`; the Master applies spec, ownership manifest and SDK changes at integration batches. Workers do not edit `spec/**`, `packages/sdk/**`, `package.json`, `pnpm-lock.yaml`, `app.module.ts`, root `messages.ts` outside a granted exception recorded in the contract file.
- Top-level Phase 2 documents with a named author: `LIVE-PROVIDER-PLAN.md` (02), `RUNTIME-QUALIFICATION.md` (04), `STAGING-DEPLOYMENT-PLAN.md` (06). The Master owns `PHASE-2-PLAN.md`, `PHASE-2-STATUS.md`, `OWNER-APPROVAL-PACK.md`, `PHASE-2-DELIVERY-REPORT.md`.
- Every worker begins by merging the current `integration/ai-engine` into its branch, reports its head after each batch (REPORT-0N, section "Phase 2") and records every blocker as: exact blocker, dependency, which independent task continues.

## 3. External collision found at the start of Phase 2 (hosting workstream)
A separate, active hosting line exists (branch `claude/merge-branches-run-import-295c4d` and siblings, head `3460525c`: "HestiaCP replaces CloudPanel", "Dynadot registrar", landing, desktop app). It is **not** on `integration/ai-engine` and **must not be merged blindly**. It diverged from an older `main` than our baseline and overlaps this effort:
| Item | Hosting line | AI-engine line | Consequence |
|---|---|---|---|
| Migration 1900 | `domains` dnet registrar | `ai` rate card versions | same number, different module |
| Migration 1920 | `platform` docs feedback | `ai` benchmark runs | same number; ranges collide in `ownership.yaml` |
| Migration 1940 / 1960 | `cloud` network settings / `domains` Dynadot | ranges reserved for S04 / S05 (unused) | range overlap only |
| Migration 1980 | `hosting` hestia panel (+ 1985 `cloud`) | `deploy` deployment cancelled | same number |
| ADR-067 | HestiaCP hosting panel | Execution Gateway | **same ADR number** |
| `spec/openapi`, `spec/db/ownership.yaml`, SDK, i18n, lock file | heavily edited | edited | merge conflicts certain |
Decision (Master, reversible):
(a) Phase 2 uses the 2100+ block so no new collisions arise.
(b) A reconciliation plan is prepared but **not executed**: when the owner decides to bring the lines together, the AI-engine ADR becomes `ADR-068`, Phase 1 migrations are renumbered into a free block (rename, manifest, and a note for databases that already applied them), and manifest ranges are merged. The Master writes `docs/parallel/RECONCILIATION-HOSTING.md` with a dry run in a throwaway worktree (neither branch changes).
(c) S06 reads the hosting line **read-only** (`git show` / `git diff`) to design the deployment target port on its provider abstraction. It does not copy, duplicate or merge its adapters.
(d) HestiaCP is a shared web-hosting panel: a candidate for static and PHP site targets only. It is never treated as an isolated runtime for arbitrary AI-generated server code.

## 4. Policy proposals O-1, O-2, O-9: switches, no silent change
Each is implemented as an owner/admin-only, audited policy setting whose **default equals today's behaviour**, with tests for both settings. The proposed policy becomes the default only by an owner decision recorded in `OWNER-APPROVAL-PACK.md`. Proposed names: `deploy.production_publish_roles`, `deploy.rollback_requires_own_approval`, `builder.billing_admin_content_access`. Owners: S06 for O-1/O-2 (deploy approval logic), S05 for O-9 (builder-tools routes), S07 for the tests, Master for any permission seed.

## 5. Order of work
1. Batch 0 (now): workers merge integration, write a short start note, begin; Master does O-10 and the approval pack.
2. Batch 1: S05 agent-loop wiring; S07 E2E for builder tools, provider admin and benchmark admin; S02 live-verification suite with a mock twin; S03 stage and cost plans; S04 runtime preparation and evaluation; S06 target port and staging plan.
3. Batch 2: synthetic project qualification against **simulated** components with an evidence table that marks each component SIMULATED; S07 independent review; Master full regression.
4. Batch 3, only as approvals arrive: live provider probe, Stage A benchmark, staging runtime isolation tests, staging deployment. Each is a separate recorded event with its approval reference.

## 6. Completion ladder (reported separately)
`implemented` (source) → `offline-verified` (tests; mocks labelled) → `live-verified` (real third party, evidence file) → `security-reviewed` (named reviewer) → `operationally ready` (runbooks, alerts, tested rollback) → `production-accepted` (D-42). Phase 2 can finish the first two for everything; later rungs only for items whose approvals arrive.
