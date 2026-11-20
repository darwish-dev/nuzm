# AI Studio — Feature Gap Analysis

Classes: **R** existing & reusable · **E** existing, needs enhancement · **P** partial · **M** missing · **B** blocked by provider
or owner authorization. "Spec": whether `spec/openapi/openapi.yaml` / `spec/db/ownership.yaml` already cover it.

| # | Feature | Class | Spec | Blocker(s) | Next action |
|---|---|---|---|---|---|
| 1 | Project creation | R | yes | — | add "Blank / Template / GitHub import" choice after #10 |
| 2 | Website templates | R | yes | — | attach default Skills + instruction layer (#11, #14) |
| 3 | App/industry templates | E | partly | D-21 for dependency install | template manifest gains `skills`, `instructions` |
| 4 | AI chat / runs / budgets (Mode B) | R · B | yes | HG-09-01, D-18, HG-04-01 | none until providers attested |
| 5 | Sandbox lifecycle | P · B | yes | D-21, HG-10-02, HG-05-04 | isolating `SandboxRuntime` implementation |
| 6 | File manager | E | partly | — | spec change: rename/move/copy/upload/search/history ops |
| 7 | Browser IDE | R (non-isolated) | yes | D-21 for production | — |
| 8 | Terminal | P · B | partly | PA-M10-01 | owner approval exposes the route |
| 9 | Internal Git | R | yes | — | — |
| 10 | **GitHub App** | **M** | **no** | D-37, D-39 | ADR-064 → spec → `GitHostAdapter` |
| 11 | **Skills registry** | **M** | **no** | D-37, D-40 | core libs now; tables/API after approval |
| 12 | **Skills importer + scanner** | **M** | **no** | D-37, D-40 | scanner core now (static, no execution) |
| 13 | **Skills installer** | **M** | **no** | D-37, D-21 | resolver core now; writes `.claude/skills/` into sandbox later |
| 14 | **Instructions engine** | **M** | **no** | D-37 | composer core now; API/UI after approval |
| 15 | **Hosted Claude Code (Mode A)** | **M · B** | **no** | D-38 (legal), D-21 | only the "customer signs in to the unmodified binary in their own sandbox" shape is permissible per Anthropic docs |
| 16 | Static preview | R | yes | — | — |
| 17 | Dev-server preview | P · B | partly | D-21 | — |
| 18 | Quality engine | E | yes | D-21 for production runs | add SEO/a11y/secret checks to `test_runs` kinds |
| 19 | Deployments | E · B | yes | HG-05-01/02, HG-06-01 live | — |
| 20 | Android builds | E | yes | — | — |
| 21 | iOS builds | B | yes | D-22, HG-10-01 | — |
| 22 | SEO tools | R | yes | — | — |
| 23 | Admin AI/sandboxes/marketplace | R | yes | — | — |
| 24 | Admin Skills/GitHub/templates | M | no | D-37 | after #10–#14 |

## Conflicts between the request and the spec (CLAUDE.md §2: follow the spec, record the conflict)
| Request | Spec / code | Resolution |
|---|---|---|
| `/api/projects/:id/workspace…` | `/v1/builder/projects/{id}/sandboxes` | follow the spec |
| `project_workspaces`, `workspace_sessions` | `builder.sandboxes`; `tenancy.workspaces` already exists | "sandbox"; no new table |
| `ai_tasks`, states `PENDING…AWAITING_APPROVAL` | `ai.runs` single run table, states `queued → running → waiting_approval → succeeded|failed|cancelled|budget_exceeded` | follow the spec |
| `project_files_metadata`, `project_revisions` | `builder.project_files`, `builder.project_versions`, `builder.changes` | follow the spec |
| `quality_runs`, `preview_sessions`, `deployments` | `builder.test_runs`, `builder.previews`, `deploy.*` | follow the spec |
| GitHub, Skills, Instructions, Claude Code | absent | ADR-064 + D-37..D-40; no endpoint/table until approved |
