# Escalation matrix (M12 S58 draft)

Status: DRAFT 2026-11-18, NOT VERIFIED, **PROPOSAL pending D-29** (support model and SLA tiers, OPEN, owner decides). Severity definitions and every response time below are proposals; none is a customer commitment until the owner records D-29. The on-call roster, contact details and acceptance of this matrix are HG-12-03 (PENDING). Contact fields are placeholders: nobody should be named in this file.

## Roles
| Level | Role | Does |
|---|---|---|
| L1 | Support agent (role `support`) | Receives reports, checks documented symptoms (`support-playbooks.md`), uses read-only admin views, applies documented safe actions, opens the incident or ticket, never touches data stores |
| L2 | On-call engineer / SRE | Diagnoses, runs runbook steps that need admin-realm mutations (MFA, step-up), restarts workers, runs reconciliations, decides to escalate |
| L3 | Engineering lead / domain owner (identity, billing, cloud, hosting, domains, data, compliance) | Code-level diagnosis, fixes, hotfix decisions, adapter and provider issues |
| IC | Incident commander | Runs a SEV1/SEV2 incident: roles, cadence, decisions, closure (`incident-response.md`) |
| COM | Communications lead | Approves customer and public wording (`communications-drafts.md`) |
| SEC | Security officer (role `security`) | Security events, isolation, secrets, break-glass approvals |
| CO | Compliance officer / DPO (role `compliance_officer`) | Breach cases, DSR, retention, legal holds, evidence; liaison to counsel |
| FIN | Finance lead (role `finance`) | Money, reconciliation accepts, refunds, ZATCA and PSP business decisions |
| LEG | Counsel / tax advisor | Legal notification, regulator contact, tax questions (HG-04-01, HG-03-04), reached through CO or FIN |
| OWN | Owner | SEV1 decisions, spend, go/no-go (HG-12-03) |

## Severity definitions (proposal)
| Level | Definition | Examples |
|---|---|---|
| SEV1 | Platform-wide outage, or confirmed/suspected loss of data confidentiality, integrity or money correctness | Control-plane down; cross-tenant data visible; ledger imbalance; duplicate charges; suspected sandbox escape; recovery target at risk of being missed |
| SEV2 | A major function is unavailable or badly degraded for many customers, no data loss | Provisioning down for a provider; payments failing; e-invoice window breach; queue backlog growing |
| SEV3 | Partial degradation or one customer affected, workaround exists | One provider region impaired; SSO lock-out of one organization; reconciliation break under investigation |
| SEV4 | Minor or cosmetic; information requests | UI text defect; documentation question |
Rule: when unsure choose the higher level; the IC may lower it with a note.

## Response-time proposals (PROPOSAL, D-29 OPEN)
Platform objectives under D-30 (decided 2026-11-15): availability 99.9 % monthly for the control-plane API, RPO 15 min, RTO 4 h. The times below are internal targets for acknowledging and updating, not those objectives.
| Level | Acknowledge | First update to customers | Update cadence | Staffing |
|---|---|---|---|---|
| SEV1 | 15 min | 30 min | every 30 min | 24x7 on-call, IC mandatory, owner informed |
| SEV2 | 30 min | 60 min | every 60 min | 24x7 on-call (or extended hours: owner decides) |
| SEV3 | 4 business hours | next business day | on change | business hours |
| SEV4 | 2 business days | n/a | n/a | business hours |
Business hours, time zone and weekends are to be confirmed by the owner (Saudi calendar assumptions are not recorded in the repository).

## Who to involve, by situation
| Situation | First | Add | Runbook |
|---|---|---|---|
| Any SEV1/SEV2 | L2, IC | L3, COM, OWN (SEV1) | `incident-response.md` |
| Suspected breach or data exposure | SEC, CO | LEG, OWN, L3 | `data-breach-workflow.md` |
| Money, ledger, reconciliation | FIN, L2 | L3 billing | `reconciliation-variance.md`, `billing-close.md` |
| PSP | FIN, L2 | PSP contact | `psp-outage.md` |
| E-invoicing | FIN | tax advisor, L3 | `zatca-backlog.md` |
| Provider or registrar | L2 | L3 cloud/domains | `provider-outage.md` |
| Backlog, workers | L2 | L3 platform | `queue-recovery.md` |
| Database or region loss | L2 (DBA) | L3, OWN | `dr-restore.md` |
| SSO or SCIM | L2 | L3 identity, SEC | `sso-lockout.md`, `scim-failure.md` |
| Abuse or legal order | SEC | CO, LEG | `abuse-takedown.md` |
| Access review findings | SEC | CO | `access-review-process.md` |

## Contact fields (placeholders; to be filled under HG-12-03)
| Role | Primary | Secondary | Channel | Hours |
|---|---|---|---|---|
| L1 support | `<to be filled>` | `<to be filled>` | `<to be filled>` | `<to be filled>` |
| L2 on-call | `<to be filled>` | `<to be filled>` | `<to be filled>` | `<to be filled>` |
| L3 engineering lead | `<to be filled>` | `<to be filled>` | `<to be filled>` | `<to be filled>` |
| Security officer | `<to be filled>` | `<to be filled>` | `<to be filled>` | `<to be filled>` |
| Compliance officer / DPO | `<to be filled>` | `<to be filled>` | `<to be filled>` | `<to be filled>` |
| Finance lead | `<to be filled>` | `<to be filled>` | `<to be filled>` | `<to be filled>` |
| Counsel / tax advisor | `<to be filled>` | `<to be filled>` | `<to be filled>` | `<to be filled>` |
| Owner | `<to be filled>` | `<to be filled>` | `<to be filled>` | `<to be filled>` |
| Provider and PSP support contacts | `<to be filled when selected>` | | | |

Roster mechanics: `on-call-roster-template.md`.

## Acceptance
Approved by: `<owner, HG-12-03>` Date: `<to be filled>` Status: NOT VERIFIED (not accepted).
