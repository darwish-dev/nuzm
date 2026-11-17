# Runbook — breach cases (M04 S15)

A breach case records what happened, who decided what, and when. **The platform never contacts a regulator, a customer or anyone else.** Whether, when and whom to notify is decided by people with counsel (HG-04-01); the deadlines on screen are placeholders from `spec/compliance/defaults.yaml` (24 / 48 / 72 hours from detection) and only show what is overdue.

Roles: the compliance officer, security and platform admin can read; the same three can open and move a case (`admin:breach:manage`), in the admin console, with MFA and a recent verification. (The prompt names `security_officer`; the catalogue role is `security`: SI-M04-5.)

## States
`detected → triaged → assessed → notification_decision → notified → remediation → closed`. Only the next state is allowed. After the decision only the branch that was decided is allowed: a decision **not** to notify goes to `remediation`; a decision **to** notify goes to `notified`, which records that people notified. The timeline is append-only (a database guard), a closed case cannot change, and every move is audited (`compliance.breach.opened|transition`).

## Steps
1. **Open** (`POST /v1/admin/compliance/breach-cases` with an Idempotency-Key): summary (10–2000 characters), detection time (not in the future), severity, an optional incident id. The case starts at `detected`.
2. **Triage** → `triaged`. May raise or lower the severity.
3. **Assess** → `assessed`: was personal data affected, the scope, the data classes (required when personal data is affected), regions, the organization ids and the tables involved. The assessor is recorded.
4. **Decide** → `notification_decision`: notify or not, the rationale, and who is to be notified (required when notifying). **A different person than the assessor must make this decision** (403 otherwise).
5. **Record the notification** → `notified` (only after a decision to notify): when it was sent and a reference (letter number, portal receipt). The platform records that you did it; it does not do it.
6. **Remediation** → `remediation` with a note of the actions. **Close** → `closed` with a note of the outcome.

Every move carries the case `baseVersion` (409 if someone else moved it first: reload) and an Idempotency-Key (a replayed move returns the case).

## The evidence pack
`GET /v1/admin/compliance/breach-cases?id=<case>&pack=true&reason=<why you are reading>`. It reads the audit trail of each organization named in the assessment from 24 hours before detection until now (counts per action and outcome, first and last time) and returns it with the timeline, assessment, decision and a SHA-256 digest. Because it reads across organizations it needs a reason (10–300 characters) and is itself audited (`compliance.breach.evidence_pack`, with the reason). The pack is a compilation for people to review and attach; it is not a regulator filing.

## What this does not do
No notification emails or filings, no automatic severity, no link to an incident tool yet (the incident id is an opaque reference; M12 adds incident tooling), no statutory deadline logic (HG-04-01), no customer-facing breach page.
