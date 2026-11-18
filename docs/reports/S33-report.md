# S33 report — backups, restores, Redis, rotation

Status: **DONE for the autonomous scope; live rows BLOCKED** · Branch `claude/m08-data-email-b74780` · Written 2026-11-18 · Dev-reference mocks only: **NOT VERIFIED (local reference)**; production providers BLOCKED (D-05..D-09 OPEN, HG-08-01 PENDING).

## A. Repository findings and assumptions
- docs/04 has no endpoint to list restores: the restore and verification history is embedded in each backup of `GET /v1/databases/{id}/backups` (no spec addition).
- No Redis is installed locally: every Redis result is mock-only and NOT VERIFIED. The one-time credential reveal (PA-15) is NOT exposed over HTTP; the service exists.

## B. Plan and changed files
- `restore.service.ts` (request, execution, verification, drill), `rotation.service.ts` (dual-credential window, one-time reveal service), `alerts.ts`, migration 1001, `databases.controller.ts` routes `/restores` and `/credential-rotations`, `restore-rotation.int.spec.ts`.

## C. Implemented features, API and UI screens
- `POST /v1/databases/{id}/restores`: DEFAULT restore-to-NEW; in-place only with `confirmInPlace`, typed name, recent MFA and an automatic pre-restore backup; cross-org selectors 403; foreign backup 404; other region ⇒ residency check then `restore_not_supported`. Every restore is verified against the backup manifest (mismatch ⇒ failed + critical alert).
- Verification drill (weekly proposal, on demand): scratch restore → integrity check → destroy; failures raise `ops.alert` + notification.
- `POST /v1/databases/{id}/credential-rotations`: new credential issued while the old one works (24 h proposal), vault, consumers notified via `DatabaseBindingPort`, old credential revoked at the window end; no dual-credential support ⇒ action disabled (422).
- Redis (`engine=redis`) through the cache adapter: TLS, ACL user with an allow-listed rule, persistence only if the probe says so.
- Resize: `PATCH plan` is 422 `unsupported_capability` unless proven by a probe (not implemented for any adapter).

## D. Migrations and rollback
- `1001__data__restores_reveal` (+ `.down.sql`, DEV ONLY).

## E. Tests run with actual results
- `restore-rotation.int.spec.ts`: 20 integration cases (PostgreSQL and MySQL restore-to-new on simulated data, corruption detection, in-place rules, drill + alert, rotation window, reveal).

## F. Security, tenant isolation, billing, residency verification
- A restore never leaves the organization or region; secrets never appear in responses, operations, audit or notices (tests grep for them). A failed final/pre-restore backup stops the destructive step.
- Residency denial test for restore (AC-M08-15).

## G. Human gates and live checks still needed
- HG-08-01 (real restore drills), D-06 (Redis), D-34 (backup retention), PA-15 (reveal), PA-21 (approval step). In-place 'approval' is implemented as step-up + typed name + pre-restore backup, NOT a second person.

## H. Acceptance checklist
| Row | Status |
|---|---|
| AC-M08-03 (restore-to-new reproduces source, PostgreSQL/MySQL) | NOT VERIFIED (simulated data; no real engine restore) |
| AC-M08-04 (verification job + alert on injected corruption) | PASS (simulated) |
| AC-M08-06 (rotation: old credential rejected ≤60 s after window end, zero-downtime binding test) | PASS (dev-reference; the 60 s depends on `DATA_SCHEDULER_INTERVAL_SECONDS` ≤ 30 in deployment) |

## I. Next-sprint handoff and open decisions
- S34 reuses the durable-operation and reconcile machinery for buckets; the system bucket pair is the backup target.
