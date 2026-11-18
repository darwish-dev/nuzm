# Runbook — incident response (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED: never exercised. Severity definitions and response times are PROPOSALS pending D-29 (see `docs/reports/M12-handover/escalation-matrix.md`). The on-call roster is HG-12-03 (PENDING). Endpoints marked *(planned)* are declared in `docs/04` §2.12 and `spec/openapi/planned-paths.yaml` but are **not yet in `spec/openapi/openapi.yaml`** on this branch: confirm the final contract after the M12 code merges.

## Purpose
Give every responder one way to declare, run, communicate and close an incident, whatever the cause. Specific causes have their own runbooks (linked in Steps).

## Trigger / alert
- An alert in the ops console (`/v1/admin/alerts`, *planned*) or a worker/API log line (for example `AUDIT_CHAIN_BROKEN`, `zatca.clearance_unavailable`, `data.restore_verification_failed`, `finrec.break.sla_breached`).
- A synthetic-probe failure (login, quote, provisioning-mock, payment-sandbox, DNS change: S57 plan, *planned*).
- A customer report through support, a provider status notice, or an internal observation.
- Availability objective: 99.9 % monthly for the control-plane API, RPO 15 min, RTO 4 h (D-30 decided 2026-11-15; evidenced only by the M12 DR exercise).

## Severity guidance (proposal, D-29 OPEN)
| Level | Use when |
|---|---|
| SEV1 | Platform-wide outage; suspected tenant-isolation failure or personal-data exposure; money or ledger integrity at risk; sandbox escape suspected |
| SEV2 | Major feature down for many customers (billing, provisioning, a whole provider); a recovery target is at risk |
| SEV3 | Degraded feature or single-customer impact with a workaround |
| SEV4 | Cosmetic or low-impact defect, no customer action needed |
When unsure, choose the higher level and lower it later (CLAUDE.md §11). Full definitions: `escalation-matrix.md`.

## Preconditions / access
- Admin realm session with MFA and recent step-up for any mutation (`docs/04`); roles: `platform_admin`, `support`, `finance`, `compliance_officer`, `security`.
- Break-glass is a last resort and is **BLOCKED** until D-12 and the legal basis are decided: see `break-glass-draft.md`. Two people, time-boxed, audited.
- Incident record: `POST /v1/admin/incidents` *(planned, permission `admin:ops` per the M12 prompt; to be confirmed)*. Until it ships, use the team's ticket system and copy the record into the incident tool afterwards.

## Steps
1. **Declare.** Whoever sees it opens the incident: severity, title, affected components, start time (UTC), reporter role. No raw personal data, no secrets, no card data in the record. The first responder becomes incident commander (IC) until handed over by name in the timeline.
2. **Assign roles.** IC, operations lead (does the technical work), communications lead, scribe. For SEV1/SEV2 page L2 and notify L3 (see escalation matrix).
3. **Stabilise before diagnosing.** Stop the bleeding with reversible actions only: feature flag off (`PUT /v1/admin/feature-flags`, permission `admin:flags:manage`, audited with before/after), provider account disabled (`PATCH /v1/admin/provider-accounts/{id}`), dunning hold (`PATCH /v1/admin/billing/dunning/{id}`). Do not disable safeguards, edit ledger, audit or documents, or run SQL against production data.
4. **Route to the specific runbook:**
   - provider or registrar down: `provider-outage.md`, `domains-registrar-outage.md`
   - queue, outbox or operation backlog: `queue-recovery.md`
   - duplicate or flooding callbacks: `webhook-storm.md`
   - payments: `psp-outage.md`, `psp-incident.md`
   - e-invoicing backlog: `zatca-backlog.md`, `zatca-queue-stuck.md`
   - money mismatch: `reconciliation-variance.md`, `reconciliation-break-handling.md`
   - database or region loss: `db-failover.md`, `dr-restore.md`
   - suspected sandbox escape: `sandbox-escape-suspected.md`
   - personal-data exposure: `data-breach-workflow.md` (open the breach case in parallel, `POST /v1/admin/compliance/breach-cases`, `linkedIncidentId` = the incident id)
   - SSO or SCIM: `sso-lockout.md`, `scim-failure.md`
   - hosting abuse: `abuse-takedown.md`
5. **Record as you go.** Every decision, command-equivalent action and observation goes in the timeline with a UTC time (`PATCH /v1/admin/incidents/{id}`, *planned*).
6. **Communicate** on the cadence for the level (proposal: SEV1 every 30 min, SEV2 every 60 min) using `docs/reports/M12-handover/communications-drafts.md`. Customer text is approved by the communications lead; it states facts and the next update time, never blame or unverified causes.
7. **Resolve.** Confirm recovery with the Verification checks, lower the severity or close, and send the final notice.
8. **Review.** Blameless review within 5 working days (proposal): timeline, root cause, what detected it, what slowed it, actions with owners. Update the runbook used.

## Verification
- The affected synthetic probe passes and the health view (`GET /v1/admin/operations/health`, *planned*) shows the component healthy.
- No growing backlog: operations and outbox drain (`queue-recovery.md`).
- Money: RC-01..RC-06 run for the incident window show no new unexplained break (`reconciliation-variance.md`).
- Audit chain verified (worker job; `restore-db-from-dump.md` shows the verifier invocation).

## Escalation
L1 support → L2 on-call engineer → L3 engineering lead / domain owner. Parallel: security officer (any suspected breach, isolation or sandbox issue), compliance officer / DPO (personal data), finance lead (money), counsel (legal notification, via the compliance officer), owner (SEV1, go/no-go related). Contacts are placeholders until HG-12-03: `<L2 on-call: to be filled>`, `<IC backup: to be filled>`.

## Communication draft
EN: "We are investigating an issue affecting [service] since [time] UTC. [Impact in one sentence.] We will update you by [time] UTC. Reference: [incident id]."
AR: "نحقّق حاليًا في مشكلة تؤثر على [الخدمة] منذ [الوقت] بالتوقيت العالمي المنسّق. [وصف الأثر في جملة واحدة.] سنوافيكم بالمستجدات قبل [الوقت] بالتوقيت العالمي المنسّق. المرجع: [رقم الحادثة]."
More drafts (resolved, maintenance, breach): `communications-drafts.md`.

## Records to keep
Incident record and timeline (audit events `incident.opened|closed`, *planned*), the feature-flag, provider-account and dunning audit events, links to evidence (log excerpts without PII, screenshots without secrets), the review notes, and any breach case id. Evidence references go in `docs/reports/evidence-index.md` when they support a gate.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18)
