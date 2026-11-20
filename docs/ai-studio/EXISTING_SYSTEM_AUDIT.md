# AI Studio — Existing System Audit (Sprint 00)

Date: 2026-11-20 · Audited tree: `main` at `cadfeb4` (M01–M12 merged) · Author: implementing agent · Status: evidence, not a decision.

**Headline.** The AI Builder exists and is large: M09 (AI core + website builder), M10A (full-stack app builder), M10B (Flutter
mobile builder), M11 (automation, marketplace) and M12 (hardening) are merged. None of their gate reviews is signed, and the
pieces that need real isolation, real providers or owner approval are deliberately stubbed or hidden. What is genuinely
**absent** from the request: a GitHub integration, a Skills system, a project-instructions (`CLAUDE.md`) engine, and a hosted
Claude Code experience. Everything else maps to existing code that should be extended, not rebuilt.

## 1. Governance that applies
- `CLAUDE.md` §2: accepted ADRs/owner decisions > `spec/` (OpenAPI, `spec/db/ownership.yaml`, milestones) > docs > milestone prompt
  > code. A prompt must not rename endpoints or tables; new public contracts need a spec change with owner approval.
- Gate reviews: M01, M02 signed. M03–M12 gate reviews exist and all say **PREPARED, NOT SIGNED**
  (`docs/reports/M0{3..9}-gate-review.md`, `M10-gate-review.md`, `M10A-gate-review.md`, `M11-gate-review.md`, `M12-gate-review.md`).
  M12's review explicitly "does not recommend launch".

## 2. Stack (verified)
| Area | Finding | Evidence |
|---|---|---|
| Monorepo | pnpm + Turborepo; apps `api`, `worker`, `web`, `admin`; packages incl. `adapters/*` (model, compute, registrars, data), `domain`, `ui`, `sdk` | `pnpm-workspace.yaml`, `ls packages packages/adapters` |
| API | NestJS (Fastify), raw `pg`; modules incl. `ai`, `builder`, `appbuilder`, `deploy`, `mobile`, `marketplace`, `automation`, `enterprise`, `ops` | `apps/api/src/modules/` |
| Consoles | Next.js; customer routes `/builder/{new,projects,apps,runs}`, `/ai/{usage,budgets}`, `/mobile`, `/marketplace`; admin `/ai`, `/sandboxes`, `/marketplace` | `apps/web/app/[locale]/(console)`, `apps/admin/app/[locale]/(console)` |
| DB | Postgres, schema-per-module + forced RLS; `builder.*` (projects, project_files, project_versions, changes, previews, git_repos, sandboxes, test_runs, app_specs, exports, forms, cms…), `ai.*`, `deploy.*`, `mobile.*` | `spec/db/ownership.yaml` |
| Durable work | `platform.operations` + outbox in Postgres, worker claims; no BullMQ/Redis queues | ADR-007, `apps/worker/src/main.ts` |
| Contracts | OpenAPI-first + generated SDK; 40 `/v1/ai`, `/v1/builder`, `/v1/deployments`, `/v1/mobile` paths | `spec/openapi/openapi.yaml` |

