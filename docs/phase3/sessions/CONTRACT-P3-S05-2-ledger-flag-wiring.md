# CONTRACT-P3-S05-2 — shared files for the full-stack pieces (request to the Master)

From P3-S05. Everything below is in files S05 does not own. None is needed for the code S05 delivers to be tested; all are needed before the pieces are reachable in the product.

## 1. Migration 2340 (range 2340–2349) — `builder.app_databases` (managed-DB ledger, design: `DESIGN-P3-S05-app-database.md` §3)
```sql
CREATE TABLE builder.app_databases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES platform.organizations(id),
  workspace_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('staging','preview')),
  data_region text NOT NULL,                       -- residency: checked before create
  database_name text NOT NULL, role_name text NOT NULL,
  password_ref text NOT NULL,                      -- vault reference only; never a value
  host text, port integer,
  state text NOT NULL CHECK (state IN ('requested','creating','ready','destroying','destroyed','failed')),
  idempotency_key text NOT NULL, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key), UNIQUE (database_name)
);
-- RLS by org_id like every builder table; classification: no personal data (all columns `internal`); `password_ref` class `secret_ref`.
```
Rollback note: `DROP TABLE builder.app_databases` (no other table references it). Needs the `ownership.yaml` entry (module `builder`), the classification rows and the RoPA line "none (no personal data)". The `PgDbLedger` implementation (same interface as `MemoryDbLedger`) is written after the table exists.

## 2. Feature flags (default off)
`appbuilder.fullstack.generate` (tenancy/sign-up options and the product generators) and `appbuilder.fullstack.probe` (running the probe through the execution gateway). Until accepted, `generateProject(spec)` with no options is byte-identical to the Phase 2 scaffold apart from the added files.

## 3. Wiring owned by S03 (appbuilder module, `webapp-agents.ts`, `index.ts`)
- pass `FullStackOptions` from the approved plan to `generateProject(spec, options)` (the options are recorded in `nuzm.app.json`, so a rebuild is deterministic);
- run `runStaticGates(files, { platformFiles: platformFileHashes(runtimeFiles()), stage })` after every generation or repair round and feed `findings` (rule, file, line; never source text) to the repair loop; stage `locked` after the lockfile exists;
- call `probeGeneratedApp({ spec, options, files, runtime })` as the run-and-probe step (`runtime` = the `ExecutionPort` adapter; `simulatedProbeRuntime()` until S02's node exists);
- export from `appbuilder/index.ts`: `runStaticGates`, `platformFileHashes`, `probeGeneratedApp`, `productApp`, `AppDatabaseProvisioner` (module boundary rule: other modules import only the public index).
S05 does not edit these files.

## 4. OpenAPI / SDK
No endpoint is added by S05. If the product exposes "generate a full-stack app for a product type" or "run the probe" as routes, spec first (owner approval), then S03/Master.

## 5. messages.ts
No user-visible strings were added by S05 (the generated app carries its own Arabic/English labels in the spec).

## 6. Dependency allowlist note for S08
The generated app's dependency policy is `pg` (runtime) + `typescript`, `@types/node`, `@types/pg` (dev). A product that needs more must extend the allowlist per project in the gate options; nothing is allowed implicitly.

## 7. One-line change in a Phase 2 test owned by S03 (consequence of S05's revocation table)
`apps/api/src/modules/appbuilder/generated-app.int.spec.ts` line 104 asserts the exact table list of a fresh generated schema. Generated schemas now also contain `app_revoked_sessions` (server-side logout revocation), so the expected list becomes
`['app_revoked_sessions', 'app_users', 'audit_log', 'projects', 'tasks']`. S05 applies this only in its working tree to run the suite and does not commit it; the Master applies it with this contract.
