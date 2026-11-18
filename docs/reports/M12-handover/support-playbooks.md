# Support playbooks, indexed by symptom (M12 S58)

Status: DRAFT 2026-11-18. NOT VERIFIED: no support team has used this index (HG-12-03 PENDING). It links existing runbooks; it adds no procedures. Paths are relative to `docs/reports/M12-handover/`. L1 follows the first column's runbook up to the point it needs an admin mutation, then escalates (`escalation-matrix.md`). Never ask a customer for a password, card number, token or key.

## How to use
1. Find the symptom. 2. Open the runbook. 3. Check severity against `escalation-matrix.md`. 4. Record the ticket or incident id in every update. 5. If the symptom is not here, escalate to L2 and add it to this index after resolution.

## Accounts and access
| Symptom | Runbook |
|---|---|
| Customer cannot register, sign in with email and password, reset password, or verify email | [customer-accounts](../../runbooks/customer-accounts.md) |
| Whole organization cannot sign in after enabling single sign-on enforcement (only if SSO is enabled for them) | [sso-lockout](../../runbooks/sso-lockout.md) |
| Users not created or not removed from the customer's identity provider (only if SCIM is enabled for them) | [scim-failure](../../runbooks/scim-failure.md) |
| Staff need emergency data access | [break-glass-draft](../../runbooks/break-glass-draft.md) (BLOCKED until D-12) |
| Periodic review of who has access | [access-review-process](../../runbooks/access-review-process.md) |

## Cloud resources, hosting, data
| Symptom | Runbook |
|---|---|
| Server stuck provisioning, in unknown state, or an operation never finishes | [queue-recovery](../../runbooks/queue-recovery.md), [reconciliation](../../runbooks/reconciliation.md) |
| Provider region unavailable, offers missing | [provider-outage](../../runbooks/provider-outage.md), [provider-onboarding](../../runbooks/provider-onboarding.md) |
| Suspected leftover billable resource | [orphan-handling](../../runbooks/orphan-handling.md) |
| Website failed, restore stuck, backup corrupt | [site-recovery](../../runbooks/site-recovery.md) |
| Hosting node being drained or maintained | [drain-and-migrate](../../runbooks/drain-and-migrate.md), [node-onboarding](../../runbooks/node-onboarding.md) |
| Site removal and data export window | [offboarding](../../runbooks/offboarding.md) |
| Database backup or restore, failed restore drill | [db-restore](../../runbooks/db-restore.md) |
| Self-operated database node lost | [db-failover](../../runbooks/db-failover.md) |
| Storage bucket public by mistake, leaked link | [storage-incident](../../runbooks/storage-incident.md) |
| Quota reached, spend approval waiting | [quotas-and-spend-approvals](../../runbooks/quotas-and-spend-approvals.md) |

## Domains and DNS
| Symptom | Runbook |
|---|---|
| Domain order waiting on the registrar | [domains-reconcile](../../runbooks/domains-reconcile.md) |
| Registrar outage or rate limiting | [domains-registrar-outage](../../runbooks/domains-registrar-outage.md) |
| DNS zone shows a degraded banner and cannot be changed | [dns-degraded-zone](../../runbooks/dns-degraded-zone.md) |

## Email
| Symptom | Runbook |
|---|---|
| Messages throttled or not delivered | [email-deliverability](../../runbooks/email-deliverability.md) |
| Address wrongly suppressed or customer asks to remove | [suppression-handling](../../runbooks/suppression-handling.md) |

## Billing, payments, invoices
| Symptom | Runbook |
|---|---|
| Card payment failing for many customers, payments stuck in processing | [psp-outage](../../runbooks/psp-outage.md), [psp-incident](../../runbooks/psp-incident.md) |
| Customer says they paid twice or got duplicate notices | [webhook-storm](../../runbooks/webhook-storm.md), [ledger-inspection](../../runbooks/ledger-inspection.md) |
| Subscription not renewed or still past due after paying | [subscription-lifecycle](../../runbooks/subscription-lifecycle.md), [dunning](../../runbooks/dunning.md) |
| Wrong invoice amount or details | [invoice-correction](../../runbooks/invoice-correction.md), [tax-and-invoice-numbering](../../runbooks/tax-and-invoice-numbering.md) |
| Refund request | [refund-procedure](../../runbooks/refund-procedure.md) |
| Balance or usage looks wrong | [ledger-inspection](../../runbooks/ledger-inspection.md), [rebuild-projections](../../runbooks/rebuild-projections.md), [metering-replay](../../runbooks/metering-replay.md) |
| Reconciliation shows a variance | [reconciliation-variance](../../runbooks/reconciliation-variance.md), [reconciliation-break-handling](../../runbooks/reconciliation-break-handling.md) |
| Period-end checks | [billing-close](../../runbooks/billing-close.md) |
| E-invoices waiting, rejected or past the reporting window | [zatca-backlog](../../runbooks/zatca-backlog.md), [zatca-queue-stuck](../../runbooks/zatca-queue-stuck.md) |
| Price book change | [pricebook-release](../../runbooks/pricebook-release.md) |

## Security, privacy, abuse
| Symptom | Runbook |
|---|---|
| Possible data exposure or breach | [data-breach-workflow](../../runbooks/data-breach-workflow.md), [breach-handling](../../runbooks/breach-handling.md) |
| Customer asks for access to, correction or deletion of data, or an export | [dsr-handling](../../runbooks/dsr-handling.md) |
| Records must be preserved (counsel instruction) | [legal-hold](../../runbooks/legal-hold.md) |
| Abuse report, spam or phishing from our infrastructure, legal takedown request | [abuse-takedown](../../runbooks/abuse-takedown.md), [abuse-handling](../../runbooks/abuse-handling.md) |
| Suspected escape from a customer-code sandbox (design-level; M10 not on this branch) | [sandbox-escape-suspected](../../runbooks/sandbox-escape-suspected.md) |
| Flood of webhook or API requests | [webhook-storm](../../runbooks/webhook-storm.md) |

## Platform-wide
| Symptom | Runbook |
|---|---|
| Anything declared SEV1 or SEV2 | [incident-response](../../runbooks/incident-response.md) |
| Data loss, restore needed, region loss | [dr-restore](../../runbooks/dr-restore.md) |
| Which runbook exists for X | [runbook-index](runbook-index.md) |
