# DESIGN — P3-S09 Production version store (no `git` binary, no host subprocess)

Status: implemented on branch `claude/p3-s09-version-store-a31cc6`. Evidence labels: SIMULATED / NOT VERIFIED / LIVE-VERIFIED are used exactly as in `PHASE-3-PLAN.md` §2. Nothing here ran against a real GitHub account or a real production database.

## 1. Problem
`GitStore` (`internal/git/git.store.ts`) versions a project by spawning the `git` binary on the application host (`init`, `hash-object`, `mktree`, `commit-tree`, `update-ref`, `log`, `ls-tree`, `diff`). Phase 3 (P3-S02) adds a host-execution guard that refuses subprocesses in production, so a production builder would have **no version store**. The call sites (`ChangeService`, `build-harness`) only use nine methods: `init, commit, tipOf, branches, tag, checkpoints, log, readTree, diff`.

## 2. Decision: confirm the recommended design, with three refinements
A pure TypeScript, content-addressed store in PostgreSQL behind a `VersionStore` port. `GitStore` stays as the dev/test implementation (and as the **oracle** of the conformance suite); `PgVersionStore` is the production implementation; a third, `MemoryVersionStore`, shares the same core and backs DB-free unit tests.

Refinements over the brief's sketch:

1. **Git-compatible object ids.** Blobs, trees and commits are hashed exactly as git hashes them (SHA-1 over `"<type> <len>\0<body>"`, git's tree ordering, `commit-tree` message rules). Consequence: for the same snapshot, message, parent and timestamp `PgVersionStore` produces the **same 40-hex commit id as `GitStore`**. That keeps every existing 40-hex validation at the call sites valid, makes the conformance suite a byte-for-byte comparison, and lets a future real-git delegate (isolated runtime) read the same ids. SHA-1 is **not** trusted for integrity: every blob also stores its **sha256** and size, both re-verified on read (`corrupt_object` on mismatch). Objects are scoped to one repository (`repo_id`), so a chosen-prefix collision could only affect the attacker's own project.
2. **One core, three backends.** `ObjectVersionStore` holds all logic (path rules, caps, secret scan, hashing, tree building, replay, compare-and-swap, log walk, diff); a small `ObjectBackend`/`ObjectTx` port holds storage. The Pg backend runs a whole commit in **one transaction** under `withOrg` (RLS) that first locks the repository's state row, so writers on a repository are serialised and the compare-and-swap on the branch ref cannot race.
3. **The repository registry is the existing `builder.git_repos` row** (same schema/module, same RLS, `data_region` already there, never deleted). `init(ref)` resolves `(org_id, storage_ref)` to that row; it does not invent a second repository concept. A composite unique index `(id, org_id)` is added to `builder.git_repos` so the new tables can carry composite foreign keys: the database itself refuses a row whose `org_id` differs from its repository's.

## 3. Interface
`VersionStore` (port) = the nine existing methods with the same signatures and the same error type family (`VersionStoreError extends GitError`, so the call sites' `instanceof GitError` keeps working). Additive extras on `VersionStoreExt` (Pg/Memory only): `resolve`, `listTree` (path, size, binary, oid), `readFiles` (exact bytes), `setRemoteRef/getRemoteRef`. A free function `restoreCheckpoint(store, ref, branch, name, message)` implements rollback on any store: it reads the checkpoint's tree and writes a **new** commit on the branch (history is never rewritten; there is no force, no reset, no branch delete).

Selection by configuration (`select-version-store.ts`, `APPBUILDER_VERSION_STORE`):

| env | value unset | `git` | `pg` | `memory` |
|---|---|---|---|---|
| `NODE_ENV=production` | `pg` | **refused at startup** | ok | **refused** |
| other | `git` (today's behaviour) | ok | ok | ok |

A production boot with the host store configured throws before serving; there is no silent fallback. The Pg store additionally refuses to be constructed without a `Db`.

## 4. Data model (schema `builder`, migrations 2380–2382)
Every table: `org_id NOT NULL`, `repo_id`, `data_region NOT NULL` (copied from the repository row), RLS `FORCE` with the standard `org_isolation` + `platform_read` policies, immutable-row triggers, no DELETE grant.
- `vcs_repo_state(repo_id PK, stored_bytes, object_count)` — quota counters and the **per-repository lock row**.
- `vcs_blobs(repo_id, oid)` — `content bytea`, `sha256`, `size`, `is_binary`; size ≤ 1 MB per file; immutable.
- `vcs_trees(repo_id, oid)` — `entries jsonb` `[name, mode, oid]…`; immutable.
- `vcs_commits(repo_id, oid)` — `tree_oid`, `parents text[]`, author, `committed_at`, `message`, plus `replay_key` (sha256 of parent+tree+message) for idempotent replay; immutable.
- `vcs_refs(repo_id, name)` — `refs/heads/*`, `refs/tags/cp-*` (a checkpoint is immutable: the trigger refuses to move or delete a tag), `refs/remotes/github/*` (mirror only); branches move by compare-and-swap and are never deleted.
- `vcs_events(id)` — append-only journal of every mutation (atomic with the mutation); the platform `AuditSink` additionally receives `builder.versionstore.*` events.

## 5. Behaviour rules
- **Idempotent commits.** Replay key = (first parent, tree oid, message hash). A retry of the same request after a timeout returns the existing commit instead of creating a second one, *even if the branch has moved since* (reconcile before retry, CLAUDE.md §4). Same snapshot + same parent + same message + same `at` already yields the same id by construction.
- **Path rules** reuse `checkPath` from `sandbox/paths.ts` (traversal, `.git`, absolute, control/bidi, NFC, reserved names) plus: no file/directory name clash, no symlink/submodule/executable modes in the model at all (every file is mode 100644; the store has no way to represent a symlink), caps: 5 000 files, 1 MB per file, 50 MB per snapshot, 200 MB stored per repository, message ≤ 2 000 characters.
- **Secret scan on write** (`scanSecrets`) applies to every *new* text blob; a finding rejects the whole commit and names rule and path, never the matched text. Blobs that already exist are not rescanned (a rollback to an old checkpoint must work).
- **Diff:** structural walk that skips identical subtrees (equal oid ⇒ equal content); added/modified/deleted lists sorted like `GitStore`; exact-content rename detection reported in `renamed` (the lists are unchanged); unified patch (Myers) with git headers, binary files reported as `Binary files … differ`, per-file and total caps (`PATCH_CAP` 200 000).
- **Audit/RLS/residency:** org context is taken from the repository reference (`<org>/<project>.git`, produced by the call site from verified auth) and bound to `withOrg`; a cross-tenant reference simply finds no repository. `init` asks the residency evaluator (`assertResidency`, purpose `builder_version_store`) before placing a new repository.

## 6. GitHub
The existing `GitHostAdapter` (GitHub App, REST **Git Data API**: blobs/trees/commits/refs, installation token minted per call and held in memory, key and webhook secret as vault references, `X-GitHub-Delivery` dedupe in `builder.github_events`, `redirect: 'error'`, 15 s timeout, no `git` binary anywhere) is kept as is. `github-bridge.ts` adds only the glue to the store: `exportToGitHub` (a store revision → adapter commit on a branch, never forced, remote-tracking ref + audit event) and `importFromGitHub` (adapter tree → a commit on `import/github-<branch>`, binary/oversized files reported as skipped). Both are tested with the existing `FakeGitHostAdapter` (**SIMULATED**); nothing was run against github.com (**NOT VERIFIED**). Out of scope: fetch/push by the git wire protocol, merges, rebases, submodules, LFS, packfiles — anything needing real git semantics would have to run in the isolated runtime (P3-S02) and is **NOT VERIFIED**.

## 7. What is deliberately not done here
- No HTTP route (SCR-M10-01 still awaits the owner); the Master registers wiring (see `CONTRACT-P3-S09-*`).
- No garbage collection of unreachable objects (objects are only ever added; a size quota bounds growth). A GC/archival job is a follow-up.
- No cross-repository blob deduplication (it would leak existence across tenants).
- Path case-collisions (`A.ts` vs `a.ts`) are allowed, like git on Linux.
