# AI Intelligence Center — Repository Audit and Integration Plan (Milestone 1)

Date: 2026-11-20 · Audited tree: branch `claude/run-it-dc3d6a` at `a5d373b` (M01–M12 and AI Studio merged) · Author: implementing agent ·
Status: **evidence and proposal, not a decision.** No product code, migration, spec path or table has been written for this request.

Request: the "Nozom AI Builder — Intelligent Project & Theme Knowledge Engine" master prompt (admin-controlled library of projects, themes,
components and documentation that drives generation; secure ingestion; project/theme/Flutter intelligence; hybrid retrieval; template
recommendation; orchestrator; customer experience; analytics).

## 0. Headline
- **Roughly a third of the platform plumbing already exists and must be reused**: model gateway with budgets/credits/residency/secret scan,
  untrusted-content defences, durable operations + worker, per-project builds and sandboxes (boundary only), an internal Git, the AI Studio
  GitHub integration (fake adapter until HG-AS-01), a third-party Skills catalog with scanning and two-approver governance, and a staff
  console with `admin:ai:*` permissions.
- **What is genuinely absent**: any library of uploaded source projects/themes; archive ingestion; code analysis (AST, manifests, component
  registry); design-token extraction; vector or symbol search; a recommendation engine; an agent that edits an existing source tree.
  Generation today is *spec → deterministic scaffold* (`appbuilder/internal/gen/project.ts` over `apps/api/templates/webapp-runtime`;
  Flutter over `apps/api/templates/flutter-core`), never "copy a stored project and modify it".
- **Several acceptance criteria cannot be met now by design, not by effort**: no isolated sandbox runtime (D-21 open), so installing,
  building, testing or previewing *uploaded* source is not permitted; no real model provider contract (HG-09-01, D-18), so semantic
  embeddings and live code generation are blocked; no malware scanner; no platform object store. Per CLAUDE.md §5–6 these stay
  `BLOCKED` and are never turned into `PASS` with mocks.
- Recommendation: build the **deterministic half first** (library, secure ingestion without execution, analyzers, manifests, metadata and
  lexical/symbol retrieval, recommendation, admin console), behind feature flags, and keep every execution/embedding/live-model step
  behind its human gate.

## 1. Governance that applies (CLAUDE.md §2 precedence)
1. Accepted ADRs / owner decisions → 2. `spec/` (OpenAPI, `spec/db/ownership.yaml`) → 3. PRD/architecture → 4. this prompt → 5. code.

The prompt conflicts with higher sources in the following places. Each is recorded here; the higher source is followed.

| # | Prompt says | Higher source says | Resolution |
|---|---|---|---|
| C1 | Endpoints `/admin/ai-resources/...`, `/ai-builder/...` | `docs/04` conventions (`/v1/...`, camelCase JSON, error registry); "prompts must not rename endpoints"; new public contracts need a spec change with owner approval | Draft the OpenAPI delta first (S-K1); names adapted to `/v1/admin/...` and `/v1/builder/...`; owner approves before code |
| C2 | Tables `ai_resource_*` | Schema-per-module, no cross-schema FK (ADR-004); every table in `spec/db/ownership.yaml` with data classes | New module `knowledge` with its own schema (proposed ADR-065); table names `knowledge.resources`, `knowledge.resource_versions`, … |
| C3 | "BullMQ with Redis if no suitable queue" | ADR-007: durable work is `platform.operations` + outbox, claimed by the worker; no BullMQ queues exist | Use `platform.operations` job kinds; Redis is not introduced |
| C4 | pgvector "if available" | No `vector` anywhere in `packages/db` or `spec`; production Postgres is a provider-managed service (ADR-050) whose extensions are unknown | Treat as unsupported until a capability probe says otherwise (CLAUDE.md §4 "unknown = unsupported"). Ship lexical + metadata + symbol retrieval first |
| C5 | Run installs/builds/tests/previews of uploaded code in a sandbox | ADR-015 / D-21 **open**; only `mock` and `local-dev` runtimes exist (`isolation: 'none'`, refuses outside dev) | No execution of uploaded code anywhere until D-21 is decided and an `isolated` runtime passes the escape suite |
| C6 | Coding agent with file/search/edit/run tools, built on "the existing Claude integration" | `ModelAdapter` contract has `chat`, `structured-output`, `long-context`, `embeddings`, `vision` only — no tool use; live Anthropic use needs HG-09-01 / D-18; hosted Claude Code is D-38 (counsel) | Extend the adapter contract (ADR + spec) for tool use; the engine uses the metered gateway, never the Claude Code binary or a customer subscription. **Resolved 2026-11-22 (D-46 decided): ADR-066 and SCR-K-10 define a staged, provider-neutral engine; read-only tools first; execution tools stay blocked on D-21; nothing implemented yet** |
| C7 | GitHub import of private repos via GitHub App/OAuth | D-39 decided (Nuzm-owned GitHub App, minimum permissions); HG-AS-01 (App registration, vault refs) pending | Reuse `GitHostAdapter` (`appbuilder/internal/studio/git-host.ts`); real imports BLOCKED until HG-AS-01; fake adapter for tests |
| C8 | "Malware scanning" | Only a pattern scanner exists (`marketplace/internal/scan.ts`) — it is not an antivirus | Do not claim malware scanning. Pattern scan + secret scan + executable/binary policy now; an AV engine is an owner decision |
| C9 | Figma references "where authorized integration is available" | No Figma product integration in the repo | Out of scope until an owner decision; screenshots/images accepted as references |

