# CONTRACT P3-S09-1 — migration block, ownership manifest, classification, residency hooks

Requester: P3-S09 (production version store) · Contract: `spec/db/ownership.yaml`, `spec/compliance/residency-hooks.yaml`, migration numbering · Additive: yes · Status: PENDING (Master answers here)

## Change
1. **Migration range** `P3-S09: "2380-2389"` (inside the Master's 2380–2399 reserve). Used: `2380__builder__vcs_repo_state_blobs`, `2381__builder__vcs_trees_commits_refs`, `2382__builder__vcs_events` (each with `.down.sql`, dev/staging only; production is forward-fix).
2. **Schema `builder`**: `extended_by` += `P3-S09`; `tables` += `vcs_blobs, vcs_commits, vcs_events, vcs_refs, vcs_repo_state, vcs_trees`.
3. **Classification** of every column of the six tables (blobs.content, trees.entries, commits.message are `customer-content`; the rest `internal`).
4. **Residency hooks**: the six tables listed under hook `m10-version-store` (owner M10, note: region inherited from the project; no remote), and a new **enforced** hook `m10-version-store` (flag `residency.enforce.builds`, call site `apps/api/src/modules/appbuilder/internal/versionstore/object-version-store.ts`, which calls `assertResidency` before a repository is first placed).
5. **Additive index on an existing table:** `CREATE UNIQUE INDEX git_repos_id_org_idx ON builder.git_repos (id, org_id)` (migration 2380). It lets the new tables carry composite foreign keys `(repo_id, org_id)`, so the database refuses a row whose organisation differs from its repository's. No column, trigger or grant of `builder.git_repos` changes.

## Exact patch
`docs/phase3/sessions/CONTRACT-P3-S09-1-ownership-residency.patch` (`git apply` against `spec/`). I applied the same patch in my working tree only to be able to run the migrations and the compliance checks; it is **not committed** on my branch. Revert-at-merge is therefore a no-op: apply this patch instead.

## Why
`discoverMigrations` rejects ordinals outside a registered range, `compliance:classification-coverage` fails on unclassified columns, `compliance:residency-hooks` fails on a table with `data_region` that is not listed.

## Tests
`pnpm compliance:classification-coverage`, `pnpm compliance:residency-hooks` (need the migrated DB), migrations up/down/up on a scratch database, `apps/api/.../versionstore/pg-version-store.int.spec.ts`.

## Sessions affected
None functionally. P3-S03 owns `builder.git_repos` code (`ChangeService.repoFor`): nothing changes for it; its table only gains an index.
