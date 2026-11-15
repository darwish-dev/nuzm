# Nuzm — Open Decisions & External Blockers Register (draft)

Rules: agents may **not** assume an answer to any item marked `OPEN`. A "proposed default" is a recommendation for owner approval, not a decision. When a decision is made, record an ADR and change status here. Evidence column states what proves closure.

## A. Decisions (D-xx)
| ID | Decision | Needed by | Options / proposed default | Status |
|---|---|---|---|---|
| D-01 | Git host + CI platform | S01 | GitHub + GitHub Actions (default) / GitLab / other | **DECIDED 2026-11-15: local only for now** (CI cannot run until a remote exists; HG-01-01 pending) |
| D-02 | Team size, parallel lanes, sprint calendar | before S01 | Single team sequential (baseline) / lanes per matrix §4 | **DECIDED 2026-11-15: one team, sequential** |
| D-03 | Durable operations engine | S02 | Postgres outbox + BullMQ (default) / Temporal | OPEN |
| D-04 | Identity provider | S02 | Self-hosted Keycloak (default; in-Kingdom hosting possible) / Ory / managed IdP / custom NestJS OIDC | OPEN |
| D-05 | **Managed PostgreSQL/MySQL provider** | S32 | Proposed: `DataProviderAdapter` with (a) **provider-managed RDS** (Alibaba/Huawei) enabled only where verified in a Saudi region, else (b) **Nuzm-operated** PostgreSQL/MySQL on verified Saudi ECS with PITR backups. Launch with (b) unless (a) verified first. | OPEN |
| D-06 | **Managed Redis** | S33 | Same pattern as D-05: provider-managed Redis where verified; else Nuzm-operated Redis (primary+replica, TLS, ACL) on verified ECS | OPEN |
| D-07 | **Object storage** | S34 | Proposed: provider object storage (Alibaba OSS / Huawei OBS) via S3-compatible adapter **only if S3-API compatibility and Saudi region are verified**; else self-hosted S3-compatible service (Ceph RGW, SeaweedFS or Garage; MinIO only after license review) on verified ECS | OPEN |
| D-08 | **Transactional email provider** | S36 | Proposed: managed API provider behind `TransactionalEmailAdapter`; shortlist Amazon SES, Postmark, Mailgun (final choice after residency/transfer review D-16/D-17 and sender-reputation terms). Self-hosted MTA **rejected for v1** (IP reputation/ops burden). | OPEN |
| D-09 | **Business email (mailboxes)** | S35 | Proposed: resell via existing registrar partners' email products (ResellerClub/Openprovider — availability to be verified) ; fallback Google Workspace / Microsoft 365 reseller programs; self-hosted mail **rejected for v1** | OPEN |
| D-10 | PSP(s) for Saudi payments (mada, cards, Apple Pay, optionally STC Pay/SADAD/bank transfer) | S09 | Shortlist to be validated for KSA eligibility: Moyasar, HyperPay, Tap, PayTabs, Checkout.com, Stripe (availability must be verified). One primary + abstraction | OPEN |
| D-11 | ZATCA approach | S11 | Native implementation of Fatoora Phase 2 integration (default) / licensed ZATCA solution provider middleware | OPEN |
| D-12 | Secrets/KMS | S02 | HashiCorp Vault or OpenBao self-hosted / cloud KMS in-Kingdom (verify) | OPEN |
| D-13 | Observability stack | S04 | OpenTelemetry → Grafana stack self-hosted (default) / managed | OPEN |
| D-14 | Residency default stance per data class | S13 | Proposed: classes `public`, `internal`, `customer-content`, `personal`, `financial`, `credentials`; default `personal`/`financial`/`customer-content` for Saudi-based customers = in-Kingdom only unless org policy and transfer assessment permit | OPEN (legal) |
| D-15 | Control-plane hosting location; in-Kingdom backup target | S13 | Verified Saudi ECS region(s) from M05 (circular: bootstrap runs on bootstrap infra; production hosting decided before staging) | OPEN |
| D-16 | PDPL role per data category (controller vs processor), DPO appointment, lawful bases | S13 | Counsel decision | OPEN (legal) |
| D-17 | NCA/CST applicability scope (ECC, CCC, data cybersecurity controls, CST cloud framework registration/classification) | S13 | Counsel + security officer determination | OPEN (legal) |
| D-18 | AI model providers and inference residency | S37 | Gateway supports multiple; in-Kingdom/hosted models vs external APIs governed by D-14/D-16 | OPEN |
| D-19 | Domain TLD portfolio; `.sa` eligibility/registration route (SaudiNIC accreditation/partner) | S28 | Counsel/commercial | OPEN |
| D-20 | CloudPanel automation path | S24 | Validate documented API/CLI first; else authenticated node agent; **never UI scraping** | OPEN (decided by M06 PoC evidence) |
| D-21 | Sandbox isolation technology | S45 | gVisor / Firecracker / Kata on dedicated nodes; decided with security review | OPEN |
| D-22 | macOS build capacity for iOS | S49 | Owned Mac hardware / hosted Mac provider | OPEN |
| D-23 | Pricing policy, currencies, margin, free tier, VAT-inclusive display | S05 | Finance | OPEN |
| D-24 | Reseller model: merchant/invoice issuer of record | S08 (design), S54 | Platform-issued invoices to reseller (wholesale) [default] / reseller issues own | OPEN (tax/legal) |
| D-25 | Credits/wallet policy (expiry, refundability) | S05 | Finance/legal | OPEN |
| D-26 | Marketplace publisher payouts licensing | S53 | Defer payouts (revenue accounting only) unless licensed route confirmed | OPEN (legal) |
| D-27 | Enterprise SSO scope | S55 | SAML + OIDC + SCIM 2.0 | OPEN |
| D-28 | Independent pen-test vendor | S56 | Owner | OPEN |
| D-29 | Support model / SLA tiers | S58 | Owner | OPEN |
| D-30 | SLO/RPO/RTO targets | S01 | PRD §6 proposals | **DECIDED 2026-11-15: accept PRD §6 proposals** (99.9%, RPO 15 min, RTO 4 h) |
| D-31 | Reconciliation variance thresholds | S12 | Finance | OPEN |
| D-32 | Brand/design identity, default UI language | S01 | Owner | **DECIDED 2026-11-15: Arabic default, English supported**; brand identity assets still needed from owner |
| D-33 | Billing legal entities (VAT-registered issuer(s), CR numbers) | S08 | Owner/finance | OPEN |
| D-35 | Admin console network restriction (VPN/IP allow-list/zero-trust) and separate auth realm hosting | S04 | Owner/Security | OPEN |
| D-36 | Authoritative DNS hosting (registrar-provided vs Nuzm-operated) | S30 | Registrar-provided where adapter supports `dns`; else Nuzm-operated authoritative service | OPEN |
| D-34 | Data retention periods (financial: per ZATCA/VAT law; logs; backups) | S08 (financial records), S13 (rest) | Counsel | OPEN (legal) |

