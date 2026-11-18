# Penetration test scope (for the external vendor, HG-12-01 / D-28)

> **STATUS: DRAFT prepared by the agent. The independent pen test is HG-12-01 (D-28) and is BLOCKED/PENDING: no vendor is selected, no environment exists, no date is set.** This document is the agent's preparation; the owner issues it to the vendor. Counsel reviews contractual wording (see the rules of engagement). Prepared 2026-11-18.

## 1. Objectives

1. Independently test the confidentiality, integrity and tenant isolation of the Nuzm platform before general availability (AC-M12-11).
2. Retest every critical and high finding after the fix (vendor retest letter; rule in [pen-test-remediation-tracker.md](pen-test-remediation-tracker.md)).
3. Cover the surfaces the internal assessment could not verify: deployed TLS/headers, SAML and SCIM, hosting isolation on a real node, the sandbox, delegation.

Internal material the vendor receives, if the owner agrees: the threat models and ASVS matrix in this pack (they state what is unverified, which is where to look first), `spec/openapi/openapi.yaml`, and the tenant-sweep description. Sharing source code is an owner decision (grey-box vs black-box).

## 2. In scope (assets)

Assets marked "when built" are not on this branch and are listed so the scope is complete; the engagement start is gated on their availability (section 8).

| Asset | Detail | Availability |
|---|---|---|
| Customer console | `apps/web` (Next.js, Arabic RTL and English): registration, password sign-in, OIDC sign-in, MFA, dashboard and every console page | Exists |
| Admin console | `apps/admin` (separate realm, separate cookies, staff accounts with MFA): organizations, users, impersonation, finance, compliance, audit, flags, provider admin | Exists |
| Platform API | All operations in `spec/openapi/openapi.yaml` (284 at the time of writing), including `/v1/auth/*`, org-scoped routes, API-key authentication, admin routes, idempotency and ETag behaviour | Exists |
| Public inbound webhooks | `/v1/webhooks/payments|cloud|email|registrars/{provider}`: signature and replay validation. Vendor uses test secrets supplied for staging only | Exists (mock providers) |
| Internal producer endpoint | `POST /v1/internal/metering/events` (service-key auth) | Exists |
| SSO endpoints | SAML ACS and metadata, OIDC enterprise callback, SSO connection management, domain proof, enforcement, JIT, break-glass | When built (S55) |
| SCIM | `/scim/v2/*` with seeded SCIM tokens | When built (S55) |
| Shared hosting | Staging CloudPanel node(s), node agent channel, customer sites on staging, backups, SFTP, per-site isolation | When a real node exists (HG-06-01) |
| Domains/DNS, managed data, email | Customer-facing flows against sandbox registrars/providers | Exist against mocks; real sandbox when granted |
| AI gateway and builder | AI runs, budgets, prompts/outputs handling | When built (M09, M10) |
| Sandbox | Runner, terminal WebSocket, egress proxy, escape testing against canaries | When built (M10; HG-10-02 is a separate review) |
| Delegation and programs | Agency/reseller/delegated access, marketplace, workflow engine (SSRF, webhooks) | When built (M11) |
| Invoicing/PDF and ZATCA sandbox flow | Invoice rendering, e-invoice submission against the **simulated** server only | Exists (simulated) |

Test classes expected: authentication and session management, access control and tenant isolation (horizontal and vertical), injection, business-logic abuse (billing, quotas, refunds), API abuse, SSO/SCIM protocol attacks, file/path handling, SSRF, configuration and TLS, hosting escape, sandbox escape.

## 3. Out of scope

| Item | Reason |
|---|---|
| Third-party providers and their infrastructure (cloud, registrars, DNS, email, object storage, database providers) | Not ours to authorise; provider testing policies must be checked by the owner/counsel before any test touches them |
| Payment service provider environments and cardholder systems | Third party; no card data is handled by the platform (PAN rejected, `pan.ts`) |
| ZATCA and any government service | Third party and regulatory |
| Enterprise identity providers used for SSO tests | Customer/third-party infrastructure; the vendor tests Nuzm's SP/SCIM server only |
| Denial of service and volumetric/load testing | Load is covered by M12 S56 on staging; DoS stays out of vendor scope unless separately agreed |
| Social engineering, phishing, physical access | Out unless the owner agrees in writing |
| Production environment and production data | Never in scope |
| Other tenants' real data (none should exist in staging) | Staging is synthetic only |
| Source code review | Out unless the owner opts for grey/white-box |
| Developer workstations, CI/CD, source hosting | Not included in this engagement |

## 4. Environment

- **Staging only. Never production.** A production-like staging environment with real M05 compute does not exist yet: `BLOCKED (D-15, HG-05-xx)`. The vendor does not start until it exists, is stated to be at declared scale and parity, and the owner confirms in writing.
- Staging uses sandbox/test credentials only (docs/02 §9); no production provider credentials; payment flows use the PSP sandbox when granted (HG-03-02), otherwise the mock; ZATCA is the simulated server.
- Source IP allow-list for the vendor; documented in the engagement record (placeholder `<VENDOR_SOURCE_IPS>`).
- Feature flags needed for the engagement (all default off): enterprise SSO/SCIM, hosting, builder, programs; to be enabled on staging before the start.
- Residency: staging deployment region and data placement follow `ResidencyPolicyService` rules; test data never leaves the agreed region (see section 6).

