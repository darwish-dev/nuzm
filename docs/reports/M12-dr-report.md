# M12 disaster-recovery report

Status: **PARTIAL: one LOCAL drill recorded; no staging/production DR. AC-M12-08 NOT VERIFIED.** Written 2026-11-18. Targets (D-30, accepted 2026-11-15): RPO ≤ 15 min, RTO ≤ 4 h.

## Local drill 1 (control-plane database, local dev cluster)
Commands (project-local PostgreSQL 16 on port 54354, user `nuzm_admin`):
`pg_dump -Fc -d nuzm_dev -f nuzm_dev.dump` → `CREATE DATABASE nuzm_dr_scratch` → `pg_restore --no-owner -d nuzm_dr_scratch nuzm_dev.dump`.
Measured (wall clock): dump 3.29 s, restore 11.51 s, total 14.80 s; start 2026-11-18T13:16:40Z, restored 2026-11-18T13:16:55Z. Verification: 201 of 201 tables present; row counts equal for `ops.alerts` (9), `ops.launch_gates` (38) and the empty tenant tables.
Recorded in `ops.recovery_exercises` of the dev database (`environment=local`, `rto_seconds=15`, `rpo_seconds=0`, result `pass`).
**What this proves:** the dump/restore procedure and the recording mechanism work. **What it does not:** it is a logical dump of an idle database holding seed data only; it is not point-in-time recovery, not staging, not production, and RPO 0 is the trivial value of an idle database. It must not be read as evidence for AC-M12-08.

## Required exercises (M12 §11)
| Exercise | Status |
|---|---|
| Control-plane DB PITR into a scratch environment | BLOCKED (needs WAL archiving / managed Postgres: D-03, D-05, staging) |
| Object-storage / bucket sample restore | BLOCKED (D-07 provider) |
| One hosting site restore | NOT VERIFIED (M06 restore tested on mocks only) |
| One managed DB restore | NOT VERIFIED (M08 on the self-operated fake) |
| Secrets/KMS recovery dry run | BLOCKED (D-12) |
| Regional-loss tabletop | PENDING (human-led, HG-12-03) |

Runbook: [dr-restore.md](../runbooks/dr-restore.md) (NOT EXERCISED).
