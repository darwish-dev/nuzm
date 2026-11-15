# M10 — Full-stack AI App Builder & Mobile Builder

> Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.
> Response format: CLAUDE.md §10. Status words: PASS / FAIL / BLOCKED / NOT VERIFIED only.

| Field | Value |
|---|---|
| Sprints | S42–S50 (9). **Two gated parts:** M10A = S42–S47 (web/full-stack apps); M10B = S48–S50 (Flutter mobile). M10B may not start until the M10A Gate Review is signed. |
| Depends on (docs/03) | **H:** M01, M02, M04, M05, M06, M08, M09 · **S:** M07 · **—:** M03 (billing flows reused, no new payment work) |
| Produces | Agent graph + checkpoints/approvals, generated-app scaffolding (schema/backend/frontend), isolated sandbox runner, browser IDE + terminal, Git, test runner, app deployments/rollback, source export, Flutter generation, signed-build workers, release-preparation workflow |
| Gate | **M10A Gate (S47):** Reference CRM passes the *independent* E2E suite; export, deploy and rollback work; isolation validated by the escape-attempt suite. **M10 Gate (S50):** M10B acceptance rows PASS or explicitly BLOCKED (HG-10-01 / D-22) per gate review. |

## 1. Objective
Let a customer describe a full-stack web application (and later a mobile app), have a coordinated set of AI agents generate schema, backend, frontend and tests inside an **untrusted-code sandbox**, iterate in a browser IDE under hard budget caps and human approvals, then deploy, roll back and export it. Mobile: generate Flutter projects, build Android/iOS artifacts on isolated workers, sign them only with credentials the owner authorizes, and prepare (never guarantee) store releases.

## 2. Preconditions & mocked interfaces
| Dependency | Needed real for | Mock allowed meanwhile (label in report) |
|---|---|---|
| M09 model gateway, `ai.runs`, `/v1/ai/runs` events, budgets, `builder.projects`, `deploy.*` | S42 start | Scripted model adapter returning recorded fixtures (`NOT VERIFIED` for model quality) |
| M05 compute (nodes for sandbox pool) | S45 acceptance | Local container runner for dev only, **labelled non-isolated; never counted as isolation evidence** |
| M08 managed PostgreSQL (generated app DBs) | S43 acceptance | Ephemeral dev database in docker-compose |
| M06 hosting site / M05 compute as deploy targets | S47 | Dev static target |
| D-18/HG-09-01 model providers + terms | live generation quality | Mock gateway |
| D-21 sandbox technology decision + HG-10-02 security review | S45 | Provisional runner in staging only, flagged `UNREVIEWED` |
| D-22 + HG-10-01 macOS capacity, Apple/Google accounts, signing material | S49 iOS/Android *signed* artifacts | Unsigned debug build on Linux for Android; iOS **BLOCKED** (no simulation of success) |
| Reference CRM spec + independent test suite author | S44 (spec freeze), S47 | none — see §4 protocol; gate cannot pass without it |

## 3. Requirement IDs closed
FR-APP-01 agent graph · FR-APP-02 schema/backend/frontend generation · FR-APP-03 sandbox · FR-APP-04 browser IDE · FR-APP-05 Git · FR-APP-06 tests · FR-APP-07 deploy/rollback · FR-APP-08 export · FR-APP-09 Flutter generation · FR-APP-10 signed builds/release preparation. UI: FR-UI-M10-* = screens in §8. *(Order of FR-APP-xx follows the list in docs/01 §5; confirm.)*