## B. Human gates and external blockers (HG-xx)
Status vocabulary: `PENDING` (not started), `REQUESTED`, `GRANTED (evidence)`, `DENIED`. An agent **may not** mark `GRANTED` itself; the owner records evidence (document/screenshot id).

| ID | Item | Owner | Blocks | Evidence required |
|---|---|---|---|---|
| HG-00-01 | Approval of this documentation set | Owner | S01 | **GRANTED 2026-11-15** — `docs/reports/HG-00-01-approval.md` (chat approval; PA-xx and legal items excluded) |
| HG-01-01 | Git repo / CI access and org settings | Owner | S01 | Repo URL, CI run |
| HG-01-02 | IdP hosting + domain for auth | Owner/DevOps | S02 | Reachable issuer URL |
| HG-02-01 | Pricing/margin policy and VAT-inclusive rules | Finance | S05/S06 | Approved price-book v1 |
| HG-03-01 | Legal billing entity VAT registration and CR details | Finance | S08 | Registration certificate refs |
| HG-03-02 | PSP merchant account + sandbox keys + production approval | Finance | S09 (sandbox), GA (prod) | Account id, sandbox keys in vault |
| HG-03-03 | ZATCA onboarding: Fatoora portal access, OTP for CSID, device registration, EGS unit; Phase-2 wave eligibility | Finance/Tax | S11 | Compliance CSID response; production CSID later |
| HG-03-04 | Tax advisor sign-off on invoice templates, credit-note and reseller treatment | Tax advisor | M03 gate | Written sign-off |
| HG-CMP-01 | (alias of HG-04-01) Early counsel review of cloud-service-provider classification (PRD R7) | Legal | S13 | Memo ref |
| HG-04-01 | Counsel memo on PDPL role, transfer rules, DPO, retention (D-14/16/17/34) | Legal | S13 | Memo ref |
| HG-04-02 | NCA/CST applicability and any registration/classification filing | Legal/Security | S15 | Memo + filing receipts |
| HG-04-03 | Third-party security/compliance assessments or certifications (e.g., ISO 27001 scope, NCA assessments) — **cannot be produced by the agent** | Security | GA | Certificates/reports |
| HG-05-01 | Alibaba Cloud account(s), RAM least-privilege user, billing access, Saudi-region eligibility confirmation | Owner | S18 | Account id; region list evidence |
| HG-05-02 | Huawei Cloud account(s), IAM user, Saudi-region eligibility confirmation | Owner | S20 | Same |
| HG-05-03 | Contabo account + API credentials (client id/secret, API user); confirmed plan/location access | Owner | S22 | Credentials in vault; capability probe output |
| HG-05-04 | Quota/limit increases and spend caps at providers | Owner | S19/S21/S22 | Provider console confirmation |
| HG-06-01 | CloudPanel licensing/edition decision; nodes provisioned (from M05) | Owner | S24 | Node access |
| HG-07-01 | Openprovider reseller account + API access + sandbox; ResellerClub reseller account + API IP-allow + sandbox | Owner | S28/S29 | Credentials in vault |
| HG-07-02 | `.sa` eligibility route / registrar accreditation | Owner/Legal | S30 (Saudi TLD live) | Written confirmation |
| HG-08-01 | Data provider(s) for databases/Redis (D-05/D-06) contracted or verified; credentials | Owner | S32 | Contracts, keys, probe output |
| HG-08-02 | Object-storage provider (D-07) contracted or verified; credentials | Owner | S34 | Same |
| HG-08-03 | Business-email provider/program (D-09) contracted; reseller access | Owner | S35 | Contract, API access |
| HG-08-04 | Transactional email provider (D-08) contracted; sending domain, IP/domain warm-up plan, abuse policy | Owner | S36 | Contract, keys |
| HG-09-01 | Model provider API contracts and enterprise data terms | Owner | S37 | Contract refs |
| HG-10-01 | Apple Developer / Google Play accounts and authorized signing material; macOS capacity | Owner | S49 | Account ids; keystore refs |
| HG-10-02 | Sandbox isolation security review | Security | S45 | Report |
| HG-10-03 | Independent authorship/ownership of the Reference CRM E2E suite (someone other than the generator's author/agent run) | Owner | S47 | Named author, repo ref, sign-off |
| HG-11-01 | Marketplace terms, publisher agreement, payout legal route | Legal | S53 | Documents |
| HG-11-02 | Third-party OAuth app registrations for connectors (client ids/secrets, review approvals) | Owner | S52 | App ids; secrets in vault |
| HG-12-01 | Independent penetration test (external vendor) | Owner | S56 | Final report, retest letter |
| HG-12-02 | SSO test tenants at enterprise IdPs | Owner | S55 | Tenant ids |
| HG-12-03 | Go/no-go decision, support training, runbook acceptance, on-call roster | Owner | S58 | Signed decision |

## C. External dependencies treated as BLOCKED until evidenced
Saudi-region ECS availability per account (never assumed) · ZATCA production CSID · PSP production approval · registrar/`.sa` rights · app-store account approvals · pen-test completion · certifications.

## D. Review checklist for approving this documentation set (HG-00-01)
- [ ] PRD scope matches intended full-platform scope
- [ ] Milestone order/sprint counts acceptable (or D-02 lanes chosen)
- [ ] API spec endpoint renames acceptable
- [ ] DB ownership acceptable
- [ ] Proposed provider-selection defaults (D-05..D-09) acceptable as *starting* points
- [ ] Compliance/ZATCA tracks reviewed by counsel/tax advisor
- [x] Decisions needed before S01 answered: D-01, D-02, D-30, D-32 (2026-11-15)
