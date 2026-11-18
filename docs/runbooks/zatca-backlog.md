# Runbook — e-invoicing (ZATCA) backlog (M12 S57)

Status: DRAFT 2026-11-18. **SIMULATED ONLY, NOT VERIFIED vs ZATCA.** The ZATCA server in this repository is a simulation; production onboarding and clearance (HG-03-03, AC-M12-14) are BLOCKED. This runbook adds the M12 operating view on top of `zatca-queue-stuck.md` (queue states, retry rules) and `zatca-onboarding.md` / `zatca-key-rotation.md`. Read those first; nothing is duplicated here.

## Purpose
Clear a backlog of invoices waiting for credentials, clearance or reporting, within the reporting window, without resubmitting decided documents or altering any document, hash, counter or chain.

## Trigger / alert
Alert `zatca.clearance_unavailable`; submissions in `queued` with growing `lastError`; `windowAlert` (more than 50 % of the reporting window passed) or `windowBreached` (100 %) on simplified invoices; RC-05 breaks (`no_einvoice`, `rejected`, `dead_letter`, `not_cleared_in_window`, `counter_gap`); standard invoices held and not delivered.

## Severity guidance (proposal)
SEV2: a window breach or a growing dead-letter queue; SEV1: a counter gap or chain break (treat as a compliance incident, `compliance officer` and `security` informed at once); SEV3: backlog within the window and shrinking.

## Preconditions / access
Finance and security roles, admin realm, MFA; retry needs step-up (`POST /v1/admin/billing/zatca/submissions/{id}/retry`, permission `admin:zatca:manage`). Credentials live in the vault by reference only; never paste vault contents into a ticket.

## Steps
1. **Size the backlog.** `GET /v1/admin/billing/zatca/submissions` filtered by `state`, `org`, `deadLetter`. Group by state (table in `zatca-queue-stuck.md` §1).
2. **Is the scheduler running?** E-invoicing runs inside the billing scheduler tick (`BILLING_SCHEDULER_INTERVAL_SECONDS`, off by default). No tick, no submissions. Ticks are idempotent and serialized by an advisory lock.
3. **Credentials.** Many `generated` means no credential: finish onboarding (`zatca-onboarding.md`). Expiring or rotated key: `zatca-key-rotation.md` records that rotation is **not built** (it needs the official ZATCA rules, HG-03-03): escalate to finance and the tax advisor instead of improvising.
4. **Server unavailable** (`queued` + `unavailable`): wait with the built-in backoff (60 s, 120 s, 240 s, ... `ZATCA_BACKOFF_SECONDS`; dead letter after `ZATCA_MAX_ATTEMPTS`, default 6). A `timeout` answer: the platform asks the server about the document first and adopts a decision that exists.
5. **Clock skew.** A submission failing for time reasons needs the host clock checked (NTP) before any retry; M12 includes a clock-skew drill on submit.
6. **Dead letters** (`error` + `deadLetter`): fix the cause, then retry (fresh attempt budget; idempotent per document). **Never** retry a `rejected` document or resubmit a `cleared`/`reported` one: a rejected document needs human review and correction by credit note and new invoice (`invoice-correction.md`).
7. **Window breach:** escalate (below), record the cause, and let compliance decide on any regulator contact (the platform never contacts a regulator; HG-04-01, HG-04-02).
8. **After clearing:** run RC-05 for the period (`POST /v1/admin/billing/reconciliations` with `RC-05`): issued documents vs e-invoices and the counter chain. RC-05 is skipped when e-invoicing is off or there is no cutover date.

## Verification
No `queued` older than the backoff schedule explains; dead letters 0 or each with a decision; no window alerts; RC-05 run with 0 breaks (simulated data is labelled NOT VERIFIED vs ZATCA); counters gapless.

## Escalation
Finance lead (owner); tax advisor and counsel via the compliance officer for regulatory questions (HG-03-03, HG-03-04, HG-04-01); L2 on-call for scheduler or clock problems; L3 billing owner for adapter or signing defects.

## Communication draft
Customer-facing only when delivery of standard invoices is delayed:
EN: "Delivery of some invoices is delayed because an external tax-authority service is unavailable. Your invoices will be sent as soon as they are cleared. No action is needed. Reference: [incident id]."
AR: "تأخّر إرسال بعض الفواتير بسبب عدم توفّر خدمة خارجية تابعة للجهة الضريبية. ستصلكم فواتيركم فور اعتمادها، ولا يلزمكم أي إجراء. المرجع: [رقم الحادثة]."
(Wording to be reviewed by the tax advisor before use: HG-03-04.)

## Records to keep
Queue extract by state with timestamps (no document content), retry actions (audited), RC-05 run ids, window-breach cause, the correction documents issued, the decision on any regulator contact.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18).
