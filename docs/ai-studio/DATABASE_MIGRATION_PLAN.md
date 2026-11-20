# AI Studio — Database Migration Plan

No migration is added by S-00/S-A1. The `ai`, `builder`, `deploy` and `mobile` schemas already exist (M09–M10B, see
`spec/db/ownership.yaml`). This maps the request's conceptual entities onto those tables and lists what would be new.
All tables: `org_id`, forced RLS, `data_region` where region-bearing, no cross-schema FKs, forward-only SQL with a documented
`.down.sql` (ADR-005, docs/05 §2), ranges allocated in the ownership manifest before use.

## 1. Request entity → existing reservation
| Request entity | Use | Owner |
|---|---|---|
| projects | `builder.projects` (parent: `tenancy.workspaces` via `workspace_id`) | builder (M09) |
| project_workspaces, workspace_sessions | `builder.sandboxes` (session = sandbox lifetime; terminal tickets are short-lived, not stored) | builder (M10) |
| workspace_snapshots | Git checkpoints (tags) in `builder.git_repos` + `builder.project_versions` | builder |
| project_files_metadata | `builder.project_files` (single file store; content in object storage via `storage_ref`) | builder (M09) |
| project_revisions | `builder.project_versions`, `builder.changes` | builder (M09) |
| ai_tasks, ai_task_events | `ai.runs`, `ai.run_steps`, `ai.tool_calls`, SSE from run events | ai |
| ai_usage_records | `ai.model_usage` (append-only) | ai |
| ai_provider_configs | `ai.model_providers` (tenant-less, vault refs, human-attested data terms) | ai |
| quality_runs, quality_results | `builder.test_runs` | builder (M10) |
| preview_sessions | `builder.previews` | builder (M09) |
| deployment_targets, deployments, deployment_events | `deploy.deployments`, `deploy.builds`, `deploy.deployment_logs` (append-only), `deploy.hosting` | deploy |
| project_templates, template_versions | versioned package data `packages/domain/src/builder/templates` (8 built); a table only if the owner wants admin-editable templates | — |

## 2. New tables (only after D-37 / ADR-064 acceptance)
| Proposed table | Purpose | Notes |
|---|---|---|
| `builder.skills` | registry entry (slug, category, scope `global|framework|template|industry|customer`, approval state) | `org_id` NULL for platform skills → needs an RLS policy like other platform catalogs |
| `builder.skill_versions` | immutable version: `source_ref` (repo + commit SHA), `manifest jsonb`, `content_hash`, `storage_ref`, `license` | append-only |
| `builder.skill_reviews` | scanner findings + human decision (two-person rule for executable skills) | append-only |
| `builder.project_skills` | installed skill version per project, state, `installed_by`, customer-modified flag | |
| `builder.project_instructions` | layers + customer blocks; `builder.instruction_versions` history | |
| `builder.github_connections` | installation id, account login, granted permissions; **no tokens stored** (installation tokens minted per call, ≤1 h) | vault ref for the App private key is platform-level |
| `builder.github_repos` | link project ↔ repo (`repo_id`, default branch, last synced SHA) | |
| `builder.github_events` | webhook deliveries deduped by `X-GitHub-Delivery` | append-only |
| `builder.claude_code_sessions` | sandbox id, observed state only (`NOT_CONFIGURED…ERROR`), timestamps; **no Claude credentials ever** | only if D-38 allows |

Each new personal-data column must be classified (`pnpm compliance:classification-coverage`) and appear in the ROPA coverage
check; each mutation emits an audit event.
