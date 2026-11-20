# AI Studio — Current Architecture and Target Mapping

Architecture source of truth: `docs/02-system-architecture.md` and the ADRs. This maps the AI Studio request onto what is built.

## 1. Runtime as built
```
apps/web (customer)  ──/v1──►  apps/api (NestJS modular monolith)
apps/admin (staff)   ──/v1──►     ai        gateway · routing · budgets · credits · sessions · runs · evaluation · providers
                                  builder   website projects · files · versions · changes · previews · SEO · forms · CMS
                                  appbuilder agent graph · generation · approvals · git · dependency/egress policy · tests ·
                                            exports · sandboxes ─► SandboxRuntime { mock | local-dev (non-isolated) | isolated (D-21, absent) }
                                  deploy    deployments, builds, logs → HostingAdapter (M06) / compute (M05)
                                  mobile    Flutter builds, signing refs, releases
                                  marketplace, automation, …
                                     │ rows + outbox in one tx
                                     ▼
                           PostgreSQL (schema per module, forced RLS) ◄── apps/worker (operations, outbox, metering)
packages/adapters/model ── ModelAdapter { mock, anthropic (API key) }
```

## 2. Where each requested component lands
| Request component | Home | Action |
|---|---|---|
| Orchestrator, Mode B routing, usage | `ai` module (gateway, runs, budgets, `ai.model_usage`) | reuse |
| Workspace engine | `appbuilder` sandboxes + `SandboxRuntime` | reuse; add isolating runtime after D-21 |
| File manager / editor | `builder` files API + `/ide` | enhance (rename/move/upload/search/history) |
| Git working tree | `appbuilder/internal/git` | reuse |
| GitHub engine | new `GitHostAdapter` + `builder.github_*` | **new** (ADR-064, D-37, D-39) |
| Skills engine | new registry + admin; pure core in `packages/domain/src/ai-studio` | **new** (D-37, D-40); core built now |
| Instructions engine | new `builder.project_instructions`; pure composer in `packages/domain/src/ai-studio` | **new** (D-37); core built now |
| Templates engine | `packages/domain/src/builder/templates` | enhance: default Skills + instruction layer per template |
| Claude Code (Mode A) | a sandbox capability: unmodified binary, customer signs in | **new**, legally gated (D-38) |
| Quality engine | `builder.test_runs`, `appbuilder/internal/tests` | reuse/enhance |
| Live preview | `builder` previews (static) | reuse; dev-server preview after D-21 |
| Deployments, mobile | `deploy`, `mobile` | reuse |
| Admin | admin `/ai`, `/sandboxes`, `/marketplace` | add Skills/GitHub pages after D-37 |

## 3. New interfaces (proposed in ADR-064)
- `GitHostAdapter` — GitHub App per installation (short-lived installation tokens), later other hosts. Customer repos only.
- `SkillSource` — anonymous, read-only fetch of a pinned commit into quarantine. Never shares credentials with `GitHostAdapter`.
- Pure libraries (no I/O): skill manifest parser, skill scanner (built on `packages/domain/src/ai` secret/injection helpers),
  skill resolver, instruction composer — implemented in `packages/domain/src/ai-studio` now.
