# REPORT — P3-S09 Production Git version store

Branch `claude/p3-s09-version-store-a31cc6` (cut from `integration/ai-engine` @ `9f5ba771`). Design: [DESIGN-P3-S09-version-store.md](DESIGN-P3-S09-version-store.md). Contracts for the Master: [CONTRACT-P3-S09-1](CONTRACT-P3-S09-1-ownership-residency-migrations.md) (+ `.patch`), [CONTRACT-P3-S09-2](CONTRACT-P3-S09-2-wiring-appbuilder-module.md).
Labels: **PASS** = I saw the command output; **SIMULATED** = against an in-process fake or a local throw-away database, never a real vendor; **NOT VERIFIED** = not run.

## A. Repository findings and assumptions
- `GitStore` spawns the `git` binary on the host. Its only users are `ChangeService` (`init, commit, tipOf, tag, …`, P3-S03's file), the build harness and its own spec. `builder.git_repos` (same schema) already holds `storage_ref` (`<org>/<project>.git`) and `data_region`; the store uses it as the repository registry.
- The P3-S02 guard `assertHostProcessAllowed('git-store')` is **not** in this branch's base; the production refusal here is by configuration (`select-version-store.ts`), and will compose with the guard after the merge.
- The GitHub side already existed and already complies: `GitHubAppAdapter` uses only the HTTPS REST Git Data API, mints installation tokens per call (memory only), takes key and webhook secret as vault references, dedupes deliveries in `builder.github_events`, never forces. I added glue only.
- Assumption: SHA-1 object ids are acceptable as identifiers because each blob also carries a sha256 verified on read and objects are scoped per repository (design §2.1).
- Assumption: the repository reference's organisation segment comes from a row the caller read under verified auth (it does in `ChangeService.repoFor`).

## B. Plan and changed files
New, all mine: `apps/api/src/modules/appbuilder/internal/versionstore/` — `version-store.port.ts`, `git-object.ts`, `diff.ts`, `object-backend.ts`, `object-version-store.ts` (core), `memory-backend.ts`, `pg-version-store.ts`, `select-version-store.ts`, `github-bridge.ts`, `index.ts`, `conformance.ts`, and specs `git-object|diff|object-version-store|paths.fuzz|select-version-store|github-bridge|oracle .spec.ts`, `pg-version-store.int.spec.ts`. Migrations `packages/db/migrations/builder/2380`, `2381`, `2382` (+ `.down.sql`). Docs: design note, two CONTRACT files, the ownership/residency patch, this report. **No file of another session was edited**; `spec/**` was patched in my working tree only to run migrations and was not committed (the patch is in the CONTRACT).

## C. Implemented
- `VersionStore` port = the nine existing methods; `VersionStoreError extends GitError` (existing `instanceof` checks keep working); extras on the Pg/Memory stores: `resolve`, `listTree`, `readFiles`, `setRemoteRef/getRemoteRef`; `restoreCheckpoint()` (rollback = new commit of the checkpoint's tree, no rewrite, idempotent).
- `ObjectVersionStore`: git-compatible blob/tree/commit ids, path rules (`checkPath` + no file/dir clash), caps (5 000 files, 1 MB/file, 50 MB/snapshot, 200 MB/repository, 2 000-char message), secret scan of new text blobs, idempotent replay (same parent+tree+message ⇒ same commit even after the branch moved), compare-and-swap, fast-forward only, no branch deletion, immutable checkpoints, ref D/F-clash check, `log` (time order, child before parent, capped 200), diff (shared-subtree skipping, binary reported, exact-rename detection, capped patch), integrity verification on read (blob sha256/size/oid, tree id, commit id).
- Backends: Memory (tests) and PostgreSQL (`withOrg` RLS, one transaction per operation, writers serialised by the repository's state row, journal row in the same transaction). Audit events `builder.version.{repo_initialised,committed,checkpointed,remote_synced}`. Residency asked via `assertResidency` before a repository is placed.
- Configuration `APPBUILDER_VERSION_STORE`: dev default `git` (unchanged), production default `pg`, production **refuses** `git` and `memory`, and refuses to build `pg` without database, audit sink and residency evaluator.
- `GithubVersionBridge`: `exportToGitHub` (store revision → branch via adapter, never forced, mirror ref `refs/remotes/github/<branch>`, retry-safe) and `importFromGitHub` (to `import/github-<branch>`, never `main`, no empty commit on re-import).
- No HTTP route, no flag (SCR-M10-01 stays owner-gated); not yet wired into the module (CONTRACT-2).

## D. Migrations and rollback
`2380` (unique index `git_repos(id, org_id)`, `vcs_immutable()`, `vcs_repo_state`, `vcs_blobs`), `2381` (`vcs_trees`, `vcs_commits`, `vcs_refs`), `2382` (`vcs_events`). Every table: `org_id`, `data_region`, FORCE RLS (`org_isolation` + `platform_read`), composite FK `(repo_id, org_id)`, immutability triggers, no DELETE grant. Rollback files are dev/staging only (production forward-fix: customer history is never dropped). **PASS (local scratch cluster, SIMULATED production)**: migrate applied the whole chain; the three `.down.sql` then the three `.sql` re-applied cleanly (tables 6 → 0 → 6, index removed and recreated).

## E. Tests run (actual results)
| Command | Result |
|---|---|
| `vitest run src/modules/appbuilder/internal/versionstore/` (7 files; includes the real-git oracle) | **PASS** 76/76 |
| `vitest run --config vitest.integration.config.mts …/pg-version-store.int.spec.ts` on my leased cluster | **PASS** 25/25 (conformance on PostgreSQL, RLS, FK, triggers, concurrency, audit, residency, load) |
| `tsc -p tsconfig.json --noEmit` in `apps/api` | **PASS** (exit 0) |
| `eslint src/modules/appbuilder/internal/versionstore` | no findings (no output) |
| `pnpm db:migrate`, `compliance:classification-coverage` (3 454 columns / 278 tables), `compliance:residency-hooks`, `compliance:ropa-coverage` | **PASS** (with the CONTRACT patch applied locally) |
Findings fixed on the way: an untyped `new Map()` in the tree walk (tsc); my static "no subprocess" scan matching a regex `.exec(`; a tenant test that reused a globally-unique project id; the replay path bypassing the ref-clash check (caught by review before the first run).
Conformance cases run against **GitStore (oracle), MemoryVersionStore and PgVersionStore**. Property tests (25 runs each) compare commit ids, `log`, trees, diff lists and patch application with real git. Fuzz: 600 random text pairs (patch round trip), 400 edit-script cases (minimality vs LCS), 400 path sets, 300 branch/tag names.
**Not run:** `pnpm test`/`verify` repository-wide, `builder-s46.int.spec.ts`/`change-tools.int.spec.ts` (they use `GitStore`, unchanged, and the wiring is in the CONTRACT), `apps/api` full integration, anything on a Linux production database.
Load (SIMULATED, one laptop, loaded by other sessions; two runs): 150 sequential commits of a 300-file project 9.5–10.6 s total (≈64–71 ms/commit, first ≈100–160 ms); one commit of 2 000 files (≈7 MB) 1.4–4.3 s; 20 repositories × 8 commits concurrently ≈3.0 s. Structural sharing verified: 150 commits stored exactly 297 + 150×3 blobs.

## F. Security, tenant isolation, billing, residency
- **Tenant isolation (PASS, SIMULATED DB):** another org sees 0 rows in all six tables and `git_repos`; inserting a row claiming org A as org B is refused by RLS; claiming org B for A's repository is refused by the composite FK; a forged reference (`<B>/<A's project>.git`) finds no repository; B's own repository cannot read A's commit ids or checkpoint them.
- **Immutability (PASS):** runtime role has no DELETE/UPDATE on objects/events; even a superuser hits the triggers (objects, events, refs, repo state; checkpoints never move; stored bytes only grow).
- **No host execution:** none of the production files imports `child_process` or calls spawn/exec (a test scans them); only `select-version-store.ts` imports `GitStore` for the development mode.
- **Secrets:** scan on write rejects with rule/path/line and never echoes the match; blobs that already exist are not rescanned so a rollback to older history works. File content never reaches the audit event (tested).
- **Billing/metering:** none (no billable action). **Residency:** `assertResidency` before first placement, region copied to every row; hook `m10-version-store` proposed in the CONTRACT.
- Integrity: tampered blob/commit/ref detected (`corrupt_object`, `unknown_revision`) on both stores.
- Known limits: no garbage collection, no org-level storage quota (per-repository 200 MB only), no cross-repository dedup (deliberate), path case collisions allowed like git on Linux, `GitStore` ignores `actorUserId/traceId` and binary content.

## G. Human gates and live checks still needed
- **NOT VERIFIED:** anything against github.com (App registration is HG-AS-01; the bridge ran only against `FakeGitHostAdapter` and a simulated REST API that records every request: HTTPS to `api.github.com`, Git Data API paths only).
- **NOT VERIFIED:** a production-sized PostgreSQL (the load figures are from a laptop).
- Operations needing real git semantics (merge, rebase, packfile import, LFS, submodules) are out of scope; if ever needed they must run in the isolated runtime (P3-S02) and would be NOT VERIFIED until then.
- Master actions: apply CONTRACT-1 (manifest/migration range/hook) and CONTRACT-2 (module + `ChangeService` type change), merge with the P3-S02 guard, run the repository-wide regression.

## H. Acceptance checklist
| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Design note | PASS | DESIGN-P3-S09 |
| 2 | `VersionStore` port, both stores interchangeable by config | PASS (code + select spec) | `select-version-store.spec.ts`; call-site wiring pending (CONTRACT-2) |
| 3 | Pure TS, no subprocess in production path | PASS | scan test + review |
| 4 | Migrations in block, `.down`, `org_id`, RLS, `data_region`, classes | PASS (SIMULATED DB) | §D; CONTRACT-1 for the manifest |
| 5 | Conformance on both stores, oracle = GitStore | PASS | 76/76 and 25/25 |
| 6 | Property/fuzz on diff and path rules | PASS | §E |
| 7 | Load test with size caps | PASS (SIMULATED) | §E |
| 8 | Tenant isolation + audit tests | PASS (SIMULATED DB) | §F |
| 9 | Idempotent commits; rollback as new commit; no rewrite | PASS | object-version-store.spec, int spec |
| 10 | Production refuses host store, uses Pg | PASS (unit) | select spec; boot-level proof after wiring: NOT VERIFIED |
| 11 | GitHub via HTTPS Git Data API only, no git binary | SIMULATED (PASS in fake); live NOT VERIFIED | github-bridge.spec |
| 12 | Live GitHub / production DB | NOT VERIFIED | §G |

## I. Next-milestone handoff and open decisions
- Master: CONTRACT-1/2; consider passing `actorUserId`/`traceId` from `ChangeService` into `commit`/`tag`.
- Open: GC/archival job for unreachable objects (none are created today besides orphaned blobs of rolled-back commits, which do not exist because commits are atomic); org-level storage quota; whether `restoreCheckpoint` should get an HTTP route (SCR-M10-01 still pending the owner).