## 2. Findings per audit area (what exists, where, and its state)

### 2.1 Admin dashboard (`apps/admin`)
Next.js console, routes under `apps/admin/app/[locale]/(console)/`: `ai`, `sandboxes`, `marketplace`, `feature-flags`, `providers`, `audit-logs`,
`data`, `operations`, … Customer console at `apps/web/app/[locale]/(console)/builder`. Permission model: `@RequirePlatformPermission('admin:ai:read'|'admin:ai:manage')`
(example `appbuilder/admin-skills.controller.ts`). The AI Intelligence Center fits as a new section under the existing admin layout and `@nuzm/ui`;
it needs its own permissions (proposed `admin:ai_knowledge:read|manage|publish`), Arabic + English, RTL, e2e and screenshots (CLAUDE.md §4).

### 2.2 AI Builder architecture
- Website builder: `packages/domain/src/builder/*` (site model, 8 templates), `apps/api/src/modules/builder`.
- Web-app builder: `apps/api/src/modules/appbuilder` — agent graph (`internal/graph`, `agents/webapp-agents.ts`), generation (`internal/gen`),
  approvals, changes, internal Git, dependency/egress policy, tests, exports, deploy, live preview (ADR-063).
- Mobile (Flutter): `apps/api/src/modules/mobile` with `internal/flutter/{analysis,spec,templates,toolchain}.ts`; iOS BLOCKED (D-22).
- **Generation flow today**: prompt → `ai.sessions/runs` → agent graph produces an **app spec** → deterministic scaffold + SQL/OpenAPI/RBAC/tests
  generators → `builder.project_files` / `project_versions`. The model never edits an arbitrary existing source tree.

### 2.3 Coding agent, providers, gateway
`packages/adapters/model` (types, conformance, mock, Anthropic); `apps/api/src/modules/ai/internal` (gateway, routing, budget, credits, session, run,
evaluation). Gateway order: residency verdict → data-terms rule → ranking → budget reservation → call. Untrusted-content defences, secret scanner with
canaries, SSRF guard, moderation hook live in `packages/domain/src/ai/{untrusted,secret-scan,ssrf,moderation}.ts` — **reusable as-is** for ingested
documentation and README content (prompt-injection requirement in §12 of the prompt). Embeddings exist as a capability flag only.

### 2.4 GitHub
AI Studio (ADR-064) added `studio/{git-host,github.service}.ts`, controllers `studio-github`, `studio-project-github`, webhook controller; adapter is
`github-app` or `fake`; App registration is HG-AS-01 (pending). Installation tokens are minted per operation and never stored — satisfies the prompt's
"no pasted tokens" rule. Customer repositories reach `builder.project_files` through this path; the library must never ingest them (see §6).

### 2.5 Database and ORM
Raw `pg`, SQL-first forward-only migrations in `packages/db/migrations/<schema>/NNNN__name.sql` with `.down.sql` notes; schema-per-module with forced RLS;
`spec/db/ownership.yaml` is the ownership/data-class manifest and is enforced by `pnpm compliance:classification-coverage`. No ORM. No `vector` type.

