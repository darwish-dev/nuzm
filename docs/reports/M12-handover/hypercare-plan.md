# Hypercare plan (M12 S58) — PROPOSAL

Status: PROPOSAL 2026-11-18, NOT VERIFIED. Source: M12 §14 ("proposal: 2 weeks daily reconciliation review"). Applies only **after** the owner records a go decision (HG-12-03); this plan does not recommend or announce launch. Durations, times and thresholds are proposals for the owner to confirm. Roles, not names; roster per `on-call-roster-template.md`.

## Purpose
For the first two weeks after any production go-live, watch money, provider state and recovery readiness every day so defects surface within hours, not at the next billing close.

## Window
Day 0 = the UTC date the owner records go-live. Days 1-14 daily review; day 15 exit review. The owner may extend. Re-use the plan after any later major enablement (for example the first live PSP or ZATCA production onboarding: HG-03-02, HG-03-03).

## Daily review (proposal: 30 minutes, same time every day, UTC)
Attendees: FIN, L2 on-call, one L3 (rotating), SEC or CO as needed. Chair: IC-capable person. Scribe records outcomes in the incident system (or a ticket) with the date.
| # | Check | Where / runbook | Pass condition (proposal) |
|---|---|---|---|
| 1 | Previous UTC day's scheduled reconciliations RC-01..RC-06 finished; open breaks | `GET /v1/admin/billing/reconciliations`; `reconciliation-variance.md` | 0 unexplained breaks; each break has an owner |
| 2 | Technical reconciliation: orphans, unknown-state resources, drift | `GET /v1/admin/resources?driftState=...`; TR-01, TR-03, TR-04 | 0 orphaned billable resources; 0 unknown state older than 1 h |
| 3 | Ledger and wallet: imbalance, projection drift | `ledger-inspection.md`, RC-02, RC-06 | 0 |
| 4 | Payments: stuck `processing`, uncertain, late successes, refunds pending | `psp-outage.md`, `GET /v1/admin/billing/refunds?status=pending` | each has a decision |
| 5 | E-invoicing: queue, dead letters, window alerts, RC-05 | `zatca-backlog.md` | none outside policy |
| 6 | Queue and operations: backlog, `needs_reconcile`, worker health | `queue-recovery.md`; health view when shipped | draining; none stuck |
| 7 | Providers: health, breaker, provider incidents, spend vs cap | `provider-outage.md`; provider cost capture | no unreviewed change |
| 8 | Dunning and subscriptions: wrongful restrictions | `dunning.md`, `subscription-lifecycle.md` | 0 customer restricted in error |
| 9 | Security and audit: audit-chain verification result, alert review, tenant-isolation checks | worker job output | no `AUDIT_CHAIN_BROKEN`; no open SEV1/SEV2 security item |
| 10 | Support: new tickets by symptom, new playbook gaps | `support-playbooks.md` | gaps logged |
| 11 | Open incidents and actions from yesterday | incident system | owners and dates |
| 12 | Customer communications due | `communications-drafts.md` | sent or scheduled |

## Weekly additions (days 7 and 14)
Billing-close rehearsal for the week (`billing-close.md`); review of feature flags changed and why; check of backup and restore verification results (`db-restore.md`) and, if due, plan the first scheduled recovery exercise (`dr-restore.md`); access-review preparation (`access-review-process.md`); review of the blocked register for items now unblocked.

## Escalation during hypercare
Use `escalation-matrix.md`. During hypercare any money discrepancy of unknown cause is at least SEV3 and is escalated to FIN the same day; any ledger imbalance or duplicate monetary effect is SEV1.

## Exit criteria (proposal; owner decides)
- 14 consecutive daily reviews recorded (or the owner accepts exceptions in writing).
- No open SEV1 or SEV2; all breaks resolved or accepted with notes.
- Reconciliations clean for at least 7 consecutive days within D-31 tolerance (D-31 OPEN: proposal 0 minor units for RC-01/02/05/06, at most 0.5 % for RC-03/04 pending finance).
- Runbooks updated from what was learnt; support playbook gaps closed or listed.
- Hand-over to business-as-usual cadence: daily scheduled reconciliations with exception review, monthly billing close, quarterly access review (proposal), semiannual recovery exercise (proposal).

## Records
Daily notes (date, attendees by role, findings, actions), reconciliation run ids, incident ids, the exit review note. Status of this plan: NOT VERIFIED (not exercised).
