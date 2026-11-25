# P3-S05 design: the database of a generated full-stack app

Status: **design + code SIMULATED** (code: `apps/api/src/modules/appbuilder/internal/gen/db-provisioning.ts`, `templates/webapp-runtime/probe/pg-sandbox.ts`). Nothing here has run against a real runtime node or a managed PostgreSQL. Decision B-DB (where the staging database runs) is the owner's; this design works for any answer.

## 1. Rule
A generated app gets **a database of its own and no credential of the platform**. Three places could break that rule; each has a check.

| Risk | Control | Where it is checked |
|---|---|---|
| the app's environment contains a platform secret, a platform DB host, or a variable it should not have | the app environment is an allowlist (`PORT, STORE, DATABASE_URL, SESSION_SECRET, NODE_ENV, NOTIFY_URL, NOTIFY_TOKEN`); secret-bearing values are vault references (managed) or generated inside the sandbox (probe); platform hosts and secret values are refused | `checkAppEnvironment` (unit tests, 8 refusal cases) and the probe's `isolation.inheritedEnvNames` |
| the app's database role can see another tenant's rows or other databases | the role is a **non-superuser, NOBYPASSRLS**, owns only its database; multi-tenant tables have `FORCE ROW LEVEL SECURITY` | SQL tests on a real PostgreSQL (`migrations-pg.spec.ts`), probe `isolation.roleSuperuser/roleBypassRls` |
| a database outlives its workspace | in-sandbox: data dir lives in the workspace and `stop()` removes it; managed: ledger + destroy-with-workspace + orphan sweeper | probe `isolation.databaseDestroyed`; `AppDatabaseProvisioner.destroyForWorkspace/sweep` tests |

## 2. Mode A: in-sandbox ephemeral PostgreSQL (the T2 proof)
`npm run probe` (platform-owned `probe/run.ts`) runs **inside the qualified runtime**:
1. `probe/pg-sandbox.ts`: `initdb` into `<workspace>/.run/pg-XXXX/data`, scram-sha-256, random admin and app passwords generated in the sandbox, `listen_addresses=127.0.0.1` on a free port, socket dir inside the workspace. Roles: `nuzm_admin` (only used to create the app role; password file deleted right after) and `app_owner` (LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS) that owns database `app`.
2. migrations applied (`src/migrate.ts`, one transaction per migration, ledger table), then applied again: the second run must apply **0**.
3. the app is started as production starts it (`node --experimental-strip-types src/server.ts`) with an **explicit minimal environment** (PATH, HOME, NODE_ENV, PORT, STORE, DATABASE_URL = the ephemeral URL, SESSION_SECRET = random); nothing is inherited from the runtime's environment.
4. the probe suite (`probe/suite.ts`) runs over HTTP; one `NUZM_PROBE_REPORT <json>` line is printed and `probe-report.json` written; exit code 0 only if every required check passed.
5. app killed, cluster stopped (`pg_ctl -m immediate`), directory removed, and the report says whether the directory is gone.

The platform sees **no password**. The platform side (`probe-runner.ts`) parses the report as untrusted data, recomputes every count and the verdict, screens for secrets, and labels the evidence from the runtime's *origin*, never from the report. `verifySandboxIsolation` requires: no platform env inherited, DB host 127.0.0.1, role not superuser, role does not bypass RLS, migrations applied, migrations re-run applies 0, database destroyed.

Needs from S02 (CONTRACT-P3-S05-1): PostgreSQL 16 server binaries (`initdb`, `pg_ctl`, `postgres`) in the rootfs image, runnable by the unprivileged sandbox user; a profile `app-probe` with network class `loopback-only`; the run's workspace destroyed on exit; `NUZM_PROBE_REPORT` allowed through output screening (the screen redacts secrets only; the report contains none, and the platform re-screens it).

## 3. Mode B: managed database for staging (B-DB)
`AppDatabaseProvisioner` over two ports (`ManagedDatabasePort`, `SecretVaultPort`); only `SimulatedManagedDatabase` exists (labelled SIMULATED).
- **Names** are derived from ids only (`app_<hash20>`), never from user text; unique per (org, workspace, purpose).
- **Credentials**: the port generates the password and writes it **straight to the vault** at `vault://orgs/<org>/apps/<project>/db/<role>`; the platform handles the reference only. The app environment carries references; the target resolves them at start.
- **Idempotency and durability**: the ledger row (state `creating`) is written **before** the provider call. After a timeout or any uncertain result the next call **reconciles first** (looks the tag up on the instance; found + secret present → `ready`; found without secret → destroyed and `failed`; not found → `failed`, then a clean create). Never a blind retry.
- **Residency**: `residencyAllows(org, region)` (the `ResidencyPolicyService` seam) is asked before anything is created.
- **Tenant scope**: every ledger method takes the org id; another org's record is `not_found`.
- **Destruction**: `destroyForWorkspace` (database + role + vault entries), idempotent; `sweep(liveWorkspaces)` destroys databases whose workspace is gone and databases with no ledger record.
- **Audit**: `app_database.created/reconciled/destroyed` via `AuditSink`. Metering: none yet (the managed DB product's metering is S07/B-DB).

Proposed durable ledger (Master applies; see CONTRACT-P3-S05-2): `builder.app_databases` (id, org_id, workspace_id, purpose, region, names, password_ref, host, port, state, idempotency_key unique per org, error, timestamps), RLS by `org_id`, no personal data.

## 4. Multi-tenant apps (what the app does inside its own database)
`tenancy: 'multi'`: `app_tenants`; `tenant_id` on every table and on `app_users`/`audit_log`; `ENABLE` + `FORCE ROW LEVEL SECURITY` with one policy per table `USING/WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`; the column defaults to the same expression, so an insert without a tenant fails (NOT NULL) and a read without a tenant sees nothing (**fail closed**). Uniques are per tenant; foreign keys are composite `(tenant_id, id)` so a reference cannot cross tenants (optional references clear with `ON DELETE SET NULL (col)`, PostgreSQL 15+). The engine takes the tenant from the **verified user row** (AsyncLocalStorage), never from a header, query or body; `PgStore` sets `app.tenant_id` with `set_config(..., true)` inside one transaction per query.
**A superuser bypasses RLS**; the in-sandbox role and any managed role must not be one (tested: a superuser sees both tenants' rows, the app role sees one).

## 5. Migrations (F4)
Forward-only in normal use, every migration has a `.down.sql` (development/staging only; production is fixed forward), `diffSpecs` produces expand/contract migrations and flags destructive statements for approval (unchanged). The runner is re-runnable (second run applies nothing) and atomic per migration (a failing migration leaves the previous version; tested on PostgreSQL 16). Seeds: the only seed is the first administrator from the environment at deploy time; the probe and tests use synthetic `example.test` data only.
