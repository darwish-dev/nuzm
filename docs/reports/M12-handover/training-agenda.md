# Support and on-call training agenda (M12 S58)

Status: DRAFT 2026-11-18. **This file is an agenda only.** Delivering the training, attendance and acceptance of the runbooks by support and on-call staff are human actions under HG-12-03 (PENDING); the agent cannot deliver or accept them. AC-M12-20 stays BLOCKED until a sign-off exists. Durations are proposals. Training uses the Arabic and English interfaces and non-production data only.

## Audience and prerequisites
L1 support, L2 on-call engineers, finance and compliance counterparts, security officer. Prerequisites: admin-realm account with MFA (non-production first), reading of `escalation-matrix.md`, `docs/runbooks/README.md` and `runbook-index.md`.

## Sessions
| # | Topic | Content | Hands-on (non-production) | Runbooks | Time (proposal) |
|---|---|---|---|---|---|
| 1 | Platform tour | Portals (customer, admin), tenancy, roles, audit trail, feature flags, residency idea | Browse admin console in AR and EN | `local-setup.md`, `customer-accounts.md` | 90 min |
| 2 | Incident handling | Severity, roles, timeline, communication cadence, blameless review | Tabletop: declare, assign, update, close | `incident-response.md` | 120 min |
| 3 | Operations and queues | Worker, outbox, operations states, reconcile-before-retry | Read a stuck operation and decide the next step | `queue-recovery.md`, `reconciliation.md`, `orphan-handling.md` | 90 min |
| 4 | Providers and domains | Provider health, breaker, offers, registrar outage, DNS degraded zone | Disable an account on the mock provider, verify, reconcile | `provider-outage.md`, `domains-registrar-outage.md`, `dns-degraded-zone.md` | 90 min |
| 5 | Money | Ledger principles, reconciliation RC-01..RC-06, breaks, billing close, dunning, refunds | Run reconciliations on fixtures, resolve a break | `reconciliation-variance.md`, `billing-close.md`, `dunning.md`, `refund-procedure.md` | 150 min |
| 6 | Payments and e-invoicing | PSP uncertain results, webhooks, ZATCA queue (simulated) | Replay duplicate webhooks on the sandbox PSP | `psp-outage.md`, `psp-incident.md`, `webhook-storm.md`, `zatca-backlog.md` | 120 min |
| 7 | Security and compliance | Breach workflow, DSR, legal hold, break-glass principles, abuse and takedown | Breach tabletop with counsel placeholders | `data-breach-workflow.md`, `breach-handling.md`, `dsr-handling.md`, `abuse-takedown.md`, `sandbox-escape-suspected.md` (design-level) | 150 min |
| 8 | Enterprise identity | SSO, SCIM, access reviews (only as far as implemented and flagged on) | Walk the lock-out decision tree on paper | `sso-lockout.md`, `scim-failure.md`, `access-review-process.md` | 90 min |
| 9 | Recovery | Backup and restore per store, RPO/RTO targets and how they are measured | Observe or run a restore drill in a scratch environment | `dr-restore.md`, `db-restore.md`, `site-recovery.md` | 120 min |
| 10 | Communication | Customer notices in Arabic and English, what never to say | Edit the drafts for a scenario | `communications-drafts.md` | 60 min |

## Competency check (proposal)
Each trainee completes one tabletop scenario from sessions 2, 5 and 7 and answers five questions per runbook family. A trainer records pass/fail per trainee. Content of tests is kept outside this file.

## Acceptance (human; placeholders)
| Item | Owner | Date | Status |
|---|---|---|---|
| Training delivered (attendance list ref) | `<trainer>` | `<date>` | NOT VERIFIED |
| Runbooks accepted by support/on-call (list) | `<support lead>` | `<date>` | NOT VERIFIED |
| Drills executed once per runbook (AC-M12-18) | `<SRE lead>` | `<date>` | NOT VERIFIED |
| Owner sign-off (HG-12-03) | `<owner>` | `<date>` | BLOCKED (HG-12-03) |
