# S57 report — Reconciliation, DR, observability

Status: **PARTIAL: technical reconciliations, ops console API, alerts, SLOs, probes framework, incident tooling and runbooks done; all live/provider rows NOT VERIFIED or BLOCKED** · Written 2026-11-18.

## A. Repository findings and assumptions
- **RC-01..RC-06 already exist (M03)** with the admin API `/v1/admin/billing/reconciliations` and a daily schedule; S57 added a fixture test for RC-05 (the one class without an injected-discrepancy test) and did not re-implement them. RC-04 provider bills: `ProviderCostCapture.billSource()` is never registered in `BillSourceRegistry` (found by the metering review): compute bills are not compared in a running app.
- **TR-01 exists (M05 reconciler)**; TR-02/03/04 did not. They are implemented as detectors with injected sources.
- Conflict: docs/05 says TR results live only in `cloud.resource_reconciliations`, whose M05 shape is compute-only. Migration 1750 extends it (recorded in [M12-spec-change-requests.md](M12-spec-change-requests.md)).
- The queue is PostgreSQL (`platform.outbox`, `platform.operations`); no Redis/BullMQ exists on this branch. D-31 tolerance (0 / ≤ 0.5 %) is the PRD proposal, not decided.

## B. Plan and changed files
Migrations `1740` (ops schema, seeds: 6 SLOs, 9 alert rules, 38 launch gates; permissions `admin:ops:read|manage`) and `1750`. Code `apps/api/src/modules/ops/`: health, incidents, alerts + metrics, provider incidents, recovery exercises, probes, TR service, scheduler. Runbooks (15 new) and handover pack in `docs/runbooks/`, `docs/reports/M12-handover/`.

## C. Implemented features
- `GET /v1/admin/operations/health`; `GET/POST /v1/admin/incidents`, `PATCH …/{id}`; `GET/POST /v1/admin/alerts`; `GET /v1/admin/provider-incidents`; `GET/POST /v1/admin/recovery-exercises`.
- Incidents: SEV1–SEV4 workflow, append-only timeline, comms drafts, M04 breach-case link, PII guard (e-mail / long numbers refused).
- Alerts: owner **role**, severity and runbook mandatory (DB CHECK, runbook files verified to exist by a test); a metric that is not measured leaves the rule NOT EVALUATED (never "ok"); acknowledge; silence ≤ 30 days with expiry.
- SLOs seeded from D-30 (availability 99.9 %, RPO 900 s, RTO 14400 s accepted) plus latency/error proposals; the health report computes availability only from non-fixture probe runs.
- DR exercises: RTO must equal the two recorded timestamps, result derived from D-30 targets, append-only; local drill in [M12-dr-report.md](M12-dr-report.md).
- Probes: `ProbeRunner` + HTTP login probe; quote / provisioning-mock / payment-sandbox / DNS-change probes are **not configured** (they need sandbox credentials: HG-03-02, HG-05-xx, HG-07-01) and are reported as `notConfigured`.
- TR-01..04 with `database_only` / `fixture` / `sandbox` / `live` evidence labels; a clean run writes an `in_sync` row.
- `OpsScheduler` (off by default, `OPS_SCHEDULER_INTERVAL_SECONDS`): SSO domain proofs, probes, alert evaluation, daily TR.
- **Not built:** read/write of `ops.launch_gates` and SLO editing (SCR-M12-03), provider-incident write endpoint (SCR-M12-08), request-level SLI feed (`api.error_rate_5m`) and the ZATCA backlog metric (alerts for them are NOT EVALUATED), a "billing close checklist run" endpoint (none exists; runbook `billing-close.md` is a human procedure), UI-M12-15 extension.

## D. Migrations and rollback
`1740`, `1750` with dev/staging-only `.down.sql`; production forward-fix.

## E. Tests run with actual results
See [M12-report.md §E](M12-report.md): `ops/ops.int.spec.ts` (13), `finrec/internal/rc05.spec.ts` (3), `chaos-drills.spec.ts`, `finrec.int.spec.ts` (M03, RC-01..06).

## F. Security, tenant isolation, billing, residency verification
Ops tables are admin-scope only (RLS + sweep: tenant session/API key refused on every admin route). Incident text excludes PII. DR backups/archives residency: NOT VERIFIED (no backup target exists).

## G. Human gates and live checks still needed
HG-03-02/03-03, HG-05-01..04, HG-07-01, HG-08-01 for live RC/TR; D-30/D-31 owner confirmation; HG-12-03 (runbook acceptance, on-call, drills); staging.

## H. Acceptance checklist
| Row | Status |
|---|---|
| AC-M12-08 DR RPO/RTO measured | NOT VERIFIED (local drill only; production/staging BLOCKED) |
| AC-M12-12 RC/TR on fixtures: 100 % injected discrepancies detected, clean data 0 variance | PASS on fixtures for TR-01..04 (ops.int.spec) and RC-01..06 (finrec.int.spec + rc05.spec); fixture evidence only |
| AC-M12-13 live sandbox reconciliation | BLOCKED (HG-05-xx, HG-07-01, HG-03-02) |
| AC-M12-14 ZATCA production | BLOCKED (HG-03-03) |
| AC-M12-18 runbooks each executed once | NOT VERIFIED (all marked NOT EXERCISED; HG-12-03) |

## I. Next-sprint handoff and open decisions
S58. Register the compute bill source in `BillSourceRegistry`; wire `api.error_rate_5m`; SCR-M12-03/-08.
