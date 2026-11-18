# Runbook — disaster recovery and restore, per data store (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED: no DR exercise has been run; no production environment, managed-database provider, object-storage provider or vault exists yet (D-05, D-07, D-12 OPEN; HG-05-xx, HG-08-xx PENDING). Targets below are the **D-30 values accepted 2026-11-15**: RPO <= 15 minutes and RTO <= 4 hours for the control-plane database (availability 99.9 % monthly). They are targets, not results: only a measured exercise can show whether they are met (AC-M12-08). **Measured timestamps must be recorded, never estimated.**
Endpoints marked *(planned)* are not yet in `spec/openapi/openapi.yaml`.

## Purpose
Restore each data store from backup into a scratch (or replacement) environment, measure how long it took and how much data was lost, and record it as evidence; and give responders the order of work in a real loss.

## Trigger / alert
Real: loss or corruption of the control-plane database, a bucket, a site, a managed database, the vault/KMS, or a whole region (`db-failover.md` for node loss). Exercise: scheduled drill (proposal: control-plane restore semiannual, store samples quarterly; owner decides) or the weekly managed-database verification drill (`db-restore.md`).

## Severity guidance (proposal)
Real loss of the control-plane database or region: SEV1. Single customer store: SEV2/SEV3. Exercises are not incidents.

## Preconditions / access
Platform admin and a database administrator in the admin realm with MFA; backups located **in-region** (restore drills run in-region; residency per `ResidencyPolicyService`, `residency-hooks.md`: a restore into another region is refused). A scratch environment never shares credentials with production. Break-glass for the control-plane database follows `break-glass-draft.md` (BLOCKED, D-12). A scribe records timestamps from one clock source in UTC.

## Steps (all stores): common frame
1. Open an incident (real loss) or an exercise record. Note `startedAt` (UTC) when the decision to restore is made; for an exercise, when the exercise starts.
2. Decide the recovery point (a timestamp or a backup id) and write it down before restoring.
3. Restore into the scratch/replacement target using the store procedure below.
4. Verify with the store's checks. Note `restoredAt` (UTC) when the store is usable and verified.
5. Compute: **RTO = restoredAt - startedAt**; **RPO = (time of the incident or loss) - (commit/backup time of the newest recovered data)**, both in seconds, from logged timestamps.
6. Record it: `POST /v1/admin/recovery-exercises` *(planned; permission `admin:ops` in the M12 prompt)* with `{scope, startedAt, restoredAt, rpoSeconds, rtoSeconds, evidenceRefs[], result}` and an `Idempotency-Key`. Until the endpoint ships, keep the same fields in the evidence index (`docs/reports/evidence-index.md`) and copy them across afterwards.
7. Destroy the scratch environment after sign-off; record the destruction.

## Per data store
### 1. Control-plane PostgreSQL (point-in-time recovery)
Target: RPO <= 15 min, RTO <= 4 h (D-30).
- Production PITR (continuous WAL archive in the same region) is **not designed or provisioned yet**: to be confirmed with the hosting decision. What exists and is verified for development: dump and restore, `restore-db-from-dump.md` (`pg_dump`/`pg_restore`, `check`, `migrate`).
- Procedure: restore base backup + WAL to the chosen timestamp into a scratch instance; run the schema check and `migrate` as in `restore-db-from-dump.md` (`check` must print `db check OK`; `migrate` refuses if a checksum changed); run the audit-chain verifier against the restored database (same document: a broken chain means the data was altered or incomplete: stop, preserve evidence, do not repair); run `pnpm db:test-rls` with the connection variables pointed at the restored database (to be confirmed for a scratch target); compare ledger balance (no imbalance: `ledger-inspection.md`) and the newest outbox/audit timestamps to compute RPO.
- Cutover (real loss only): stop API and worker, swap, start services, verify, keep the old database until sign-off. Then run RC-01..RC-06 for the gap window (`reconciliation-variance.md`) and replay or reconcile anything the PSP or providers did after the recovery point: reconcile before retry (`psp-incident.md`, `reconciliation.md`).
### 2. Object storage (sample restore)
Provider selection D-07 is OPEN; a bucket-level restore capability (versioning, replication) is **to be confirmed** with the provider. Sample procedure: pick N objects and one system backup bucket artifact, restore or download from the provider's recovery mechanism, verify SHA-256 against the recorded checksum (`data.database_backups` keeps size, checksum, manifest). Residency: same `data_region`. See `storage-incident.md`.
### 3. Hosting site
`POST /v1/hosting/sites/{id}/restores` (customer API, `hosting:backup:restore`, `Idempotency-Key`; 202 + operation): makes a pre-restore safety backup, restores, verifies the checksum. For the exercise use a test organization and site. Failure handling and `needs_reconcile`: `site-recovery.md`. Node loss: `drain-and-migrate.md`. Mock node only until HG-06-01.
### 4. Managed database
`POST /v1/databases/{id}/restores {backupId}` restores to a NEW database; verified against the backup manifest (fails and alerts on mismatch). The weekly verification drill restores the newest backup into a scratch instance and destroys it: `db-restore.md`. Provider live behaviour NOT VERIFIED (D-05, HG-08-01).
### 5. Secrets and KMS (dry-run)
The production vault/KMS is undecided (D-12 OPEN): **BLOCKED (D-12)**. When decided, the dry-run proves: vault references can be re-created or restored from the documented backup in a non-production vault, a rotation notice reaches consumers, and no secret value appears in logs or tickets. Until then the dry-run covers only the development file-stub procedure (`rotating-dev-secrets.md`) and must not be reported as production evidence.
### 6. Regional loss (tabletop, human-led)
Run with the owner, security, finance, support and communications roles. Scenario: the primary region is unavailable for more than the RTO. Walk through: declaring SEV1, which stores have an in-region replica or backup (residency may forbid copying elsewhere: counsel decides, HG-04-01), the customer notice, the order of recovery (identity and database, then queues and workers, then provider reconciliation, then billing), and the decision to invoke contractual terms. Output: notes and gaps, recorded as an exercise with `result` honest about what is not designed yet.

## Verification
Each exercise has a recorded row with timestamps, `rpoSeconds`, `rtoSeconds`, evidence references and `result`; the store checks above passed; audit chain verified; no ledger imbalance; RC runs for the gap window clean or resolved. AC-M12-08 is PASS only with measured RPO <= 15 min and RTO <= 4 h for the control-plane database (or approved different D-30 values).

## Escalation
L2 on-call engineer and database administrator; L3 platform owner; owner (SEV1, any decision to accept data loss); compliance officer and counsel (residency of backups, breach implications); finance lead (money reconciliation after restore).

## Communication draft
Real loss, EN: "We are recovering from an infrastructure failure. Some recent changes made between [time] and [time] UTC may need to be repeated. We will confirm when recovery is complete. Reference: [incident id]."
AR: "نعمل حاليًا على التعافي من عطل في البنية التحتية. قد تحتاج بعض التغييرات التي أُجريت بين [الوقت] و[الوقت] بالتوقيت العالمي المنسّق إلى إعادة تنفيذها. سنؤكد لكم عند اكتمال التعافي. المرجع: [رقم الحادثة]."
Exercises need no customer notice unless production is touched.

## Records to keep
`ops.recovery_exercises` rows (via the endpoint above), raw timestamp log, command output or console evidence references (no secrets or data), the audit-chain verification output, the destruction note of the scratch environment, tabletop notes. Summarise in `docs/reports/M12-dr-report.md`.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). Related: `db-restore.md`, `restore-db-from-dump.md`, `site-recovery.md`, `db-failover.md`.
