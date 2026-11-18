# Runbook — database backup, restore and restore verification (M08)

Scope: managed PostgreSQL/MySQL/Redis. **No provider is selected (D-05/D-06 OPEN); everything below was exercised only against dev-reference mocks (NOT VERIFIED).** Real restore drills need HG-08-01 / HG-05-01/02.

## Normal paths
1. **Backup** — scheduled (policy `intervalHours`, default 24 h, bounded by the entitlement) or manual (`POST /v1/databases/{id}/backups`). The artifact lives in a SYSTEM bucket of the database's own `data_region`; `data.database_backups` holds size, SHA-256 checksum and a manifest (row count + checksum of sampled tables). Retention is configuration (D-34 OPEN; default 7 days), never a legal period.
2. **Restore (default: to a NEW database)** — `POST /v1/databases/{id}/restores {backupId}`. The restored database is an ordinary database with its own credential; the restore is verified against the backup manifest and FAILS (and alerts) on any mismatch.
3. **In-place restore** — only with `confirmInPlace=true`, the typed database name and a recent MFA check. An automatic `pre_restore` backup is taken first; if it fails nothing is overwritten. A provider without `database.restore-in-place` answers `422 restore_not_supported`.
4. **Verification drill (FR-DAT-10)** — weekly (proposal `DATA_VERIFY_INTERVAL_DAYS=7`) and on demand: the newest backup is restored into a scratch instance, integrity-checked and destroyed. Results: `data.database_restores` (`mode=verification`, `verification` jsonb). A failed drill raises an `ops.alert` outbox event + a notification to the organization's database admins.

## When a drill fails (`data.restore_verification_failed`)
- Treat the backup chain as **untrusted**: take a new manual backup now, compare checksums with the instance's own integrity check, and open an incident in the ops console (M12).
- Do **not** restore in place from the failing backup. Restore a different backup to a new database and compare.
- Record the evidence reference in the incident; never paste data or secrets.

## When an operation is parked (`needs_reconcile`)
A timeout after the provider may have acted parks the operation. The reconciler looks the resource up by its deterministic token (`findByToken`/`findBackupByToken`) and only retries when it is provably absent. Never retry by hand against the provider.

## Residency
Backups, restores and scratch instances stay in the source `data_region`; a restore into another region is refused (`403 residency_denied` or `422 restore_not_supported`).
