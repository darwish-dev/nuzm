# Runbook — deploy and rollback of generated web apps (M10A)
- Create: `POST /v1/deployments`; 403 `approval_required` lists approvals (production deploy, paid resource, destructive migration, dependencies); decide in the inbox; repeat.
- Health gate fails → previous release restored automatically, deployment `failed` (`health_gate_failed`), audit `deploy.deployment.rolled_back` (automatic).
- Manual rollback: `POST /v1/deployments/{id}/rollback` (idempotent). Production rollback needs `production_rollback`; a deployment that applied data-affecting (contract/destructive) migrations needs `data_migration_rollback`. Additive (expand) migrations are not reverted: the previous release works with the expanded schema; down scripts are applied only by a deliberate, approved forward fix.
- Dependencies: no lockfile / typosquat / high advisory blocks before anything is built (422 `dependency_blocked`).
- Targets are ports: only the in-memory dev target exists; real M06/M05 targets are not wired (NOT VERIFIED).
