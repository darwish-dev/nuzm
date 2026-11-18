# Runbook — drain, maintenance and site migration (M06 S26)

Status: mock evidence only (NOT VERIFIED on a real node).

1. **Drain** — `PATCH /v1/admin/hosting/nodes/{id} {status:'draining'}` (If-Match, step-up). The scheduler excludes the node at once (candidates = `active` + healthy); running sites keep serving. Use `maintenance` for work that needs the node quiet (the agent keeps answering the inventory).
2. **List the sites** — `GET /v1/admin/hosting/sites?nodeId=<node>`.
3. **Migrate each site** — `POST /v1/admin/hosting/sites/{id}/migrations {targetNodeId}` (admin:hosting:manage, step-up, Idempotency-Key). Preconditions checked by the API: target `active` and healthy, **same data region** (a site never changes region: residency), target offers the runtime, one migration per site at a time.
   Steps: backup (`pre_migration`, per-site key) → create on target → restore on target → verify checksum → **switch** (reservation moves: target reserved first, source released; `sites.node_id` changes; domains re-applied; managed certificates re-issued by the sweep) → remove from the source.
4. **Failure** before the switch: the target copy is removed, the **source keeps serving untouched**, the migration is `rolled_back` with the reason; the reservation never left the source. Retry after fixing the cause.
5. **Retire** — when the node has no live site: `PATCH … {status:'retired'}` (refused while sites remain).
Rollback after the switch: migrate the site back the same way; the `pre_migration` backup stays for its retention period.