## 4. Automatable engineering tasks
**S42 (M10A) — Agent graph.** 1. Task-graph runner: agents = requirements, architecture, database, backend, frontend, QA, DevOps; nodes carry input/output artifact schemas; DAG validated before run. 2. `ai.run_steps` / `ai.tool_calls` persistence; checkpoint after every node (resume from last checkpoint after worker crash). 3. Approval engine: run enters `waiting_approval`, resumes via `POST /v1/ai/runs/{id}/approvals`; approval types in §9. 4. Budget enforcer in front of gateway calls (caps in §9). 5. `builder.app_specs` (versioned structured spec: entities, roles, pages, API, non-functional).
**S43 — Schema/backend agents.** 1. Generated-app DB schema + versioned migrations (reversible, expand/contract aware; destructive statements trigger approval). 2. Generated API contract (OpenAPI for the *generated app*, validated with the same linter as Nuzm). 3. RBAC scaffold in generated app (roles → permissions, row-level ownership rule). 4. Dependency policy engine (§9 supply chain). 5. Contract-test generator for generated API.
**S44 — Frontend agents + CRM spec freeze.** 1. Frontend scaffold (Arabic RTL/English, forms, tables, auth, error states). 2. End-to-end project scaffold assembled into `builder.project_files`. 3. **Before S44 ends the owner freezes `spec/reference/crm-spec.md` (hash recorded in `spec/reference/crm-spec.sha256`).** 4. Evaluation harness (`ai.evaluations`): scores per agent against fixtures.
**S45 — Sandbox runner.** 1. Runner service on dedicated node pool (separate network segment, no route to control-plane datastores) using technology chosen under D-21. 2. Lifecycle API (`/v1/builder/projects/{id}/sandboxes`), quotas, idle/max lifetime reaping. 3. Egress proxy with allow-list + package mirror (§9). 4. Terminal over WebSocket with session audit. 5. Canary-secret framework + escape-attempt suite (§11) run in CI against a real runner (not the local mock). 6. Metering emission (`ai.sandbox_cpu_seconds`). 7. Hand security-review pack to HG-10-02.
**S46 — IDE, Git, tests, debugging.** 1. Browser IDE (editor, file tree, diff, terminal, preview) bound to sandbox. 2. Git: per-project bare repo in `builder.git_repos`; agent changes land as commits on a work branch; checkpoints = tags; safe-diff apply via `POST …/changes`. 3. Test runner (`test-runs`): unit/typecheck/build/E2E in sandbox, structured results. 4. `test-fix` run kind: bounded debugging loop (caps §9). 5. Concrete Git sub-paths: submit a spec change request (SCR-M10-01) replacing `…/git/…` in docs/04 with exact paths; **no Git API code before owner approves the SCR.**
**S47 — Deploy, rollback, export, gate.** 1. App deployments via `POST /v1/deployments` (targets: hosting site or compute instance, per M06/M05), build in sandbox, release artifact versioning, health-check gate, rollback. 2. Export (`exports`): source + lockfiles + migrations + README + OpenAPI + SBOM, no Nuzm secrets, builds standalone. 3. Run the Reference CRM through generation → independent E2E suite → deploy → rollback → export → rebuild-from-export. 4. M10A report and Gate Review package.
**S48 (M10B) — Flutter generation.** 1. Template set (navigation, state mgmt, theming, RTL, auth, forms) with pinned toolchain version recorded in report. 2. Mobile design agent (screens → widgets); `/v1/ai/runs kind=mobile`. 3. Dependency allow-list for `pub`-ecosystem packages via mirror. 4. Previews through `/v1/builder/projects/{id}/previews` (web-rendered preview; device preview fidelity statement must be explicit: *preview ≠ device guarantee*).
**S49 — Build workers & signing.** 1. Android build workers in sandbox-class isolation. 2. iOS workers only on macOS capacity per D-22 (**BLOCKED until D-22/HG-10-01**). 3. `POST /v1/mobile/signing-credentials` stores **vault references only**; signing happens in a worker that receives short-lived material, never logs it, never copies it into artifacts or sandboxes running generated code (separate "signing stage" worker not reachable by project code). 4. Artifact storage with retention policy (proposal: 30 days default, release artifacts 12 months — D-34). 5. `mobile.build_minutes` metering.
**S50 — Release preparation.** 1. Release record: version, build refs, store metadata draft, screenshots, privacy-policy URL checklist, permission declarations, compliance checklist. 2. Explicit **account-owner approval** step before any "submission preparation export"; the platform does **not** submit to stores in this milestone unless the owner separately authorizes it and it is added to the spec. 3. Copy lint: no UI/doc text promising store approval or review bypass. 4. M10 report.

