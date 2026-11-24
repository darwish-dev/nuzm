# Phase 3 — Real product generation and qualification

Status: **EXECUTING.** The eight sessions were started in parallel on 2026-11-24 from the recorded stable revision `integration/ai-engine` @ `ce16599d` (Phase 2 tested revision `c0043cbd` + docs and scripts only), while the Phase 2 final regression was still running; Phase 3 branches are never merged into the Phase 2 branch during a regression and are reconciled against the accepted Phase 2 revision afterwards. Branches/worktrees are those created by the app for each session (`p3-s01-providers` ... `p3-s08-qualification`; the exact names are in each REPORT-P3-S0N). Owner setup: `docs/phase3/OWNER-SETUP-CHECKLIST.md`. Base: the final Phase 2 revision of `integration/ai-engine` (the exact hash is in `docs/parallel/PHASE-2-DELIVERY-REPORT.md`). Nothing is pushed; nothing is merged into `main` (D-01); no live provider, untrusted-code execution, customer-data processing, paid resource or real deployment happens without the approval recorded in `docs/parallel/OWNER-APPROVAL-PACK.md`.

Phase 2 ended with every capability built, tested and **SIMULATED**. Phase 3 changes the question: *does it work for real?* Its output is **evidence from real components**, not more simulation. A capability counts as real only when its evidence record says `LIVE-VERIFIED` and names the real provider, node, device or host. Anything else is `SIMULATED` or `NOT VERIFIED` and is never rolled into a real number.

## 1. Acceptance targets (the end of Phase 3)
| # | Target | Real components it needs | Evidence record (must exist) |
|---|---|---|---|
| T1 | Generate and deploy a **real business website** | real model, real sandbox build (or static build), real hosting target, real preview | model id, tokens, cost, files, build log, preview URL + health, release id, SSL result |
| T2 | Generate and **run** a real **full-stack web app** with authentication, APIs and PostgreSQL | real model, real isolated runtime with a real PostgreSQL, real deploy target for server code | the same + migration log, auth flow test, API test results, DB isolation proof |
| T3 | Generate a real **Flutter** app and produce an **installable Android APK** | real model, real Flutter + Android SDK build environment (isolated), signing (debug/test key only) | APK file hash, `apkanalyzer`/install on emulator or device log, build log |
| T4 | Build and validate a real Flutter **iOS** app on **macOS + Xcode** | a macOS build host with full Xcode (see blocker B-iOS), no distribution signing | `xcodebuild` log, simulator run or archive without signing, toolchain versions |
| T5 | **Automatic build-error detection and repair** | real model + real build | error text -> repair patch -> rebuilt green, rounds, tokens, cost |
| T6 | Real **preview, deployment, versioning and rollback** | real hosting target | release ids, URL checks, rollback to the previous release verified by content hash |

## 2. Principles
1. **Real or labelled.** Every claim carries `LIVE-VERIFIED` (with evidence file), `SIMULATED` or `NOT VERIFIED`. Reports show them in separate columns and never add them up.
2. **Gates stay closed by default.** Each session builds the real integration behind a gate and proves it refuses without approval. When an approval arrives, the *same code* runs for real. No session waits for an approval to do the unblocked work.
3. **Synthetic data only** until customer-data processing is approved (D1). Test projects are generated from synthetic briefs.
4. **No untrusted code on the developer host.** Generated code executes only in the qualified isolated runtime (P3-S02) or in a disposable build environment explicitly approved for that purpose (see B-iOS, B-Android).
5. **Money and credentials**: keys are typed into the admin console only, never in files, chats, logs or reports. Every paid step has a hard maximum and a stop. Budgets are cumulative per track and recorded.
6. **Spec first, shared files via the Master.** OpenAPI, ownership manifest, SDK, `app.module.ts`, root `package.json`, lockfile, `messages.ts` and migrations numbering belong to the Master; sessions send CONTRACT requests.

