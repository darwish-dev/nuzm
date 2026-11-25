# P3-S05 — Full-Stack Web Application Generation

Branch `feature/p3-s05-fullstack` · worktree `.claude/worktrees/p3-s05` · Postgres 54355 · migrations 2340–2349. Read first: `CLAUDE.md`, `docs/phase3/PHASE-3-PLAN.md`, `apps/api/templates/webapp-runtime/**`, `apps/api/src/modules/appbuilder/internal/gen/**`, `docs/ai-intelligence/S-AG-builder-*.md`, ADR-063.

## Implementation prompt
You own generating a **real full-stack web application with authentication, APIs and PostgreSQL** and proving that it **runs**. Phase 2 generated app skeletons and verified them offline with mocks. Now the generated app must build, migrate a real PostgreSQL, start, and pass its own generated tests inside the qualified runtime (S02), with all tenant/secret rules preserved.
Deliver: (1) the full-stack template family (front end + API + migrations + seed + tests + Dockerless run recipe): email/password and session auth (hashed passwords, CSRF, rate limits), role model, CRUD APIs with validation and pagination, OpenAPI contract in the generated app, PostgreSQL migrations (forward-only), RLS-style tenant scoping for multi-tenant apps, environment handling by vault reference only; (2) **database provisioning for the app under test**: an ephemeral PostgreSQL inside the runtime's isolated network (per run, no shared DB, no platform credentials), later mapped to the managed-DB product for staging deployment (decision B-DB); (3) generated tests (unit, API, auth flow) that the loop runs and repairs (via S03); (4) static analysis gates on generated code: no secrets, no `eval`, dependency policy (lockfile, allowlist, audit), SQL injection patterns, auth checks present on every route; (5) run-and-probe harness: start the built app in the runtime, hit health/auth/API endpoints, record results; (6) generation for the existing product planners that map to web apps (CRM/ERP module, e-commerce frontend + API).
## Scope boundaries
In: webapp-runtime templates, webapp generation, DB provisioning for generated apps, generated tests. Out: loop internals (S03), runtime internals (S02), hosting of server code (S07).
## Acceptance criteria
- F1 **T2:** from a synthetic brief ("small CRM with login, customers CRUD, PostgreSQL"), the real model + real runtime produce an app that builds, migrates a real PostgreSQL, starts, and passes: signup/login/logout, an authenticated CRUD API test, an unauthenticated-access rejection test, a cross-user isolation test; evidence record with all results.
- F2 Generated code passes the static gates (no secrets, dependency policy, every route guarded); failures trigger repair rounds that succeed within limits.
- F3 The ephemeral database is isolated: no platform credentials in the app environment (checked), the DB is destroyed with the workspace (checked), no network path to platform DBs (runtime profile).
- F4 Migrations are forward-only and re-runnable; seeds contain synthetic data only.
- F5 Offline path unchanged: Phase 2 generated-app, webapp-pipeline suites green.
## Dependencies
Needs: S03 (loop), S02 (real runtime with PostgreSQL available inside the sandbox network), S01 (model); S07 for staging deployment of server code (owner decision B-DB and an isolated runtime target, not a shared hosting panel).
## Human gates
Runtime/provider approvals (S01/S02), staging DB hosting (B-DB), server-app deploy target (S07).
## First tasks
Merge `integration/phase3`; build the template family and the generated-test suites runnable on a developer machine **only for the template's own unit tests** (no generated-app execution on the host); static gate runner; the run-and-probe harness against the simulated runtime; `REPORT-P3-S05.md`.
