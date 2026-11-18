# M10A — assumed M09 interfaces (and other upstream assumptions)

Status: data for the integrator. Written by the M10A session on branch `claude/m10a-app-builder-7cee56` (base `676df74`: M01–M08, **no M09**). Owner-directed exception: M10A was built before M09 although M10 hard-depends on it. At the time of writing `docs/reports/M09-interface-contract.md` did not exist on `claude/m09-ai-builder-*`; the M09 prompt (`docs/milestones/M09_ai_core_website_builder.md`) was the only source. **Everything below is an ASSUMPTION; model quality is NOT VERIFIED.**

**The one wiring change:** `M09_PORT_PROVIDERS` in `apps/api/src/modules/appbuilder/appbuilder.module.ts`. Five abstract classes in `internal/ports/m09.ts` are the whole boundary; their in-memory stand-ins (`m09-mock.ts`, `isMock = true`) make the app builder answer 404 in production. Delete `m09-stubs.controller.ts` on integration.

| # | Assumption | What M10A did | Integration step |
|---|---|---|---|
| A-01 | `ai.runs` is the single run table with states `queued→running→waiting_approval→succeeded|failed|cancelled|budget_exceeded` | `RunStorePort` (create/get/list/transition/addUsage/listAll); M10 tables hold `run_id` as a LOGICAL reference (no FK) | implement `RunStorePort` over `ai.runs` |
| A-02 | `builder.projects`, `project_files`, `project_versions` (text files, head version, optimistic commit) | `ProjectsPort`; M10 tables reference `project_id`/`version_id` logically | implement over the M09 tables |
| A-03 | model gateway with routing, residency, budget reservation; price per 1k tokens | `ModelGatewayPort.complete/rateMinorPer1kTokens`; M10 adds its own run-level `BudgetLedger` in front | implement over the gateway |
| A-04 | `ai.artifacts` stores agent outputs (kinds app_spec/openapi/test_report/sbom to be added) | `ArtifactStorePort.put/get` | implement; add the four kinds |
| A-05 | `deploy.deployments/deployment_logs/builds` (M09) will be extended with `target_type,target_id,health_check,rollback_of` | M10 keeps WEB-APP deployments in `deploy.app_deployments` + append-only `app_deployment_logs` (migration 1440). `/v1/deployments` for web apps is implemented by `AppDeploymentService`; M09 owns the path and must dispatch by project type | either keep both tables or fold into the M09 table |
| A-06 | M06 hosting site / M05 compute instance are the deploy targets | `DeployTargetPort`; only `DevStaticTarget` (in-memory) exists | implement over `HostingAdapter` deploy path and M05 compute |
| A-07 | M08 bucket stores release/export archives | `ReleaseStorePort` (memory, HMAC signed URL, ≤15 min) | implement over M08 storage |
| A-08 | a health probe the control plane may call | `HttpHealthProbe` (refuses non-public addresses) — NOT VERIFIED live | none |
| A-09 | approvals are a table + `POST /v1/ai/runs/{id}/approvals` | M10 owns `ai.approval_requests` (hash-bound, 24 h); the run-approval route is a stand-in; the inbox + `POST /v1/ai/approvals/{id}/decisions` is **PROPOSED PA-M10-02** (not in docs/04) | reconcile with M09's approval storage |
| A-10 | `GET/PUT /v1/ai/budgets`, credits | `OrgBudgetPort.remainingMinor`; `GET /v1/ai/budgets` stand-in is read-only | M09 owns PUT |
| A-11 | `/events` is SSE with `Last-Event-ID` | polling JSON stand-in | M09 SSE |
| A-12 | `POST …/changes` takes website ops (M09) | M10 implements the webapp/mobile `patches[]` half (`ChangeService`); M09 must dispatch by `projects.type` | dispatch |
| A-13 | permission names | `ai:run|read|approve|budget`, `builder:read|write|test|export|git`, `sandbox:use`, `deploy:read|create|rollback`, `admin:ai:read` seeded with `ON CONFLICT DO NOTHING` | union with M09's catalogue |
| A-14 | schemas `ai`, `builder`, `deploy` created by M09 | M10 migrations use `CREATE SCHEMA IF NOT EXISTS`; none of M09's tables is created or altered | none |
| A-15 | error codes | 13 codes appended to `ERROR_REGISTRY`/`errors.yaml` (`stale_approval_hash`, `budget_required`, `run_budget_exceeded`, `sandbox_quota_exceeded`, `sandbox_no_capacity`, `base_mismatch`, `change_rejected`, `test_suite_unavailable`, `health_gate_failed`, `export_blocked`, `dependency_blocked`, `egress_denied`, `ticket_invalid`); M09's `budget_required` meaning (402) is assumed identical | grep for duplicates |
| A-16 | run kinds `webapp`/`test-fix` activate in M10 | `AppRunService` handles them; `mobile` answers 422 until M10B | register handlers with M09's engine |
| A-17 | meters `ai.sandbox_cpu_seconds`, `builder.build_minutes` exist | seeded in migration 0201; emitted through `emitUsage` with deterministic ids | none |
| A-18 | feature flags | `app_builder.enabled` (default OFF); `app_builder.m09_stubs` (dev only, never in production) | remove the second on integration |

## Integration risk found while building (not an assumption)
`main` contains migration ordinal **1700** (identity credentials, range M12). The migration runner is forward-only, so a database that already applied 1700 refuses M09/M10/M11 migrations (1200–1699). Fresh databases are fine. Renumber 1700 or relax the check before integrating on a populated database.

## Endpoints not in docs/04 (proposed, need the owner)
PA-M10-01 terminal ticket route + WebSocket transport (services exist and are tested; no HTTP route, no `ws` dependency added). PA-M10-02 approvals inbox/decision routes. SCR-M10-01 Git sub-paths: see `docs/spec-change-requests/SCR-M10-01-git-paths.md`; **no Git HTTP code exists**.