## 3. Sessions and dependency map
```
P3-S01 Providers+Tools ──┬──────────────► P3-S03 Agent loop+repair ──┬─► P3-S04 Website ──────┐
P3-S02 Sandbox+Runtime ──┤                                            ├─► P3-S05 Full-stack ───┤
                         ├──► P3-S06 Flutter/APK/iOS (build env) ◄────┘                        ├─► P3-S08 Qualification
P3-S07 Hosting+Deploy ───┴──────────────────────────────────────────────────────────────────────┘     (security, QA, evidence)
```
| Session | Needs from others | Provides to others |
|---|---|---|
| P3-S01 Real AI Providers and Tool Calling | owner: D2,D5,D6,D4,D3,D9 | live model gateway with tool-call evidence (S03, S04, S05, S06, S08) |
| P3-S02 Real Sandbox and Execution Runtime | owner: D-21, HG-10-02, ADR acceptance, a Linux node | qualified `ExecutionPort` (S03, S05, S06, S08); egress/registry policy |
| P3-S03 Real Agent Loop and Automatic Repair | S01 (model), S02 (runtime) for real runs; works on mocks meanwhile | the loop used by S04, S05, S06; repair engine |
| P3-S04 Website Generation and Live Preview | S03 loop; S02 only for server-side builds; S07 for deploy | website pipeline + preview; T1 |
| P3-S05 Full-Stack Web Application Generation | S03, S02 (real runtime with PostgreSQL), S07 (server deploy target) | T2 |
| P3-S06 Flutter, Android and iOS Build Engine | S03; S02 design for isolated Android build; owner: macOS/Xcode host | T3, T4 |
| P3-S07 Real Hosting and Deployment | hosting line (Hestia adapter, join with `main`), HOST-TRANSPORT decision, HG-05/06 | deploy/rollback for S04, S05; T6 |
| P3-S08 Real Product Qualification, Security and QA | all of the above | the acceptance evidence for T1–T6, security qualification, final report |

**Unblocked work that starts on day one (no approval needed):** S01 live-run harness, evidence ingestion and rotation tooling; S02 node-agent implementation, image/rootfs build, egress proxy and registry mirror configs, escape-suite endpoint wiring; S03 real-model prompt/tool plumbing against the mock gateway and the repair strategy corpus; S04 website templates, RTL/a11y/SEO generators, static-build pipeline, preview UI; S05 full-stack templates (auth, API, migrations, PostgreSQL), test generation; S06 Flutter project engine hardening, Android build recipe in an isolated environment definition, iOS build plan and Xcode prerequisites checker; S07 hosting join, deploy target port wiring to `HestiaHostingAdapter`, HOST-TRANSPORT implementation *if the owner assigns it*; S08 qualification harness, evidence schemas, negative/security suites, CI gates.

## 4. Branch strategy
- **Phase 3 base:** the Master creates `integration/phase3` from the final Phase 2 revision, **after** the hosting join is decided: if the owner authorizes it, `integration/phase3` is `integration/ai-engine` + `main` (hosting/HestiaCP/Dynadot) following `docs/parallel/RECONCILIATION-HOSTING.md` (migrations 1900/1920/1921/1980 -> 2210–2213, ADR-067 -> ADR-069, SDK/lock regenerated, full regression). Until then S07's real-hosting work is limited to the port/seam and the plan; S01–S06, S08 are unaffected.
- **Session branches:** `feature/p3-s01-providers`, `p3-s02-runtime`, `p3-s03-agent-loop`, `p3-s04-website`, `p3-s05-fullstack`, `p3-s06-mobile`, `p3-s07-hosting`, `p3-s08-qualification`; one worktree each (`.claude/worktrees/p3-s0N`), own Postgres port (54351–54358), own E2E ports. The Master uses 54341.
- **Integration:** only the Master merges into `integration/phase3`, in batches, then runs the serialized regression (verify, integration, isolated E2E ar+en). Sessions merge `integration/phase3` into their branch before each batch. No session merges into another session's branch except the documented direct-merge cases (e.g. a shared helper) announced to the Master. Nothing is merged into `main` or pushed without the owner's explicit authorization.
- **Migrations:** P3 block **2300–2399** (S01 2300–2309, S02 2310–2319, S03 2320–2329, S04 2330–2339, S05 2340–2349, S06 2350–2359, S07 2360–2369, S08 2370–2379; 2380–2399 Master). Phase 2 files stay untouched. `ownership.yaml` ranges are applied by the Master from the session's CONTRACT file.
- **Heavy runs:** lock `mkdir /private/tmp/nuzm-heavy.lock` (release with `rmdir`); sessions run targeted tests only; the Master runs full suites.