**Reference CRM spec & independent-test protocol (M10A Gate)**
- *CRM scope (frozen in `spec/reference/crm-spec.md`):* entities Account, Contact, Lead, Opportunity (stages: New → Qualified → Proposal → Won/Lost), Task, Note, Attachment(≤10 MB); roles Admin, Sales Manager, Sales Rep, Read-only; Reps see only own records, Managers see team, Admin sees all; CRUD with validation, search/filter/sort/pagination, pipeline board, CSV import/export, audit trail per record, 3 dashboard widgets, Arabic RTL + English, REST API with OpenAPI, email notification on assignment (via M08 transactional email, mock allowed in test).
- *Ownership:* the independent suite lives in `tests/independent-crm-e2e/`, authored by a party **other than the generating agent and its prompts**: (a) human QA, or (b) a separate agent session given only the frozen CRM spec (no generator code, prompts, or outputs), recorded by the owner as **PROPOSED-HG-10-03** (new gate; see report "Spec issues").
- *Hand-off:* spec frozen (hash) → suite authored, coverage matrix spec-clause → test id → suite committed under CODEOWNERS owned by the test author, agent write access removed, suite hash pinned in CI → generator runs → suite executed unchanged against the deployed CRM → results archived. If the suite finds a defect, the generator may fix the *app*; any change to the suite requires test-author approval and re-hash with changelog.
- *Size/targets (proposals):* ≥150 cases; every spec clause covered by ≥1 case; P0 (auth, RBAC, data isolation, CRUD, pipeline) ≥60 cases.

## 5. Human approvals & external gates
| ID | Need | Agent does meanwhile | Default status |
|---|---|---|---|
| HG-09-01 / D-18 | Model contracts & inference residency | Mock gateway; record NOT VERIFIED for quality | PENDING |
| D-21 | Sandbox isolation technology | Prepare comparison + threat model; build behind `SandboxRuntime` interface | OPEN |
| HG-10-02 | Independent security review of sandbox | Produce review pack (architecture, threat model, escape-suite results) | PENDING |
| PROPOSED-HG-10-03 | Independent CRM test-suite author + CRM spec owner | Prepare spec template and protocol; cannot author the independent suite | PENDING (id to be added to docs/07) |
| D-22 | macOS build capacity for iOS | Android path only; iOS BLOCKED | OPEN |
| HG-10-01 | Apple Developer / Google Play accounts, owner-authorized signing material, macOS capacity | Unsigned debug builds only; signed artifacts BLOCKED | PENDING |
| HG-05-04 | Provider quota for sandbox node pool | Size pool with quotas actually granted | PENDING |
| D-34 | Retention for artifacts/logs | Use proposals, flag | OPEN |
| HG-04-01 | Counsel view on user-content/IP, generated-code licensing statement | Draft ToS addendum text for review | PENDING |

