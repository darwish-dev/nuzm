# Runbook — reconciliation variance (RC-01..RC-06, TR-01..TR-04) (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED live. Builds on `reconciliation-break-handling.md` (financial, M03) and `reconciliation.md` (technical, M05): read those first; this runbook is the cross-cutting operating procedure for M12. Tolerances are PROPOSALS pending D-31 (finance): 0 minor units for RC-01, RC-02, RC-05, RC-06; basis points for RC-03 and RC-04 (`FINREC_RC03_TOLERANCE_BPS`, `FINREC_RC04_TOLERANCE_BPS`, default 0; M12 proposal at most 0.5 % pending finance).

## Purpose
Decide what to do when a reconciliation run reports a variance, from detection to a recorded resolution, without ever editing the ledger, documents or provider state directly.

## Trigger / alert
Audit event `finrec.break.sla_breached` (break older than `FINREC_SLA_DAYS`, default 7 days; docs/11 proposes 5 business days); a run with breaks in `GET /v1/admin/billing/reconciliations`; a technical drift or orphan case (`GET /v1/admin/resources?driftState=...`); hypercare daily review (`docs/reports/M12-handover/hypercare-plan.md`).

## Severity guidance (proposal)
- SEV1: ledger imbalance, a payment without a ledger link, or a duplicate monetary effect.
- SEV2: RC-01 or RC-05 break affecting several customers; a billable orphan resource; a run that cannot read its source for more than one cycle.
- SEV3: a single RC-03/RC-04 variance within investigation; SEV4: rounding accepted with a note.

## Preconditions / access
Admin realm with MFA and step-up. Finance (`admin:billing:read`, run and resolve needs `admin:billing:manage`), compliance officer (read), cloud admin for technical reconcile. Adjustments need two different people (request and approve).

## Steps
1. **Run** when needed: `POST /v1/admin/billing/reconciliations` with `{types[], periodFrom, periodTo}` (at most 400 days, not in the future) answers 202; one run per type; 409 if one is in progress. Scheduled runs: daily for the previous UTC day. Technical: `POST /v1/admin/resources/{id}/reconciliations` (202) for TR-01/TR-04 resources, `POST /v1/admin/domains/{id}/reconciliations` for TR-03; TR-02 (hosting nodes and sites vs node report) is **not built** (M06 report): record as NOT VERIFIED.
2. **Read the run.** `GET /v1/admin/billing/reconciliations/{id}`. Results are immutable; a failed run (unreadable source) is also immutable: fix the source and run again.
3. **Classify each break** by type (tables in `reconciliation-break-handling.md` §1) and decide the owner:
   - RC-01 (payments vs PSP): finance with the PSP; sandbox PSP only until HG-03-02.
   - RC-02 and RC-06: finance plus platform engineering (projection drift is rebuilt, `rebuild-projections.md`; ledger entries are corrected only by reversing entries, `reversing-adjustment.md`).
   - RC-03: metering (`metering-replay.md`) before invoice corrections (`invoice-correction.md`).
   - RC-04: provider costs (`provider-cost-capture.md`); bill comparison skipped until a bill source exists (NOT VERIFIED).
   - RC-05: `zatca-backlog.md`. TR-01/TR-04: `provider-outage.md`, `orphan-handling.md`. TR-03: `domains-reconcile.md`.
4. **Assign** (`POST /v1/admin/billing/reconciliations/{id}/resolutions` `{itemId, action: assign}`) then **resolve** with `adjustment` (an APPROVED adjustment from `POST /v1/admin/billing/adjustments`, same organization) or `accept` with a note that says why. Resolved is final.
5. **Never** edit documents, ledger rows, projections, counters or provider resources directly. A suspected orphan is not deleted by the reconciler unless the explicit flag is on (it is off by default).
6. **Re-run** the same type and period after the fix; a clean run (0 variance within tolerance) is the closing evidence.
7. **Pattern check.** Two breaks of the same kind in one week: open an engineering ticket and an incident review (`incident-response.md`).

## Verification
The re-run shows 0 breaks within the D-31 tolerance; open breaks older than the SLA are 0 or each has an owner and note; TR-01 shows 0 orphaned billable resources and 0 unknown-state resources older than 1 h; the audit trail shows the assignment and resolution (who, when, why).

## Escalation
Finance lead (owner of D-31 values and of accepts); L2 on-call engineer for projection or consumer faults; L3 domain owner for adapter issues; compliance officer if a document, counter or chain was changed or is suspected altered (compliance incident); owner for any accept above the amount the finance lead is willing to approve alone (threshold to be set by finance).

## Communication draft
Internal (finance channel), EN: "RC-0X for [period] shows [N] break(s), total [amount, currency]. Owner: [role]. Cause: [known/unknown]. Customer impact: [none/describe]. Next update: [time] UTC."
AR: "أظهرت المطابقة RC-0X للفترة [الفترة] وجود [العدد] فروقات بإجمالي [المبلغ والعملة]. المسؤول: [الدور]. السبب: [معروف/غير معروف]. الأثر على العملاء: [لا يوجد/وصف]. التحديث التالي: [الوقت] بالتوقيت العالمي المنسّق."
If customers are affected (for example a corrected invoice), use the templates in `communications-drafts.md` and `invoice-correction.md`.

## Records to keep
Run ids and results, resolution rows (who, when, why), adjustment ids and approvers, accepted-variance notes, re-run ids, TR results (`cloud.resource_reconciliations`). Summarise in `docs/reports/M12-reconciliation-report.md` at gate time.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). Planned drill: injected discrepancies (missing resource, extra resource, cost variance, duplicate PSP event, unsubmitted ZATCA invoice) must each be detected and routed to resolutions (AC-M12-12).