## 5. Test organizations and accounts (to be seeded before the start)

All data synthetic. Credentials, TOTP seeds, API keys and SCIM tokens are generated at seed time, delivered through an out-of-band secure channel chosen by the owner, and never written in this repository. Placeholders only below.

| Seeded entity | Purpose | Notes |
|---|---|---|
| Org A "pt-victim-a" with users: owner, admin, billing_admin, developer, viewer (`<PT_A_OWNER>`, ...) | Victim tenant with real resources in every module | Resources: workspaces/projects/environments, API keys of several scopes, quotes, orders, invoices, payments (sandbox), refunds, wallet, subscriptions, domains and DNS zones, a hosting site and backup, managed database/storage/email objects, DSR request, notifications, audit entries |
| Org B "pt-attacker-b" with the same role set | Cross-tenant attacker tenant | Used to attack A's ids |
| Org C "pt-suspended-c" (suspended) and Org D "pt-new-d" (fresh, no resources) | State-dependent behaviour; empty-state errors | |
| Enterprise org E "pt-sso-e" with a seeded SSO connection to the local/test IdP and verified domain; one SAML and one OIDC connection; SCIM token `<PT_E_SCIM_TOKEN>` | SSO/SCIM testing | When S55 lands; real IdP tenants are HG-12-02 |
| Agency org F, client orgs G and H, reseller R with sub-orgs, a grant F->G and no grant F->H; expired and revoked grants | Delegation matrix | When M11 lands |
| Platform staff accounts (admin realm, TOTP enrolled): `platform_admin`, `support`, `finance`, `compliance_officer`, `security` (`<PT_STAFF_*>`) | Admin console and impersonation testing; separation-of-duty tests | Staff are IdP/OIDC users with MFA, no passwords |
| One account per pair needing a second approver (finance requester and approver) | Dual-control flows | |
| Unauthenticated, web-session, admin-session and API-key client types | Authentication and realm-separation tests | |
| Staging hosting node with two customer sites in different orgs | Isolation testing | When a real node exists |
| Sandbox project in org A with planted canary secrets (platform-owned, non-functional values) | Sandbox escape testing | When M10 lands |
| Seeded invoices, credit notes, a ZATCA simulated-server queue with held and rejected items | Billing/e-invoicing logic tests | |

Account rules: no shared accounts between vendor testers; accounts disabled at engagement end; seeds reproducible by script so the environment can be reset between test phases (script to be written by the implementing session; not in this pack).

## 6. Data handling and residency

- Synthetic data only; no real customer or personal data is placed in staging. If a vendor tester discovers real personal data, it is an incident: stop and report (rules of engagement).
- Findings, screenshots and logs are classified Confidential; vendor stores them encrypted, shares them only over the agreed channel, and deletes engagement data after final acceptance of the report plus an agreed retention period (`<RETENTION_PERIOD>`, counsel/owner).
- No secrets in reports: tokens and keys redacted.
- Residency: test data remains in the staging region; the vendor's tools and storage that hold Nuzm material should be located per owner/counsel guidance (PDPL transfer questions are counsel's: HG-04-01). The vendor must disclose where it processes reports and evidence.
- The vendor signs confidentiality terms before receiving any documents (contract; counsel).

## 7. Deliverables expected from the vendor

1. Written report: executive summary, methodology, scope confirmation, findings each with severity (aligned to the policy in the tracker), evidence, reproduction steps, affected component, remediation advice, and a list of what was not tested.
2. Immediate out-of-band notice for critical findings (see rules of engagement).
3. A retest of every critical and high finding after the fix, with a retest letter listing each finding id and result.
4. An attestation text approved by the vendor describing exactly what was tested and when (no wording supplied by Nuzm for marketing use).

## 8. Preconditions checklist (engagement start is blocked until all are true)

| Condition | Status |
|---|---|
| Owner selects the vendor and signs the contract (D-28, HG-12-01) | BLOCKED (D-28 OPEN) |
| Staging environment exists at declared scale with TLS, real topology | BLOCKED (D-15, HG-05-xx) |
| Seed scripts and accounts ready, secrets delivered out of band | NOT VERIFIED (not built) |
| S55 SSO/SCIM implemented and local test IdPs working | NOT VERIFIED (in flight) |
| M09-M11 surfaces on staging, or explicitly excluded from this round | NOT VERIFIED (in flight) |
| Rules of engagement agreed and counsel-reviewed | BLOCKED (counsel) |
| Internal scans run with 0 open critical/high | NOT VERIFIED (see `internal-scans.md`) |
| Backup/snapshot of staging taken; monitoring and on-call informed | NOT VERIFIED |
| Provider testing policies checked for any third-party service reachable from staging | NOT VERIFIED |

## 9. Contacts (placeholders)

| Role | Name | Channel |
|---|---|---|
| Engagement owner (Nuzm) | `<OWNER_NAME>` | `<CONTACT>` |
| Security lead / triage | `<SECURITY_LEAD>` | `<CONTACT>` |
| Technical contact (staging) | `<ENGINEERING_CONTACT>` | `<CONTACT>` |
| Emergency (24x7 during test windows) | `<EMERGENCY_CONTACT>` | `<PHONE>` |
| Vendor lead tester | `<VENDOR_LEAD>` | `<CONTACT>` |
| Counsel | `<COUNSEL>` | `<CONTACT>` |