## 6. API specifications (docs/04 §2.9–2.10 — restated exactly; M09 owns `/v1/ai/*` and `/v1/deployments`, M10 extends)
Common: auth = session/API key; org from token; `Idempotency-Key` required on every POST; problem+json errors; async → `202` + `operationId`. Permission names are proposals (catalogue in M01).
| Method & path | Portals | AuthZ | Key request/response | Errors | Async/Idem |
|---|---|---|---|---|---|
| POST `/v1/ai/runs` (`kind` ∈ `webapp`,`mobile`,`test-fix`; also `edit`,`website`,`chat` from M09) | C A R | `ai:run` + project write | `{kind, projectId, sessionId?, specRef?, budget{maxTokens,maxCostMinor,maxMinutes}}` → `{runId, status, budgetRemaining}` | 402 `budget_required`, 403 residency, 422 `unsupported_capability`, 429 | 202; idempotent by key |
| GET `/v1/ai/runs/{id}` · GET `…/events` (SSE) | C A R | `ai:read` | steps, tool-call summaries (redacted), budget meter | 404 cross-tenant = 404 | — |
| POST `/v1/ai/runs/{id}/cancellation` | C A R | `ai:run` | stops at next checkpoint; sandbox released | 409 terminal state | idempotent |
| POST `/v1/ai/runs/{id}/approvals` | C A R | `ai:approve` (+ role per type) | `{approvalId, decision: approve|reject, scopeHash}`; approval bound to exact action hash | 409 stale hash, 410 expired | idempotent |
| GET/PUT `/v1/ai/budgets` · GET `/v1/ai/credits` · GET `/v1/ai/models` | C A R | `ai:budget` | org/project caps | 422 | — |
| POST/GET `/v1/builder/projects` (`type` = `webapp`\|`mobile`) · GET/PATCH/DELETE `…/{id}` | C A R | `builder:*` | project metadata, `dataRegion` | 422 residency | PATCH uses ETag |
| GET `/v1/builder/projects/{id}/files` · GET `…/files/content?path=` | C A R | `builder:read` | tree/content (size cap 1 MB inline) | 404 | — |
| POST `/v1/builder/projects/{id}/changes` | C A R | `builder:write` | safe diff set `{baseVersion, patches[]}`; path-traversal & secret-pattern rejection | 409 base mismatch, 422 | idempotent |
| GET `/v1/builder/projects/{id}/versions` · POST `…/versions/{vid}/restoration` | C A R | `builder:write` | version list; restore creates new version | 404 | 202 if large |
| POST/GET `/v1/builder/projects/{id}/previews` | C A R | `builder:read` | preview URL (isolated origin), TTL | 429 | 202 |
| POST `/v1/builder/projects/{id}/sandboxes` · GET/DELETE `…/{sid}` · WS `…/{sid}/terminal` | C A R | `sandbox:use` | `{profile, ttlMinutes}` → sandbox state, quotas, egress profile id; WS authenticated by short-lived ticket | 409 quota, 402 credits, 503 `no_capacity` | 202 |
| POST/GET `/v1/builder/projects/{id}/test-runs` | C A R | `builder:test` | `{suite: unit|typecheck|build|e2e|all}` → results (junit-like JSON), logs ref | 422 | 202 |
| POST/GET `/v1/builder/projects/{id}/exports` | C A R | `builder:export` | archive ref, sha256, SBOM ref; signed URL TTL ≤15 min | 403 residency export rule | 202 |
| GET/POST `/v1/builder/projects/{id}/git/…` | C A R | `builder:git` | **Exact sub-paths pending SCR-M10-01 (docs/04 uses ellipsis). Do not implement until approved.** | — | — |
| POST `/v1/deployments` · GET `/v1/deployments` · GET `…/{id}` · GET `…/{id}/logs` · POST `…/{id}/rollback` | C A R | `deploy:*` (prod target needs approval) | `{projectId, versionId, target{type: site|instance, id}, env}` | 409 health gate failed, 422 | 202; rollback idempotent |
| POST/GET `/v1/mobile/builds` · GET `…/{id}` · GET `…/{id}/artifacts` | C A R | `mobile:build` | `{projectId, versionId, platform: android|ios, profile: debug|release}` | 422 `signing_not_authorized`, 503 `no_macos_capacity` | 202 |
| POST/GET `/v1/mobile/signing-credentials` | C A R | `mobile:signing` (owner/admin role only) | `{platform, label, vaultRef, authorizedBy}` — **no key material in body** | 422 raw-secret rejected | idempotent |
| POST/GET `/v1/mobile/releases` | C A R | `mobile:release` | release-prep record; status `draft→prepared→owner_approved` | 422 checklist incomplete | idempotent |
| GET `/v1/admin/ai/runs` | X | `admin:ai:read` | read-only support view | — | — |
| GET `/v1/admin/resources` · POST `/v1/admin/resources/{id}/reconciliations` | X | `admin:cloud` | sandbox-node inventory (M05) | — | 202 |

