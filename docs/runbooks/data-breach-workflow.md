# Runbook — personal-data breach workflow (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED. **Nothing here is legal advice and nothing has been reviewed by counsel.** Whether, when, to whom and in what words to notify is decided by people with counsel (HG-04-01, PENDING). Legal notification deadlines are **supplied by counsel**: per published PDPL / regulator rules, verify against current official text with counsel. The 24 / 48 / 72-hour values in `spec/compliance/defaults.yaml` are placeholders that only show what is overdue. NCA/CST applicability and filings are HG-04-02 (PENDING).
This runbook is the incident-level wrapper around the case tool described in `breach-handling.md` (read it first: states, roles, evidence pack). DSR work is `dsr-handling.md`.

## Purpose
Run a suspected or confirmed personal-data breach from detection to closure with clear ownership, evidence, timers and decisions, linked to the incident record.

## Trigger / alert
Suspected exposure of personal data: unauthorised access, mis-sent data, lost credential with access to data, cross-tenant read, sandbox escape (`sandbox-escape-suspected.md`), leaked signed URL or public bucket (`storage-incident.md`), vendor notification, internal finding, a customer or researcher report.

## Severity guidance
Open the case at the first reasonable suspicion, SEV1 incident until scope is known. Lowering requires the compliance officer's recorded triage.

## Preconditions / access
Roles `compliance_officer`, `security`, `platform_admin` can open and move a case (`admin:breach:manage`) in the admin console with MFA and recent verification. The **assessor and the notification decision-maker must be different people** (403 otherwise). The evidence pack reads across organizations: it needs a stated reason and is audited.
Counsel contact: `<counsel: to be filled, HG-04-01>`. DPO: `<to be filled, HG-04-01>`.

## Steps
1. **Contain first** under `incident-response.md` (reversible actions; preserve evidence).
2. **Open the case:** `POST /v1/admin/compliance/breach-cases` with an `Idempotency-Key`: `{summary (10-2000 chars), detectedAt (not in the future), severity, linkedIncidentId}`. The case starts at `detected`. Record the detection time exactly: timers run from it.
3. **Triage** (`transition: triaged`) with severity.
4. **Assess** (`assessed`): personal data affected or not, scope, data classes (required when affected), regions, organization ids, tables. Use `GET /v1/admin/compliance/breach-cases?id=<case>&pack=true&reason=<why>` for the audit evidence from 24 h before detection.
5. **Decide** (`notification_decision`) by a different person from the assessor: notify or not, rationale, who (required if notifying). Obtain counsel's advice on deadlines, thresholds and recipients **before** this step (placeholder: `<counsel advice reference: to be filled>`). Residency and transfer questions go to counsel (HG-04-01).
6. **Notify** is done by humans outside the platform (regulator portal, letters, email). Record it: `notified` with when and a reference. The platform never contacts a regulator or customer itself.
7. **Remediate** (`remediation`) with the actions; **close** (`closed`) with the outcome. Every move carries `baseVersion` and an `Idempotency-Key` (409 on conflict: reload).
8. **Review:** lessons learned, control gaps, updates to this runbook and the ROPA; DSR impacts (`dsr-handling.md`); legal hold if counsel instructs (`legal-hold.md`).
9. **Configurable timers:** the M12 design encodes configurable timers and notification templates; legal values come from counsel and are entered by the compliance officer, not guessed by engineers.

## Verification
Case states advanced in order with timeline entries (append-only); the decision recorded by a different person than the assessor; notification reference present when notified; incident id linked; evidence pack digest stored; counsel's written advice reference attached.

## Escalation
Compliance officer / DPO (owner of the case) → counsel → owner. Security officer for technical scope. L3 engineering lead for remediation. Finance lead if payment data is touched (the platform stores no card data: `psp-incident.md`).

## Communication draft (templates for counsel review; do not send unreviewed)
Customer notice, EN: "On [date] we detected [short factual description]. The information involved may include [data categories]. We have [actions taken]. You can [recommended steps]. Contact: [contact channel]. Reference: [case id]."
AR: "بتاريخ [التاريخ] اكتشفنا [وصف موجز ومحدد للواقعة]. قد تشمل المعلومات المتأثرة [فئات البيانات]. وقد اتخذنا [الإجراءات المتخذة]. يمكنكم [الخطوات الموصى بها]. للتواصل: [قناة التواصل]. المرجع: [رقم القضية]."
Regulator notification: text and channel are prepared by counsel (`<regulator and channel: to be filled by counsel>`); this repository holds no regulator template.
More drafts: `docs/reports/M12-handover/communications-drafts.md`.

## Records to keep
The breach case (timeline, assessment, decision, notification reference, closure), the evidence pack and its SHA-256 digest, counsel advice reference, the incident record, audit events `compliance.breach.opened|transition|evidence_pack`. Retention per D-34 (counsel, OPEN).

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18; compliance hook "breach-notification workflow exercised" in M12 §15 is also open).