### 2.6 Storage
- `ai.artifacts` stores run artifacts **in Postgres** (`ArtifactStorePort` → `ai.artifacts`; in-memory in tests). Not suitable for archives of tens or
  hundreds of MB.
- `data` module offers customer-facing object-storage buckets through `ObjectStorageAdapter` with a provider chosen per ADR-052 (selection pending).
  There is **no platform-owned object store port** for internal artifacts. Needed for original archives, extracted snapshots, previews, signed URLs.

### 2.7 Background processing
ADR-007: `platform.operations` + outbox; worker (`apps/worker/src/{main,loop,*-consumers}.ts`) claims durable operations; retries, timeouts and cancellation
patterns exist per consumer. No BullMQ/Redis queue consumers. Extend with `knowledge.*` operation kinds; concurrency/quotas follow existing consumers.

### 2.8 Preview and deployment
Live preview is origin-isolated (ADR-060/063) but only for *generated web apps*; deployments go through `deploy.*` with human approvals. Previewing an
*uploaded theme or project* needs the isolated runtime (C5): BLOCKED. Static theme screenshots uploaded by the admin are the only preview that is safe now.

### 2.9 Authentication, authorization, tenancy
Verified auth derives `org_id`; every tenant table carries `org_id` + RLS; staff routes use platform permissions. The library is **global (platform-owned)**
by default, which is unusual here: rows with `org_id IS NULL` need RLS policies that expose them read-only to customers *only when explicitly published*
and eligible (permissions + licence). Customer-private templates and imports stay tenant rows. Needs ADR-065.

### 2.10 Compliance hooks and metering
`ResidencyPolicyService` must run before any source or text is sent to a model/embedding vendor; resources need `data_region` and a per-resource
"AI processing allowed" permission mapped to the gateway's data classes. Every billable AI step emits a metering event through the central pipeline
(ADR-013) — analysis and embedding costs included. Audit event for every mutation.

### 2.11 Overlap with ADR-064 AI Studio (to avoid two systems)
| ADR-064 piece | Relation to this request |
|---|---|
| Skills catalog (sources, pinned SHA, scanner, two approvers, `admin:ai:manage`) | Same governance model as third-party library resources; **reuse** the approval and scanning workflow, not a second one |
| Project instructions (`CLAUDE.md` engine) | Becomes one input of context assembly (§10.3 of the prompt); keep the layer rules (stricter wins) |
| Instructions/Skills untrusted-content rules | Apply unchanged to retrieved documentation (`reference` content never overrides system rules) |
| GitHub App + `GitHostAdapter` | The only repository import path |
| Claude Code PoC | Unrelated to this engine; not a dependency |

## 3. Request vs. reality (legend: R reusable · E enhance · P partial · M missing · B blocked)
| Prompt area | Class | Note |
|---|---|---|
| Admin console section, overview, filters | M (R: shell, ui kit, `admin:ai:*`) | |
| Upload (ZIP/files/GitHub, resumable, cancel) | M · B (object store) | resumable large uploads need a platform object store; GitHub import needs HG-AS-01 |
| Secure ingestion: validation, safe extraction, limits, traversal/symlink/zip-bomb, secret/dependency/licence scan | M (R: secret-scan, marketplace scan patterns, dependency policy) | all implementable **without executing anything** |
| Malware scanning | M · B | no AV; owner decision (C8) |
| Framework detection / manifests / structural analysis | M | deterministic parsers; TypeScript/JS via compiler API, Dart via a bundled parser decision (§7) |
| AST analysis for Flutter | P (R: `mobile/internal/flutter/analysis.ts` for generated apps) | must handle untrusted foreign Dart without running `dart`/`flutter`; likely tree-sitter (decision) |
| Theme Design DNA / tokens | M | static CSS/Tailwind/theme-file analysis is safe; visual preview B |
| Component registry, reuse engine | M | |
| Hybrid retrieval: metadata, lexical, symbol | M | Postgres `tsvector` + trigram, no new service |
| Semantic embeddings | M · B (D-18, HG-09-01, ext. availability C4) | |
| Visual search | M · B | out of first slices |
| Template recommendation (weighted, hard filters) | M | deterministic; weights as config, not proven (agreed in the prompt) |
| Orchestrator + coding agent on a copied workspace | M · B (C5, C6) | workspace copy and diff application can be built and unit-tested without a model |
| Build/repair loop, visual validation, previews | B | D-21 |
| Customer experience (gallery, start-from-template, import, modes) | P (R: `/builder/new`, chat) | flag-gated |
| Quality scoring, analytics, continuous improvement | P (R: `ai.evaluation`, metering) | scores must come from real evidence; rows without evidence stay `NOT VERIFIED` |
| Multi-tenancy, signed URLs, retention | E | new RLS shape for global-published rows |