## 7. Database migrations (owner per docs/05; migration range allocated in `spec/db/ownership.yaml` at S42)
| Schema.table | Action | Key columns / notes |
|---|---|---|
| `ai.run_steps` | create (extends `ai`) | `run_id, seq, agent, status, input_ref, output_ref, checkpoint_ref, tokens_in/out, started_at, finished_at`; idx `(run_id, seq)` |
| `ai.tool_calls` | create | `step_id, tool, args_redacted jsonb, result_ref, duration_ms, approved_by?, action_hash` |
| `ai.evaluations` | create | `run_id?, suite, score numeric, details jsonb` |
| `ai.artifacts` | extend (M09) | `kind` enum adds `app_spec, openapi, test_report, sbom` |
| `builder.app_specs` | create | `project_id, version, spec jsonb, status`; unique `(project_id, version)` |
| `builder.sandboxes` | create | `project_id, profile, node_ref (cloud.resources id), state, ttl_at, quota jsonb, egress_profile, data_region` |
| `builder.test_runs` | create | `project_id, version_id, suite, status, summary jsonb, logs_ref` |
| `builder.exports` | create | `project_id, version_id, archive_ref, sha256, sbom_ref, expires_at` |
| `builder.git_repos` | create | `project_id, storage_ref, default_branch, last_commit` |
| `builder.projects` | extend | `type` accepts `webapp, mobile`; `reference_template` nullable |
| `deploy.deployments` / `deployment_logs` / `builds` | extend (M09) | `target_type, target_id, health_check jsonb, rollback_of` |
| `mobile.builds` | create (new schema) | `project_id, version_id, platform, profile, status, worker_ref, minutes_billed, toolchain jsonb` |
| `mobile.artifacts` | create | `build_id, kind(apk|aab|ipa|symbols), storage_ref, sha256, signed bool, retention_until` |
| `mobile.signing_credential_refs` | create | `platform, label, vault_ref, authorized_by, authorized_at, revoked_at` — never key material |
| `mobile.releases` | create | `project_id, build_id, version_name, store, checklist jsonb, status, owner_approved_by/at` |
All tables: `org_id`, RLS forced, `data_region`, ownership manifest updated, no cross-schema FKs. Append-only: none new (audit events cover mutations). Seed: sandbox profiles, egress profiles, allow-list ecosystems (reference data). **Reversal:** `.down.sql` for dev/staging; production = forward fix; `mobile.*` drop only before first data (expand/contract applies afterwards).

