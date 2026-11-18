# Admin handbook outline (M12 S58)

Status: OUTLINE 2026-11-18. The handbook text is to be written from the final contract at documentation freeze; this file fixes structure and sources so nothing is invented. Screens are those in `docs/13-dashboards-spec.md` (admin portal, `X`); M12 screens UI-M12-04..17 are NOT VERIFIED until built and screenshot-tested (AC-M12-22). The handbook is published in Arabic and English (D-32: Arabic default). Training and acceptance are human (HG-12-03).

## Chapters
| # | Chapter | Source of truth | Status of source |
|---|---|---|---|
| 1 | Audience, roles and permissions: platform roles (`platform_admin`, `support`, `finance`, `compliance_officer`, `security`), admin realm, MFA, step-up, four-eyes rules | `spec/openapi/openapi.yaml` (`x-nuzm-platform-permission`), `docs/04` | contract |
| 2 | Signing in to the admin console, session and MFA, what is audited | `docs/04`, M01 report | contract |
| 3 | Organizations and users: search, suspend and reinstate, impersonation (time-boxed, reason, approval) | `/v1/admin/organizations`, `/v1/admin/users`, `/v1/admin/users/{id}/impersonation` | contract |
| 4 | Feature flags: purpose, default off, how to set, audit | `/v1/admin/feature-flags` | contract |
| 5 | Audit log: reading, filters, cross-organization reads are audited; hash-chain verification (worker job); export (planned) | `/v1/admin/audit-logs`, S55 | export: in progress |
| 6 | Providers: accounts (vault references only), verification, capabilities, regions, offers, routing rules, health, breaker | M05 runbooks, `/v1/admin/provider-accounts`, `/v1/admin/offers` | contract; live NOT VERIFIED |
| 7 | Resources and reconciliation (technical): drift, orphans, forced reconcile | `reconciliation.md`, `orphan-handling.md` | contract |
| 8 | Hosting: nodes, agents, sites, migrations, abuse cases | M06 runbooks | mock only |
| 9 | Domains and registrars | M07 runbooks | mock only |
| 10 | Managed data and email: providers, restores, suppression, deliverability | M08 runbooks | mock only |
| 11 | Billing operations: price books (four-eyes), plans, meters, adjustments, refunds, dunning, invoices, revenue reports | M02/M03 runbooks, `/v1/admin/billing/*` | sandbox PSP, simulated ZATCA |
| 12 | Financial and technical reconciliation (RC-01..RC-06, TR-01..TR-04), resolutions, billing close | `reconciliation-variance.md`, `billing-close.md` | contract (financial); TR-02 not built |
| 13 | E-invoicing queue | `zatca-queue-stuck.md`, `zatca-backlog.md` | simulated |
| 14 | Compliance: ROPA, retention policies, legal holds, controls and evidence, regulatory validations, breach cases, DSR, residency | M04 runbooks | counsel inputs pending (HG-04-01) |
| 15 | Operations console (M12): health, incidents, alerts, provider incidents, recovery exercises, launch readiness board | `docs/04` §2.12 | planned; not in the spec yet |
| 16 | Enterprise identity administration: SSO connections, SCIM, access reviews, organization security policy | `docs/04` §2.12, PA-04..PA-07 | in progress, flagged off |
| 17 | Incident, recovery and breach procedures: pointer chapter to the runbooks | `runbook-index.md` | draft |
| 18 | Escalation, on-call, communication drafts | `escalation-matrix.md`, `on-call-roster-template.md`, `communications-drafts.md` | draft; roster HG-12-03 |
| 19 | Glossary and status vocabulary (PASS, FAIL, BLOCKED, NOT VERIFIED, DEFERRED), decision and gate IDs | `CLAUDE.md` §6, `docs/07` | contract |
| 20 | Known limitations and open items (from `blocked-register.md` when produced) | M12 deliverable | pending |

## Writing rules
- Describe only implemented behaviour; anything planned is labelled as such with the planning reference.
- Every procedure names the role, the screen or endpoint, the required step-up, and what is audited.
- No claim of certification or compliance; no live-provider claims without LIVE-VERIFIED evidence.
- Each chapter carries a "Last reviewed" date and the owner role (not a name).
- Arabic and English are written separately by language owners, not machine-translated, and both are reviewed before freeze.