## 4. Integration plan (deliverables 2–10 of the prompt's §26, condensed)

**Architecture.** One new modular-monolith module `apps/api/src/modules/knowledge` (+ pure libraries in `packages/domain/src/knowledge`, adapters in
`packages/adapters/*` only where a vendor is touched) with its own Postgres schema, worker consumers `apps/worker/src/knowledge-consumers.ts`, admin UI
`apps/admin/.../ai-knowledge`, customer UI in the existing `/builder/new` flow. No new microservices; module boundaries by public `index.ts`.

**Database (proposed, all in ownership.yaml with data classes, RLS forced).** `knowledge.resources` (identity, type, framework tags, visibility,
`org_id` nullable = global, `data_region`), `resource_versions` (immutable, checksum, provenance, state machine), `resource_files` (path, sha256, size,
language, binary flag; content in object store, not Postgres), `resource_permissions` (reuse/AI-use/starter eligibility, licence verdict),
`resource_manifests` (versioned JSON + evidence + confidence), `resource_components`, `resource_dependencies`, `resource_relationships` (edges),
`resource_search_documents` (tsvector + trigram; embedding column added only if C4 probe says supported), `processing_jobs`, `analysis_results`,
`quality_scores` (with evidence refs), `usage_events`, `theme_tokens`, `theme_variants`, `template_defaults`, `generation_resource_links`,
`generation_plans`, `generation_evaluations`. Forward-only migrations, documented reversal, expand/contract. Soft delete + retention fields.

**API.** OpenAPI delta first, SDK regenerated, `pnpm spec:lint` / `spec:drift` / `sdk:check` green. Admin: uploads (init/part/complete/cancel), GitHub import,
list/get/patch, analyze, reindex, activate/disable/archive, components, versions, jobs, analytics, settings. Customer: templates list/get, recommend,
projects from-template / import, generation plan / execute. `Idempotency-Key` on side-effecting POSTs, cursor pagination, rate limits, audit, RBAC.

**Workers.** Operation kinds: `knowledge.validate`, `extract`, `detect`, `analyze`, `components`, `design`, `document`, `index`, `quality`, `preview`
(`embed` later). Per-job timeout, bounded retries, cancel, dead-letter state, progress rows, concurrency caps per org and global.

**Security design.** Ingestion is a state machine `UPLOADING → QUARANTINED → VALIDATING → ANALYZING → INDEXING → AWAITING_REVIEW → ACTIVE`; code only ever
read as bytes/text by pure functions inside the worker (no `child_process`, no package-manager invocation, no lifecycle scripts). Limits: entries,
extracted bytes, ratio, depth, path length; reject absolute/`..`/NUL/Unicode-confusable paths, symlinks, hardlinks, devices; secret scan with redaction
before anything is shown or sent; licence classifier with "unknown ⇒ not activatable"; executable/binary policy; dependency manifest checks reusing the
dependency policy. Two-approver rule for activation of third-party/licensed resources (mirrors D-40). Signed, short-lived download URLs. Resources
default to "AI processing not allowed" until the admin sets it and the residency/data-terms check passes.

**AI orchestration changes.** Add a `knowledge` port to the existing run engine: requirement analysis → classification → retrieval → recommendation →
plan (structured output, stored in `generation_plans`) → workspace initialisation (copy of an immutable version into `builder.project_files`, never
mutating the source) → changes through the existing approval/changes machinery → validation hooks (static now; build/test when D-21 lands). Context
assembly with token budgets and on-demand file fetch. Retrieved content is wrapped by the existing untrusted-content fences; it carries a lower
priority than system, admin and customer instructions.

