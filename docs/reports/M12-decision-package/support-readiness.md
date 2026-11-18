# Support readiness (M12 decision package)

Prepared by the agent 2026-11-18. **Every field in the "Human-completed fields" table is `HUMAN-COMPLETED: pending HG-12-03`.** The agent prepared materials; it cannot deliver training, record attendance, accept runbooks, fill the on-call roster, choose the support model or sign. AC-M12-20 (training delivered, runbooks accepted) and AC-M12-21 (decision recorded) are BLOCKED until a human sign-off exists. This file contains no recommendation to launch.

## Materials prepared by the agent (all DRAFT / PROPOSAL, NOT VERIFIED, none approved)

| Material | File | State |
|---|---|---|
| Runbook index (one line per runbook) | [../M12-handover/runbook-index.md](../M12-handover/runbook-index.md) | Draft; M12 runbooks marked not exercised |
| Support playbooks by symptom | [../M12-handover/support-playbooks.md](../M12-handover/support-playbooks.md) | Draft; no support team has used it |
| Escalation matrix | [../M12-handover/escalation-matrix.md](../M12-handover/escalation-matrix.md) | PROPOSAL pending D-29 (support model and SLA tiers OPEN) |
| On-call roster template | [../M12-handover/on-call-roster-template.md](../M12-handover/on-call-roster-template.md) | Template: placeholders only, no names or contact data |
| Training agenda | [../M12-handover/training-agenda.md](../M12-handover/training-agenda.md) | Agenda only; delivery and acceptance are human actions |
| Admin handbook outline | [../M12-handover/admin-handbook-outline.md](../M12-handover/admin-handbook-outline.md) | Outline; text to be written at documentation freeze |
| Customer FAQ, Arabic and English | [../M12-handover/customer-faq-ar-en.md](../M12-handover/customer-faq-ar-en.md) | Draft; not approved for publication; entries tagged `[AVAILABLE]` / `[IN PROGRESS]` / `[NOT AVAILABLE]` |
| Hypercare plan | [../M12-handover/hypercare-plan.md](../M12-handover/hypercare-plan.md) | PROPOSAL (2 weeks daily review); applies only after an owner go decision |
| Communications drafts | [../M12-handover/communications-drafts.md](../M12-handover/communications-drafts.md) | DRAFT, NOT VERIFIED; approval by the communications lead required before any use |
| Runbooks (16 M12 runbooks plus earlier ones) | `docs/runbooks/` (index: `docs/runbooks/README.md`; M12 list in [evidence-index.md](evidence-index.md)) | Drafts; none executed in a drill or tabletop (AC-M12-18) |

## Human-completed fields

Each row is for a named human to complete and sign outside the agent's control. Keep personal data (names, phone numbers) in the team's own system and reference it by id here, as `on-call-roster-template.md` instructs.

| Field | Value | Completed by (role) | Date (UTC) | Status |
|---|---|---|---|---|
| Support model and SLA tiers (D-29) | | Owner | | HUMAN-COMPLETED: pending HG-12-03 |
| Severity definitions and response times confirmed (escalation matrix) | | Owner / support lead | | HUMAN-COMPLETED: pending HG-12-03 |
| On-call roster reference (L2, L3, incident commander) | | Owner / engineering lead | | HUMAN-COMPLETED: pending HG-12-03 |
| Support staff list and role assignments (`support`, `finance`, `compliance_officer`, `security`) | | Owner | | HUMAN-COMPLETED: pending HG-12-03 |
| Training delivered (dates, sessions held, attendees by role) | | Training lead | | HUMAN-COMPLETED: pending HG-12-03 |
| Runbook acceptance by support/on-call (one line per runbook, with drill or tabletop date and notes) | | Support lead / on-call lead | | HUMAN-COMPLETED: pending HG-12-03 |
| Admin-realm accounts with MFA created for support staff (non-production first) | | Security | | HUMAN-COMPLETED: pending HG-12-03 |
| Ticketing / incident system of record named | | Owner | | HUMAN-COMPLETED: pending HG-12-03 |
| Escalation contacts verified (customer-facing, provider, legal, finance) | | Support lead | | HUMAN-COMPLETED: pending HG-12-03 |
| Communications lead named; draft notices approved | | Owner | | HUMAN-COMPLETED: pending HG-12-03 |
| Status/notification channel decided | | Owner | | HUMAN-COMPLETED: pending HG-12-03 |
| Customer FAQ and documentation reviewed (counsel for HG-04-01 items, tax advisor for HG-03-04 items) | | Communications lead / Legal / Tax advisor | | HUMAN-COMPLETED: pending HG-12-03 |
| Hypercare owner and daily-review attendees named | | Owner | | HUMAN-COMPLETED: pending HG-12-03 |
| Break-glass access procedure approved (needs the vault decision D-12) | | Security | | HUMAN-COMPLETED: pending HG-12-03 |
| Provider escalation paths (Alibaba, Huawei, Contabo, registrars, PSP, ZATCA) recorded | | Owner | | HUMAN-COMPLETED: pending HG-12-03 |
| Sign-off: support readiness accepted | | Owner (HG-12-03) | | HUMAN-COMPLETED: pending HG-12-03 |

## Facts from the repository that affect readiness (not decisions)

- Support model D-29 is OPEN in `docs/07`; the escalation matrix labels every severity and response time a proposal.
- The on-call roster, contact details and acceptance of the matrix are explicitly human deliverables (HG-12-03).
- Several support-relevant capabilities are drafted at design level: SSO lock-out recovery (`docs/runbooks/sso-lockout.md`) depends on SCRs not yet approved (`../M12-spec-change-requests.md`); incident record endpoints are planned, not confirmed (`incident-response.md`).
- No customer-visible email provider exists (D-08 OPEN; notices are in-app only), which affects any communication runbook.
- Register rows: BR-119 (training and acceptance, BLOCKED), BR-120 (go/no-go, BLOCKED). GA checklist: G-34.
