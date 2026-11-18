# Runbook index (M12 S58)

Status: DRAFT 2026-11-18, generated from the contents of `docs/runbooks/` on branch `claude/m12-hardening-4cc95e`. One line per file; for the symptom-based view use `support-playbooks.md`. `docs/runbooks/README.md` is maintained separately. "M12" = written in S57 and **NOT EXERCISED (drill pending, AC-M12-18)**; every other runbook carries its own status line (mock, sandbox or fixture evidence only; live rows NOT VERIFIED/BLOCKED). Paths are relative to `docs/reports/M12-handover/`.

## M12 operations and incident runbooks (new)
| File | Purpose |
|---|---|
| [incident-response](../../runbooks/incident-response.md) | Declare, run, communicate and close an incident; severity and roles (D-29 proposals) |
| [provider-outage](../../runbooks/provider-outage.md) | Handle a cloud provider outage without duplicate billable resources |
| [queue-recovery](../../runbooks/queue-recovery.md) | Recover the outbox relay, workers and stuck operations (queues are PostgreSQL tables today) |
| [webhook-storm](../../runbooks/webhook-storm.md) | Duplicate, flooding or out-of-order webhooks (PSP, registrar, email) |
| [reconciliation-variance](../../runbooks/reconciliation-variance.md) | Cross-cutting procedure for RC-01..RC-06 and TR-01..TR-04 variances |
| [billing-close](../../runbooks/billing-close.md) | Period-end checklist proving usage, ledger, payments, costs and e-invoices tie out |
| [zatca-backlog](../../runbooks/zatca-backlog.md) | Clear an e-invoicing backlog within the reporting window (simulated only) |
| [psp-outage](../../runbooks/psp-outage.md) | Operate through a payment provider outage (sandbox PSP only today) |
| [sandbox-escape-suspected](../../runbooks/sandbox-escape-suspected.md) | Contain a suspected escape from a customer-code sandbox (design-level; M10 not on this branch) |
| [data-breach-workflow](../../runbooks/data-breach-workflow.md) | Incident-level wrapper for personal-data breaches with counsel placeholders |
| [dr-restore](../../runbooks/dr-restore.md) | Per-data-store restore and recovery exercises; D-30 targets; recording in recovery exercises |
| [sso-lockout](../../runbooks/sso-lockout.md) | Recover an organization locked out by SSO enforcement (design-level; SSO flagged off) |
| [scim-failure](../../runbooks/scim-failure.md) | Diagnose SCIM provisioning and deprovisioning failures (design-level; SCIM flagged off) |
| [abuse-takedown](../../runbooks/abuse-takedown.md) | Abuse reports and takedown decisions, appeals and legal orders |
| [access-review-process](../../runbooks/access-review-process.md) | Periodic access review campaigns and revocation evidence |

## Identity, access, security
| File | Purpose |
|---|---|
| [break-glass-draft](../../runbooks/break-glass-draft.md) | Draft break-glass access policy (BLOCKED until vault decision D-12) |
| [customer-accounts](../../runbooks/customer-accounts.md) | Customer email and password sign-in, registration, reset, verification |
| [rotating-dev-secrets](../../runbooks/rotating-dev-secrets.md) | Rotate development stand-in secrets (not production) |
| [field-encryption](../../runbooks/field-encryption.md) | Field-level encryption of the personal part of tax profiles |
| [node-agent-threat-model](../../runbooks/node-agent-threat-model.md) | Design and threat model of the hosting node agent (proposal) |

## Compliance and privacy
| File | Purpose |
|---|---|
| [breach-handling](../../runbooks/breach-handling.md) | Breach case states, roles and evidence pack |
| [dsr-handling](../../runbooks/dsr-handling.md) | Data-subject requests and organization data exports |
| [legal-hold](../../runbooks/legal-hold.md) | Place, approve and release a two-person legal hold |
| [retention-archival](../../runbooks/retention-archival.md) | Retention policies, dry run and break-glass partition detach |
| [compliance-evidence](../../runbooks/compliance-evidence.md) | Control register and evidence collection (no compliance claims) |
| [residency-hooks](../../runbooks/residency-hooks.md) | How modules must call the residency service |