**Frontend.** Admin: Overview, Libraries (projects/themes/components/docs), GitHub sources, Processing jobs, Analytics, Quality, Settings, resource detail
with the twelve prompt sections. Customer: template gallery, start-with-AI / from-template / import, adaptation mode (default Adaptive), RTL/LTR.
Every screen: Arabic + English, keyboard accessible, loading/empty/error/forbidden states, e2e + screenshot, feature flag default off.

**Test strategy.** Unit (pure analyzers with fixture repos), property tests for archive safety (traversal, bomb, symlink), integration with RLS and
cross-tenant tests for every query path, contract tests from OpenAPI, worker retry/timeout/cancel tests, recommendation golden sets, e2e for admin upload →
active → customer recommendation using fixtures (no model). Scenarios A–G of the prompt are tracked as acceptance rows; those needing execution or a live
model are `BLOCKED`, not `PASS`.

## 5. Proposed implementation sequence (slices)
| Slice | Content | Can start now? |
|---|---|---|
| S-K0 | Owner decisions of §7, ADR-065 (module, schema, global-visibility RLS, object store port), OpenAPI/ownership delta | Yes — docs only |
| S-K1 | Migrations, platform object-store port (dev filesystem adapter; provider adapter after selection), upload API (resumable), versioning, admin library list/detail shell, permissions | After S-K0 approval |
| S-K2 | Ingestion state machine and safe extraction, limits, secret/licence/dependency scans, job monitor UI, audit | Yes (no execution) |
| S-K3 | Project intelligence: framework registry, manifests with evidence/confidence, architecture graph tables, component discovery (TS/JS first) | Yes |
| S-K4 | Theme Design DNA from static analysis; Flutter analysis with a parser decision; screenshot references | Yes (previews B) |
| S-K5 | Retrieval: metadata + lexical + symbol, permission-aware, ranked output; recommendation engine with hard filters and configurable weights | Yes |
| S-K6 | Orchestration: plan, context assembly, workspace copy/diff, integration with run engine; coding agent only via a tool-use adapter extension | **DONE as single-call adaptation (`81caed9`)**; the coding agent is the Agentic Coding Engine below (D-46 decided 2026-11-22) |
| S-K7 | Customer experience (gallery, start-from-template, import, adaptation modes, chat on current state) | After S-K5/6 |
| S-K8 | Quality evidence, analytics, cost; build/visual validation | Static yes; build/visual B (D-21) |
| S-K9 | Hardening: security, tenant isolation, performance, recovery, runbooks | After the above |

### 5b. Agentic Coding Engine slices (D-46, ADR-066, SCR-K-10) — all NOT STARTED
| Slice | Content | Can start now? |
|---|---|---|
| S-AG0 | S-K6 single-call adaptation preserved as the fallback | Done (`81caed9`) |
| S-AG1 | `ModelAdapter` v1.1 contract, negotiation, conformance kit, scripted mock | **DONE 2026-11-22** (`docs/reports/AG-S1-report.md`) |
| S-AG2 | Read-only tool registry and execution gateway (`read_file`, `list_files`, `search_code`, `inspect_project`), limits, audit, metering, isolation | **DONE 2026-11-22** (`docs/reports/AG-S2-report.md`) |
| S-AG3 | Agent loop: plan, explore, propose, static validation, apply on the AI branch, checkpoints, recovery, fallback; UI timeline | After S-AG1/2 |
| S-AG4 | OpenAI and Google adapters, Anthropic at 1.1, probes, capability matrix | **BLOCKED** (HG-09-01, D-18, credentials, provider selection) |
| S-AG5 | Golden tasks, benchmarks, thresholds, rollout gates, security review | After S-AG4 |
| S-AG6 | Execution Gateway and tools to run tests and builds | **BLOCKED** (D-21 and the escape suite) |
Production for all of them stays BLOCKED on D-42. Acceptance criteria AC-AG-01..12 are in SCR-K-10.

## 6. Isolation rules that must hold in every slice
1. Customer-imported repositories and customer-authored templates never enter the global library; no code path from `builder.*` to `knowledge.*` writes.
2. A customer sees a global resource only when it is `ACTIVE`, published, licence-eligible and permitted for reuse; private resource bytes are never
   returned by template/gallery APIs (metadata and preview assets only).