## 8. UI screens (apps/web `(customer)` group unless noted; AR-RTL + EN; loading/empty/error/forbidden states)
| ID | Portal | Route | Purpose / key states | Roles |
|---|---|---|---|---|
| UI-M10-01 | C A R | `/builder/projects/new/app` | App-generation wizard: prompt → requirements review → budget → start | builder:write |
| UI-M10-02 | C A R | `/builder/projects/[id]` | Project overview: versions, runs, deployments | builder:read |
| UI-M10-03 | C A R | `/builder/projects/[id]/ide` | Browser IDE: tree, editor, preview, run panel; sandbox starting/quota-exceeded/offline states | sandbox:use |
| UI-M10-04 | C A R | `/builder/projects/[id]/sandboxes/[sid]/terminal` | Full-screen terminal; session-ended, egress-denied notices | sandbox:use |
| UI-M10-05 | C A R | `/builder/projects/[id]/changes` | Git diff, commit/checkpoint list, restore | builder:git |
| UI-M10-06 | C A R | `/builder/projects/[id]/runs/[runId]` | Agent run viewer: steps, redacted tool calls, live budget meter, approve/reject | ai:read, ai:approve |
| UI-M10-07 | C A R | `/approvals` | Pending approvals inbox across runs/deployments/releases | ai:approve |
| UI-M10-08 | C A R | `/builder/projects/[id]/tests` | Test runs, failures, re-run, "ask AI to fix" (creates `test-fix` run) | builder:test |
| UI-M10-09 | C A R | `/builder/projects/[id]/deployments` | Deployments list/detail/logs, health gate, rollback confirm | deploy:* |
| UI-M10-10 | C A R | `/builder/projects/[id]/exports` | Request/download export, checksum, SBOM | builder:export |
| UI-M10-11 | C A R | `/builder/projects/[id]/settings/budget` | Run/org budgets, approval policy, alerts | ai:budget |
| UI-M10-12 | C A R | `/mobile/new` | Mobile project wizard (type=mobile) | builder:write |
| UI-M10-13 | C A R | `/mobile/[id]/preview` | Preview with explicit "preview ≠ device" notice | builder:read |
| UI-M10-14 | C A R | `/mobile/[id]/builds` | Build list, artifacts, logs, minutes used; iOS-unavailable state | mobile:build |
| UI-M10-15 | C A R | `/mobile/[id]/signing` | Signing credential references (no secret display), authorize/revoke | mobile:signing |
| UI-M10-16 | C A R | `/mobile/[id]/releases` | Release records list | mobile:release |
| UI-M10-17 | C A R | `/mobile/[id]/releases/new` | Release-preparation wizard + owner-approval step; no approval promises | mobile:release |
| UI-M10-18 | X | `/ai/runs` | Run oversight (read-only), budget-breach and denied-approval flags | admin:ai:read |
| UI-M10-19 | X | `/sandboxes` | Sandbox fleet oversight: nodes, usage, quota breaches (read via `/v1/admin/resources`); **force-kill action requires an SCR (no endpoint in docs/04) → hidden until approved** | admin:cloud |

## 9. Security, compliance & tenant isolation
**Isolation:** control plane never executes generated code; sandboxes per project/run, no shared FS/PID/net namespaces, no host mounts, no container-runtime socket, non-root, default-deny seccomp, no privileged capabilities, read-only root FS, metadata endpoints and RFC1918/control-plane ranges blocked.
**Quotas (proposals, tune after D-21):** 2 vCPU, 4 GB RAM, 10 GB disk, 512 PIDs, 5 concurrent sandboxes/org, idle timeout 30 min, max lifetime 4 h, build time 20 min.
**Egress allow-list:** default deny. Allowed via filtered DNS + proxy: package mirror (npm/pub registries through scanning mirror), Nuzm Git, Nuzm model gateway (budgeted), declared preview origin. Everything else needs `egress` approval (time-boxed, hash-bound).
**Canary secrets:** unique canary tokens/files planted in runner host env, control-plane network, neighbor sandboxes and `~/.aws`-style well-known paths; any read/use pages security (alert) and fails the suite.
**Supply chain:** ecosystem allow-list; lockfile mandatory; install scripts off by default; vulnerability scan (known-advisory database) fails build at high severity; typosquat/name-similarity check; license check against policy; dependency count cap (proposal 200 direct+transitive growth per run requires approval); SBOM per project version.
**Budget caps (proposals; D-18/D-23):** per run ≤ 2,000,000 tokens, ≤ 60 min, ≤ 200 steps, cost cap = min(run cap, org remaining); warn 80 %, hard stop 100 % (overshoot ≤ one in-flight call). **Debug loop:** ≤ 5 consecutive fix iterations per failing test group, ≤ 15 per run, stop on 3 identical failure signatures, then escalate to human.
**Approval gates (human, hash-bound to exact action, expire 24 h):** production deploy/rollback · rollback of data-affecting migration · destructive migration (DROP/TRUNCATE/column removal) · any paid resource creation (database, compute, domain) · egress or dependency outside allow-list · budget increase · export containing non-owner-authored third-party code flags · mobile signing use · release owner-approval.
**Compliance hooks:** `ResidencyPolicyService` before: choosing model provider (M09), placing sandbox node region, storing artifacts/exports, deploying to region. PII: generated app test data must be synthetic; prompts/outputs classified `customer-content`; build/test logs scanned for secrets (redact). Audit events: `run.started`, `run.approval.requested|decided`, `sandbox.created|terminated`, `deploy.created|rolled_back`, `export.created|downloaded`, `signing.credential.authorized|used`, `release.owner_approved`.
**Tenant isolation:** sandbox, git repo, artifacts and exports keyed by `org_id` and verified on every access; WS tickets single-use, 60 s TTL, bound to sandbox + user.