## Billing, payments, invoicing, e-invoicing
| File | Purpose |
|---|---|
| [psp-incident](../../runbooks/psp-incident.md) | Payments, uncertain results, webhooks and half-finished captures |
| [reconciliation-break-handling](../../runbooks/reconciliation-break-handling.md) | Financial reconciliation RC-01..RC-06: run, assign, resolve breaks |
| [ledger-inspection](../../runbooks/ledger-inspection.md) | Inspect the append-only ledger and wallet drift |
| [reversing-adjustment](../../runbooks/reversing-adjustment.md) | Correct a ledger entry with a reversing adjustment (two people) |
| [rebuild-projections](../../runbooks/rebuild-projections.md) | Rebuild wallet balances and usage aggregates |
| [metering-replay](../../runbooks/metering-replay.md) | Replay and verify usage aggregates from raw events |
| [pricebook-release](../../runbooks/pricebook-release.md) | Four-eyes price book release and rating |
| [subscription-lifecycle](../../runbooks/subscription-lifecycle.md) | Subscription states, renewals, changes, cancellation |
| [dunning](../../runbooks/dunning.md) | Overdue invoice stages, holds and restrictions |
| [refund-procedure](../../runbooks/refund-procedure.md) | Refund creation and follow-up |
| [invoice-correction](../../runbooks/invoice-correction.md) | Correct an invoice with a credit note |
| [tax-and-invoice-numbering](../../runbooks/tax-and-invoice-numbering.md) | Tax configuration and gapless invoice numbering (items for tax advisor) |
| [quotas-and-spend-approvals](../../runbooks/quotas-and-spend-approvals.md) | Quotas, spend limits and spend approvals |
| [provider-cost-capture](../../runbooks/provider-cost-capture.md) | Provider cost capture and RC-04 (fixtures only) |
| [zatca-onboarding](../../runbooks/zatca-onboarding.md) | E-invoicing onboarding (simulated only) |
| [zatca-queue-stuck](../../runbooks/zatca-queue-stuck.md) | E-invoice queue states and retry rules (simulated only) |
| [zatca-key-rotation](../../runbooks/zatca-key-rotation.md) | E-invoicing key rotation: not built, records why |

## Cloud providers and compute
| File | Purpose |
|---|---|
| [provider-onboarding](../../runbooks/provider-onboarding.md) | Register, verify and enable a provider account |
| [live-verification](../../runbooks/live-verification.md) | Owner-run live verification of a provider (all NOT VERIFIED today) |
| [reconciliation](../../runbooks/reconciliation.md) | Technical reconciliation of resources against providers; uncertain results |
| [orphan-handling](../../runbooks/orphan-handling.md) | Handle suspected orphaned billable provider resources |

## Hosting
| File | Purpose |
|---|---|
| [node-onboarding](../../runbooks/node-onboarding.md) | Onboard a hosting node (mock agent only) |
| [drain-and-migrate](../../runbooks/drain-and-migrate.md) | Drain a node and migrate sites |
| [site-recovery](../../runbooks/site-recovery.md) | Recover a failed site, stuck restore or corrupt backup |
| [offboarding](../../runbooks/offboarding.md) | Offboard a site: export window, wipe, residual check |
| [abuse-handling](../../runbooks/abuse-handling.md) | Hosting abuse cases, actions and appeals |

## Domains and DNS
| File | Purpose |
|---|---|
| [domains-reconcile](../../runbooks/domains-reconcile.md) | Domain orders waiting on the registrar |
| [domains-registrar-outage](../../runbooks/domains-registrar-outage.md) | Registrar outage, rate limits, maintenance |
| [dns-degraded-zone](../../runbooks/dns-degraded-zone.md) | Reconcile a degraded DNS zone |

## Managed data and email
| File | Purpose |
|---|---|
| [db-restore](../../runbooks/db-restore.md) | Managed database backup, restore and verification drills |
| [db-failover](../../runbooks/db-failover.md) | Self-operated database failover and node loss (draft, not exercised) |
| [storage-incident](../../runbooks/storage-incident.md) | Object storage incidents: public bucket, leaked URL, isolation |
| [email-deliverability](../../runbooks/email-deliverability.md) | Email deliverability and throttling |
| [suppression-handling](../../runbooks/suppression-handling.md) | Email suppression list handling |

## Platform and developer operations
| File | Purpose |
|---|---|
| [restore-db-from-dump](../../runbooks/restore-db-from-dump.md) | Restore the development or staging database from a dump; audit-chain check |
| [local-setup](../../runbooks/local-setup.md) | Local setup and demo on a developer machine |

## Demos (local, mock or sandbox only)
| File | Purpose |
|---|---|
| [demo-m02](../../runbooks/demo-m02.md) | Usage, quota, cap, quote, four-eyes approval, statement |
| [demo-m03](../../runbooks/demo-m03.md) | Card, subscription, invoice, pay, wallet, refund, reconciliation, e-invoicing |
| [demo-m04](../../runbooks/demo-m04.md) | Residency, privacy requests, retention, controls, breach cases |
| [demo-m06](../../runbooks/demo-m06.md) | Shared hosting on the mock node |
| [demo-m08](../../runbooks/demo-m08.md) | Managed data and email on dev-reference mocks |
| [domains-demo](../../runbooks/domains-demo.md) | Domain search, register, DNS, link to a site on mock registrars |

## Not listed here
`docs/runbooks/README.md` (index owned separately).