3. Original versions are immutable; generation always works on a copy; a customer's edits are never shared.
4. No uploaded source is executed, installed or built outside an `isolated` sandbox — until D-21 is accepted and the escape suite passes, nowhere.
5. No source or documentation text is sent to a model or embedding provider unless the resource permission, `ResidencyPolicyService`, the data terms
   (HG-09-01) and the budget all allow it.
6. No customer source is used to train or fine-tune anything.

## 7. Owner decisions needed (proposed defaults in italics)
| ID (proposed) | Decision | Why it matters |
|---|---|---|
| D-41 | Accept new module `knowledge` + schema and global-visibility RLS (ADR-065). *Yes.* | Public contracts and ownership manifest |
| D-42 | Platform object store for library artifacts: which provider/adapter, region, retention (ADR-052 follow-up). *Dev filesystem adapter now; provider later.* | Large archives, signed URLs, residency |
| D-43 | Licence policy for third-party themes/projects (most marketplace themes forbid redistribution or SaaS derivatives). *Unknown or restrictive ⇒ not activatable; counsel review before any commercial theme is used.* | Legal exposure |
| D-44 | Malware scanning: ClamAV-class engine run where, or none and say so. *Say so; pattern scan only.* | Security posture |
| D-45 | Dart/Flutter parsing of foreign code without running the SDK (tree-sitter vs regex heuristics). *tree-sitter, bundled, no execution.* | Analyzer accuracy |
| D-46 | Model adapter tool-use extension and the coding-agent tool set. *Spec change first; metered gateway only.* | Customer-visible behaviour and cost. **DECIDED 2026-11-22 (owner): staged, provider-neutral engine, read-only tools first, execution blocked on D-21 (ADR-066, SCR-K-10)** |
| D-47 | Embeddings: provider/model, residency, and whether Postgres `vector` exists on the managed service. *Defer; lexical + symbol first.* | Semantic search |
| D-48 | Default ranking weights (25/20/20/15/10/10) accepted as initial config only. *Yes, editable, evaluated.* | Recommendation quality |
| D-49 | Per-resource "AI processing permitted" defaults and who may change them. *Off by default; platform admins with `publish`.* | Data governance |

Existing open items this work depends on: D-18, D-21, HG-09-01, HG-AS-01 (GitHub App registration), PA-M10-01.

## 8. Risks
- **Licence contamination** of generated customer apps from copied third-party themes (highest legal risk; D-43).
- **Parser attack surface**: analyzers run on hostile input in the worker process; run them with limits and timeouts and fuzz them; never `eval`.
- **Scope**: the prompt describes many quarters of work; slicing above avoids a half-built, unverifiable surface.
- **Honest scoring**: quality and "generation success rate" analytics are empty until real builds run (D-21); dashboards must show "no data", not guesses.
- **Cost**: indexing large repositories with a model is expensive; deterministic-first, content-hash caching, and token budgets are requirements of S-K3+.

## 9. Acceptance rows (current status per CLAUDE.md §6)
| Prompt criterion | Status |
|---|---|
| 1 Admin can upload and manage real source projects | NOT STARTED (S-K1) |
| 2 Uploads securely validated | NOT STARTED (S-K2); malware scan BLOCKED (D-44) |
| 3–5 Auto analysis; theme DNA; Flutter/full-stack recognition | NOT STARTED (S-K3/4) |
| 6–7 Indexing, retrieval, eligible starter selection | NOT STARTED (S-K5); semantic BLOCKED (D-47) |
| 8 AI modifies actual project source | BLOCKED (D-46, HG-09-01, D-18) |
| 9–10 Originals unchanged, customers isolated | Design in §6; NOT STARTED |
| 11 Generated projects pass validation pipeline | BLOCKED (D-21) |
| 12 Preview and continue editing | Existing builder for spec-generated apps: PASS (pre-existing); for template-based: BLOCKED (D-21) |
| 13 GitHub workflows preserved | Pre-existing ADR-064 path; live NOT VERIFIED (HG-AS-01) |
| 14 Admin monitors processing, quality, usage | NOT STARTED |
| 15 Existing AI Builder remains operational | Guarded by feature flags and the existing test suites |