## 10. Metering & billing hooks
| Meter | Emit point | Quota/limit |
|---|---|---|
| `ai.tokens_input`, `ai.tokens_output`, `ai.credits_consumed` | gateway per call (M09) | budget enforcer pre-check |
| `ai.sandbox_cpu_seconds` | runner every 60 s + on terminate (idempotent event id `sandboxId:window`) | org concurrent/CPU-second quota |
| `builder.build_minutes` | test-run/build/deploy-build completion | quota |
| `mobile.build_minutes` | mobile build completion (macOS minutes flagged via dimension `platform=ios`) | quota |
| Compute used by deployments | M05 meters (`compute.*`) from the target | per M05 |
Spend authorization via `commerce.quotes` (`kind=ai-credit`) and spend-approval flow (M02) before runs exceeding limit.

## 11. Automated tests
- **Unit:** DAG validation, budget enforcer math, approval hash binding, path-traversal/secret-pattern rejection in changes, dependency policy.
- **Integration:** run crash → resume from checkpoint without duplicate steps; sandbox TTL reaping; export archive rebuild; deployment health-gate failure → auto-rollback.
- **Contract:** OpenAPI conformance for all §6 endpoints; generated-app OpenAPI lint; adapter conformance kit for build workers.
- **E2E:** Reference CRM *independent* suite (§4); wizard → run → approval → deploy → rollback UI path (Playwright, AR & EN).
- **Escape-attempt suite (documented, versioned, `tests/security/sandbox-escape/`) — ≥60 attempts across:** namespace/capability abuse, mounted-path probing, container-runtime-socket access, `/proc` & `/sys` leaks, kernel-interface fuzz basics, metadata-service reach, lateral reach to control plane & other sandboxes, DNS exfil/tunnelling, proxy bypass (IP literals, IPv6, redirects), fork bomb/disk fill/CPU spin (quota enforcement), symlink/path traversal via changes API, WS ticket reuse. Expected: 0 successes; each attempt logged with expected control.
- **Canary tests:** canary read/use detected = failure.
- **Failure/timeout/concurrency:** model timeout mid-step; provider `no_capacity`; 20 parallel sandbox creates at quota edge; duplicate approval submission; stale-hash approval; duplicate `POST /v1/deployments` with same key.
- **Cross-tenant:** every §6 resource accessed with org B token → 404; sandbox terminal ticket stolen across orgs → rejected.
- **Security:** dependency typosquat fixture blocked; install script blocked; secret in generated file blocked from export; log redaction test.
- **Mobile:** template build in CI (Android debug); signing never logs secret (log-scan test); artifact checksum; copy-lint test for approval promises.
- **Load (proposal):** 50 concurrent runs, 100 concurrent sandboxes on the pool, p95 sandbox ready ≤ 60 s.