## 5. File ownership contract (a session edits only what it owns; everything else is a CONTRACT request)
| Session | Owns |
|---|---|
| P3-S01 | `packages/adapters/model/**`, `apps/api/src/modules/ai/**` (providers, gateway, runs, rate cards, evidence, billing hooks; not the builder lifecycle), `apps/admin/**/ai-*provider*`, `docs/adapters/**`, `docs/parallel/LIVE-PROVIDER-PLAN.md` |
| P3-S02 | `packages/domain/src/ai/execution-gateway/**`, `apps/api/src/modules/appbuilder/internal/sandbox/**`, `apps/api/src/modules/execution/**`, new `packages/runtime-agent/**` (node agent) and `infra/runtime/**`, `docs/security/sandbox/**`, `docs/parallel/RUNTIME-QUALIFICATION.md` |
| P3-S03 | `apps/api/src/modules/appbuilder/**` except `internal/sandbox/**`, `internal/deploy/**`, webapp templates; `packages/domain/src/ai/agent-tools/**`, `packages/domain/src/ai/agent-loop/**`; `apps/web/components/Builder*.tsx`, `apps/web/app/**/builder/**/agent` |
| P3-S04 | `apps/api/src/modules/builder/**` (website, previews, forms, CMS), `apps/api/templates/webapp-preview/**`, website generator/prompt assets, `apps/web/**/website*`, preview UI |
| P3-S05 | `apps/api/templates/webapp-runtime/**`, `apps/api/src/modules/appbuilder/internal/gen/**` webapp generation + DB provisioning for generated apps, full-stack templates, generated-app tests |
| P3-S06 | `apps/api/src/modules/mobile/**`, `apps/api/templates/flutter-core/**`, `apps/web/lib/mobile*`, `apps/web/**/mobile*`, build-environment definitions under `infra/mobile/**`, `docs/mobile/**` |
| P3-S07 | `apps/api/src/modules/deploy/**`, `packages/domain/src/deploy-transport/**`, deploy-related web/admin UI, `docs/parallel/STAGING-DEPLOYMENT-PLAN.md`, `docs/parallel/HOST-TRANSPORT-*.md`; reads (never edits) `apps/api/src/modules/hosting/**` and the hosting line |
| P3-S08 | `e2e/tests/**` (new files `p3-*.spec.ts` and fixtures), `apps/api/src/qa/**`, `packages/domain/src/ai/benchmarks/**`, `apps/api/src/modules/benchmarks/**`, `docs/security/**` (non-sandbox), `docs/phase3/EVIDENCE/**` |
| Master | `spec/**`, `packages/sdk/**`, `packages/contracts/**`, migrations numbering and `spec/db/ownership.yaml`, `packages/i18n/src/messages.ts` (sessions append delimited blocks), `app.module.ts`, root `package.json`, lockfile, `turbo.json`, `scripts/**`, `CLAUDE.md`, `docs/phase3/*.md` (not sessions' own reports), `docs/parallel/OWNER-APPROVAL-PACK.md` |
Any edit outside a session's row is reverted by the Master at merge time.

## 6. Evidence and reporting
Each session writes `docs/phase3/sessions/REPORT-P3-S0N.md` (format of CLAUDE.md §10) and, for every real run, an evidence file under `docs/phase3/EVIDENCE/<track>/<date>-<id>.json` with: component versions, approval references, model/node/host identity, inputs (hashes), outputs (hashes), costs, durations, result. Evidence never contains secrets or customer data. P3-S08 verifies each evidence file against its schema and builds the acceptance matrix.

## 7. Owner decisions Phase 3 adds (consolidated into `OWNER-APPROVAL-PACK.md`, Phase 3 section)
B-iOS (macOS host with full Xcode; this Mac has only Command Line Tools and macOS 13.7.8), B-Android (isolated Android build environment approval), B-DB (PostgreSQL for generated full-stack apps in staging: where it runs), B-DOMAIN (preview/staging domain and wildcard certificate), B-APPLE (Apple Developer account only if device/TestFlight is ever wanted: not needed for T4), B-SIGN (Android test keystore custody), and the Phase 2 items D2–D9, D-21, HG-10-02, HG-05/06, HOST-TRANSPORT, the hosting join, AC-AG-10, BUD, REV, SEC-AG. None blocks starting Phase 3.

## 8. Phase 3 exit
All six targets have `LIVE-VERIFIED` evidence reviewed by P3-S08, or the exact external blocker for each missing one is documented. The final report states readiness separately for: provider, runtime, build environments, deployment, security qualification and production acceptance. Production activation (D-AG-ROLLOUT) is still a separate owner decision.
