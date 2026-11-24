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
| D-18 | AI model providers and inference residency | S37 | Gateway supports multiple; in-Kingdom/hosted models vs external APIs governed by D-14/D-16 | OPEN. 2026-11-22: owner's technical direction PROPOSED (Claude first, provider-neutral, live calls off until residency approved); legal option NOT decided and no international transfer approved: [S-AG4-DECISIONS](ai-intelligence/S-AG4-DECISIONS.md) D1, D5 |
| D-19 | Domain TLD portfolio; `.sa` eligibility/registration route (SaudiNIC accreditation/partner) | S28 | Counsel/commercial | OPEN |
| D-20 | Hosting panel automation path | S24 | Superseded by D-52: HestiaCP through its REST API, allow-listed commands, **never UI scraping** | SUPERSEDED (D-52) |
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
| D-37 | AI Studio scope additions: GitHub App, Skills registry, project instructions, Claude Code in sandbox (ADR-064) | AI Studio S-A2 | Accept ADR-064 as proposed; spec change before any endpoint/table | **DECIDED 2026-11-20 (owner): accept ADR-064 points 1–3** — spec change then implementation |
| D-38 | Hosted Claude Code: is "customer signs in to the unmodified binary inside a Nuzm sandbox" permitted for Nuzm's offer? (Anthropic legal-and-compliance page, read 2026-11-20) | AI Studio S-A8 | Counsel opinion recorded; flag `ai.claude_code_sandbox` off in production until then | **PARTLY DECIDED 2026-11-20 (owner): isolated proof of concept only**; commercial/production use OPEN (legal + provider compliance) |
| D-39 | GitHub App: registering account, permissions set, webhook endpoint hosting/residency | AI Studio S-A7 | Nuzm-owned App, minimum permissions per ADR-064 | **DECIDED 2026-11-20 (owner): Nuzm-owned GitHub App, minimum permissions (ADR-064)**; registration + keys = HG-AS-01 |
| D-40 | Third-party Skills: allowed sources, licence policy, approver roles | AI Studio S-A4 | Unknown licence ⇒ not publishable; two approvers for executable skills | **DECIDED 2026-11-20 (owner): ADR-064 governance** (pinned SHA, quarantine, scan, unknown licence not publishable, two approvers for executable skills) |
| D-41 | AI Intelligence Center: accept ADR-065 (module `knowledge`, schema, platform-published rows readable by customers only through a metadata view) | AI Intelligence S-K0 | Accept as proposed; SCR-K-01 approved with it | **DECIDED 2026-11-20 (owner): ADR-065 and SCR-K-01 accepted as drafted** |
| D-42 | Platform object store for library archives, snapshots and previews: provider/adapter, region, retention (ADR-052 follow-up) | AI Intelligence S-K1 | Dev filesystem adapter now; provider adapter once ADR-052's provider is chosen | **DECIDED 2026-11-20 (owner, interim): dev filesystem adapter now**; the provider adapter waits for the ADR-052 provider (that selection stays open) |
| D-43 | Licence policy for third-party themes and projects (many commercial themes forbid redistribution or SaaS derivatives) | AI Intelligence S-K2 | Unknown or restrictive licence ⇒ not activatable; counsel review before any commercial theme is used | **DECIDED 2026-11-20 (owner, interim): unknown or restrictive licence ⇒ not activatable**; counsel review before any commercial theme is used stays OPEN (legal) |
| D-44 | Malware scanning of uploads: an engine (where it runs) or none | AI Intelligence S-K2 | No claim of malware scanning; pattern + secret + executable policy only, until an engine is chosen | **DECIDED 2026-11-20 (owner, interim): no malware-scanning claim**; pattern, secret and executable policy only until an engine is chosen |
| D-45 | Parsing Dart/Flutter and other foreign source without running its SDK | AI Intelligence S-K4 | Bundled tree-sitter parsers, no execution | **DECIDED 2026-11-20 (owner): bundled tree-sitter parsers, no SDK execution** |
| D-46 | `ModelAdapter` tool-use extension and the coding-agent tool set (read/search/edit/run in sandbox) | AI Intelligence S-K6 | Separate spec change to `docs/09`; metered gateway only; Claude Code binary not used (D-38 stands) | **DECIDED 2026-11-22 (owner): progressive, provider-neutral Agentic Coding Engine as the TARGET architecture** ([ADR-066](adr/ADR-066-progressive-agentic-coding-engine.md), [SCR-K-10](spec-change-requests/SCR-K-10-agentic-coding-engine.md)): S-K6 single call kept as fallback; `ModelAdapter` v1.1 (structured output, tool calling, streaming, cancellation, usage; providers Anthropic/OpenAI/Google only as far as capabilities are verified); read-only tools first (`read_file`, `list_files`, `search_code`, `inspect_project`); controlled loop with diffs, validation, recovery, checkpoints; one allow-listed, metered, audited, tenant-isolated tool gateway; model tool calling kept separate from OS execution. **Still BLOCKED, unchanged:** build/test/shell/executable tools until D-21; production (D-42); live provider use (HG-09-01, D-18, credentials); Claude Code stays a separate optional integration (D-38). **Nothing of the engine is implemented**; not production-ready until implemented and verified (benchmarks, AC-AG-01..12) |
| D-47 | Embeddings: model/provider, residency, and whether the managed Postgres offers `vector` | AI Intelligence S-K5 | Deferred; lexical + metadata + symbol retrieval first; flag `knowledge.semantic_search` stays off | **DECIDED 2026-11-20 (owner, interim): lexical + metadata + symbol retrieval first**; embeddings stay BLOCKED (D-18, HG-09-01, `vector` probe); flag `knowledge.semantic_search` off |
| D-48 | Initial recommendation weights (functional 25, framework 20, architecture 20, design 15, quality 10, reuse 10) | AI Intelligence S-K5 | Accept as editable initial configuration, evaluated against outcomes, not proven optimal | **DECIDED 2026-11-20 (owner): initial weights accepted as editable configuration**, evaluated against outcomes |
| D-49 | Per-resource "AI processing permitted" default and who may change it | AI Intelligence S-K1 | Off by default; changed only with `admin:ai_knowledge:publish`; also needs residency and data-terms checks (HG-09-01) | **DECIDED 2026-11-20 (owner): off by default**; changed only with `admin:ai_knowledge:publish` and subject to residency and data-terms checks |
| D-50 | **DNet (dnet.sa) as the `.sa` / Saudi registrar route** (proposal from the owner's integration brief of 2026-11-21; refines D-19) | S30 follow-up | Add DNet as a `RegistrarAdapter` (`providerCode: dnet`) behind the existing M07 registrar framework; sell `.sa` suffixes only after HG-07-02 and HG-07-03 evidence and the TLD-policy `evidence_ref`; DNS stays Nuzm-operated unless the verified API offers `dns` (D-36). No adapter code until DNet's API documentation is supplied ([DNET-S1 assessment](reports/DNET-S1-assessment.md)) | OPEN |
| D-51 | **Dynadot as an additional registrar; Legacy API now, RESTful API later** (owner request 2026-11-24) | S30 follow-up | Add Dynadot as a `RegistrarAdapter` (`providerCode: dynadot`) built from the Legacy API (`api3.json`), the only generation whose commands could be read in full; Dynadot marks it "scheduled for retirement". Replace the transport with the RESTful API once its command reference is supplied (DYN-1). Nothing is sold until an administrator tests and enables an account and the evidence is live ([adapter note](adapters/dynadot.md)) | OPEN |
| D-52 | **HestiaCP replaces CloudPanel as the hosting panel** (owner request 2026-11-24; answers D-20, supersedes ADR-020 → [ADR-067](adr/ADR-067-hestiacp-hosting-panel.md)) | M06 follow-up | Nodes run HestiaCP, reached through its REST API with an allow-listed command profile; no node agent. Built and tested against a mock panel, NOT VERIFIED until a human-run probe on a real node. Later sprints (own sessions): VPS with auto-installed Hestia (Alibaba SCCC Riyadh, Contabo EU), WordPress, SFTP file manager and site tools, business email, off-server backups | OPEN |
| D-53 | **Backups, Managed WordPress and monitoring on HestiaCP** (HestiaCP sprint S06 + WordPress, 2026-11-24; [ADR-068](adr/ADR-068-hestia-backups-wordpress-monitoring.md)) | M06 follow-up | Off-server backups through Hestia's remote backup host measured in the region's store; WordPress reproduced from Hestia's documented commands with a one-time admin handover; restore drills on isolated `restore_drill` nodes; alerts; node setup script and per-plan packages. Built and tested against mock panels, NOT VERIFIED. Open inside it: D-07 production store and encryption at rest, restore staging path (SFTP stager), a second key for the WordPress role, domain change inside WordPress | OPEN |

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
| HG-07-03 | DNet reseller account + written API documentation (auth, endpoints, sandbox, webhooks, eligibility/document rules) + sandbox credentials | Owner | D-50 (DNet adapter) | Documentation in `docs/adapters/dnet-source/`; credentials in vault (non-production) |
| HG-08-01 | Data provider(s) for databases/Redis (D-05/D-06) contracted or verified; credentials | Owner | S32 | Contracts, keys, probe output |
| HG-08-02 | Object-storage provider (D-07) contracted or verified; credentials | Owner | S34 | Same |
| HG-08-03 | Business-email provider/program (D-09) contracted; reseller access | Owner | S35 | Contract, API access |
| HG-08-04 | Transactional email provider (D-08) contracted; sending domain, IP/domain warm-up plan, abuse policy | Owner | S36 | Contract, keys |
| HG-09-01 | Model provider API contracts and enterprise data terms | Owner | S37 | Contract refs. Status 2026-11-22: **OPEN**; Anthropic terms NOT accepted, no attestation exists ([S-AG4-DECISIONS](ai-intelligence/S-AG4-DECISIONS.md) D2) |
| HG-10-01 | Apple Developer / Google Play accounts and authorized signing material; macOS capacity | Owner | S49 | Account ids; keystore refs |
| HG-10-02 | Sandbox isolation security review | Security | S45 | Report |
| HG-10-03 | Independent authorship/ownership of the Reference CRM E2E suite (someone other than the generator's author/agent run) | Owner | S47 | Named author, repo ref, sign-off |
| HG-11-01 | Marketplace terms, publisher agreement, payout legal route | Legal | S53 | Documents |
| HG-11-02 | Third-party OAuth app registrations for connectors (client ids/secrets, review approvals) | Owner | S52 | App ids; secrets in vault |
| HG-12-01 | Independent penetration test (external vendor) | Owner | S56 | Final report, retest letter |
| HG-12-02 | SSO test tenants at enterprise IdPs | Owner | S55 | Tenant ids |
| HG-12-03 | Go/no-go decision, support training, runbook acceptance, on-call roster | Owner | S58 | Signed decision |

| HG-AS-01 | Register the Nuzm GitHub App (D-39) and store its app id, private key and webhook secret as vault references | Owner | AI Studio S-A7 | App id + vault refs |

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