## 12. Deliverables
Source + migrations + `spec/` updates (OpenAPI, ownership, events, `spec/reference/crm-spec.md`), UI screens §8, sandbox threat model + escape-suite report + HG-10-02 pack, SBOM tooling, runbooks (`docs/runbooks/sandbox-fleet.md`, `deploy-rollback.md`, `mobile-signing.md`), demo script (CRM end-to-end; mobile debug build), `docs/reports/M10A-report.md` (S47) and `docs/reports/M10-report.md` (S50), gate-review documents.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Status |
|---|---|---|---|
| AC-M10-01 | Independent CRM suite: 100 % of P0 and ≥95 % of all cases pass on the generated, deployed CRM; suite hash unchanged since freeze | CI run, hash check | PENDING (needs PROPOSED-HG-10-03) |
| AC-M10-02 | Escape-attempt suite ≥60 attempts, 0 successful; canary secrets 0 reads | suite report, canary monitor log | PENDING |
| AC-M10-03 | HG-10-02 security review report received, no open critical/high | report | BLOCKED-until-evidence |
| AC-M10-04 | Budget cap: run halts ≤ one in-flight call after cap; debug loop stops at 5/15/3-signature limits in tests | test output | PENDING |
| AC-M10-05 | Every approval type in §9 blocks execution until approved; stale/expired approval rejected (100 % of test matrix) | test output | PENDING |
| AC-M10-06 | Deploy → rollback restores prior version; p95 rollback ≤ 5 min on test target | deployment logs | PENDING |
| AC-M10-07 | Export rebuilds from clean checkout with no Nuzm secrets/dependencies and passes its own unit tests | CI log, secret scan | PENDING |
| AC-M10-08 | Cross-tenant matrix for every §6 endpoint: 0 leaks | test output | PENDING |
| AC-M10-09 | `ai.sandbox_cpu_seconds` and `builder.build_minutes` events dedupe-safe; metering vs runner log variance ≤ 1 % | reconciliation output | PENDING |
| AC-M10-10 | Android debug artifact builds in CI from generated Flutter template | CI log | PENDING |
| AC-M10-11 | Android **release** artifact signed with owner-authorized credentials; signature verified | verification output | BLOCKED-until-evidence (HG-10-01) |
| AC-M10-12 | iOS artifact built and signed on macOS capacity | build log | BLOCKED-until-evidence (D-22, HG-10-01) |
| AC-M10-13 | Signing material absent from all logs, artifacts, sandboxes (log/artifact scan 0 hits) | scan output | PENDING |
| AC-M10-14 | Copy lint: 0 UI/doc strings promising store approval or review bypass | lint output | PENDING |
| AC-M10-15 | All §8 screens: AR-RTL + EN screenshots, 4 states each, axe check 0 critical violations | screenshots, report | PENDING |
| AC-M10-16 | No generated-app dependency outside allow-list or with high vulnerability reaches deploy | policy test output | PENDING |
| AC-M10-17 | Written assessment of Apple/Google in-app-purchase and external-checkout policies for any digital goods sold in generated mobile apps or Nuzm's own app; no checkout flow shipped before the assessment is approved | document + legal sign-off | BLOCKED-until-evidence (legal; add as HG before S50) |

## 14. Handoff
→ M11: workflows may call `/v1/ai/runs` and deployments as actions; marketplace may list app/template projects (project versions as listing artifacts). → M12: sandbox fleet in load/chaos/pen-test scope; escape suite re-run in M12; store-release rows listed in GA readiness checklist. Open: D-21, D-22, SCR-M10-01, PROPOSED-HG-10-03, retention D-34.

## 15. Compliance hooks checklist
- [ ] Region on sandbox, artifact, export, deployment records; residency evaluation logged
- [ ] Model/provider selection obeys D-18 residency; no customer content to non-approved models
- [ ] Prompts/outputs/logs classified; retention set (D-34); legal-hold aware deletion
- [ ] Synthetic data only in tests; PII scanner on exports
- [ ] Audit events (§9) emitted and queryable via `/v1/audit-logs`
- [ ] DSR export/erasure covers projects, runs, artifacts

## Completion instruction
Do not mark this milestone DONE until every acceptance row is evidenced. Mark missing external approvals, accounts, macOS capacity, security reviews, or independent-test authorship as BLOCKED rather than simulating success. The agent must not mark any HG/D item GRANTED/decided; only the owner records evidence. M10B must not begin before the signed M10A Gate Review.