## 3. AI system as built (key files)
| Component | Where | State |
|---|---|---|
| Model adapter contract + conformance + mock + **Anthropic** adapter (API key) | `packages/adapters/model/src/{types,conformance,mock,anthropic}.ts` | built; live use needs HG-09-01 / D-18 |
| Provider admin, key probe (fixed host `api.anthropic.com`, no retries, no key echo) | `apps/api/src/modules/ai/internal/{provider.service,claude-probe}.ts`, admin `/ai` | built |
| Gateway, routing, budgets, credits, sessions, runs, evaluation | `apps/api/src/modules/ai/internal/{gateway,budget,session,run,evaluation}.service.ts`; `packages/domain/src/ai/{routing,credits}.ts` | built |
| Untrusted-content defences (data fences, injection heuristic, tool allow-list), secret scanner with canaries, SSRF guard, moderation hook | `packages/domain/src/ai/{untrusted,secret-scan,ssrf,moderation}.ts` | built, reusable |
| Website builder: site model, renderer, 8 templates, editor ops, versions, previews, SEO, forms, CMS | `packages/domain/src/builder/*`, `apps/api/src/modules/builder/internal/*` | built |
| App builder: agent graph, generation, approvals, changes, internal Git, dependency policy, egress policy, tests, exports, deploy | `apps/api/src/modules/appbuilder/internal/{graph,agents,gen,approvals,changes,git,policy,tests,export,deploy}` | built |
| **Sandbox runtime boundary** | `appbuilder/internal/sandbox/runtime.ts`: `mock` (no process) and `local-dev` (child processes, `isolation: 'none'`, refuses unless `SANDBOX_LOCAL_DEV=true` outside production); `isolated` reserved for a D-21 runtime that does not exist | built boundary; **no isolating runtime** (D-21, HG-10-02) |
| Sandbox path validation, canaries, escape suite | `appbuilder/internal/sandbox/{paths,canary,escape-suite}.ts`, `tests/security/sandbox-escape/` | built |
| Terminal (WS + single-use tickets) | services in `sandbox.service.ts`; **route not exposed** ("PA-M10-01 needs the owner's approval") | hidden by design |
| Browser IDE | `/builder/projects/[id]/ide` | built (on the non-isolated runtime) |
| Mobile (Flutter) builds, signing refs, releases | `apps/api/src/modules/mobile/*` | built; iOS BLOCKED D-22 |
| Marketplace pattern scanner (secrets, malware signatures, dependency deny-list, PII, licence, SBOM) | `apps/api/src/modules/marketplace/internal/scan.ts` | built, reusable idea for Skills |

## 4. Request vs. reality
Legend: **R** reusable · **E** needs enhancement · **P** partial · **M** missing · **B** blocked by provider/owner authorization.

| Request item | Class | Evidence / note |
|---|---|---|
| Project creation (Describe → type → template) | R | `/builder/new`, `builder.projects`, `ai.sessions` |
| Templates (website) | R | `packages/domain/src/builder/templates` (8) |
| Templates (industry packs incl. Skills/instructions) | E | templates carry no Skills/instructions today |
| AI chat, runs, budgets (Mode B, managed API) | R · B | built; real provider use gated by HG-09-01/D-18 |
| Workspace engine (isolated) | P · B | runtime boundary + mock/local-dev only; D-21, HG-10-02 |
| File manager | E | `/v1/builder/projects/{id}/files` + IDE; lacks rename/move/upload/search per request |
| Internal Git | R | `appbuilder/internal/git/git.store.ts`, `builder.git_repos` |
| **GitHub App (import/push/PR)** | **M** | no code (only dependency-spec patterns mention `github:`) |
| **Skills registry / importer / scanner / installer** | **M** | no code |
| **Instructions engine (`CLAUDE.md`)** | **M** | no code |
| **Hosted Claude Code (Mode A)** | **M · B** | no code; Anthropic policy limits it (`INTEGRATION_RISKS.md` §1) |
| Terminal | P · B | built, hidden pending PA-M10-01 |
| Live preview | E | static previews (M09); dev-server preview needs an isolating runtime |
| Quality engine | E | `builder.test_runs`, `appbuilder/internal/tests` |
| Deployment | E · B | `deploy` module; live targets need HG-05/06 |
| Mobile builds | E · B | Android local; iOS BLOCKED D-22 |
| SEO tools | R | M09 SEO report |
| Admin control center | E | admin `/ai`, `/sandboxes`, `/marketplace`; no Skills/GitHub admin |

## 5. Naming hazard
"Workspace" already means a **tenancy** grouping (`tenancy.workspaces`, console `/workspaces`). The request's dev environment is
the existing **sandbox** (`builder.sandboxes`). New code must say "sandbox".
