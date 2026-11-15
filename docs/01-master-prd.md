# Nuzm — Master PRD (Revised, v4.0-draft)

Status: **DRAFT — awaiting owner review. No implementation may start until approved.**
Supersedes: "Cloud + AI Full Platform PRD v2.0 / Prompt Pack v3.0". Every change is listed in `00-change-log-from-v3.md`.
Nothing here claims an integration, certification, credential, provider capability or regulatory approval exists. Items depending on those are tracked in `07-open-decisions-and-blockers.md`.

## 1. Vision
Nuzm is an all-in-one hybrid cloud and AI platform. A customer can buy compute, shared hosting, domains, managed data and email, then build websites, full-stack web apps and mobile apps with AI, and run them on the same account, with one bill, one usage view and one compliance posture. It is built for Saudi Arabia first (Arabic/RTL, SAR, VAT, ZATCA e-invoicing, Saudi data residency where verified) and extensible to other regions.

## 2. Scope (approved full-platform scope is preserved)
| Pillar | Capability | Milestone |
|---|---|---|
| Foundation | Identity, orgs, workspaces, projects, RBAC, MFA, audit, durable operations, portal shells | M01 |
| Money core | Double-entry ledger, plans, entitlements, centralized usage metering, rating, quotas, spend approval | M02 |
| Commerce | Payments, subscriptions, invoicing, VAT, ZATCA e-invoicing, dunning, financial reconciliation | M03 |
| Compliance | PDPL, data residency engine, NCA/CST control mapping, evidence, regulatory validation | M04 |
| Cloud compute | Provider framework + Alibaba Cloud, Huawei Cloud (Saudi regions only when verified), Contabo (EU VPS) | M05 |
| Shared hosting | CloudPanel-managed, platform-operated nodes, multi-customer isolation | M06 |
| Domains | Openprovider + ResellerClub adapters, DNS, hosting linkage | M07 |
| Managed data & email | Databases, Redis, object storage, business email, transactional email | M08 |
| AI core + website builder | Model gateway, prompt-to-site, visual editor, publish | M09 |
| Full-stack + mobile builder | Agents, sandbox, IDE, tests, deploy; Flutter builds and release prep | M10 |
| Automation, marketplace, programs | Workflows, marketplace, agency and reseller programs | M11 |
| Enterprise & launch | SSO/SCIM, load/DR/security testing, reconciliation, GA gates | M12 |

Provider strategy (unchanged): CloudPanel for platform-operated shared-hosting nodes; Alibaba Cloud and Huawei Cloud ECS in Saudi regions **only when verified per account**; Contabo for European VPS **subject to the actual account API and plan capabilities**; Openprovider and ResellerClub as initial domain adapters, with OpenSRS/CentralNic/eNom/Namecheap/GoDaddy as optional candidates subject to commercial and API verification.

## 3. Personas and portals
| Portal | App | Primary users |
|---|---|---|
| Customer Console | `apps/web` (route group `(customer)`) | Founders, developers, SME owners, non-technical site owners |
| Agency Portal | `apps/web` (route group `(agency)`) | Agencies managing delegated client organizations |
| Reseller Portal | `apps/web` (route group `(reseller)`) | Wholesale partners selling Nuzm services under their own pricing |
| Admin Console | `apps/admin` (separate deployment, separate auth realm, network-restricted) | Nuzm operators: support, finance, compliance, security, SRE |

Definitions: **Agency** = delegated *access* to client organizations; billing stays with the client unless the client opts into consolidated billing. **Reseller** = wholesale *commercial* relationship; sub-organizations are billed at reseller price books. Whether the reseller is merchant/invoice issuer of record is open decision D-24 (tax/legal).

### Role catalogue (owned by M01; permission names `domain:resource:action`)
Organization roles: `owner`, `admin`, `billing_admin`, `developer`, `viewer`. Platform (admin realm) roles: `platform_admin`, `support`, `finance`, `compliance_officer`, `security`, plus operational roles `provider_admin`, `hosting_admin`, `sre` (added by M05/M06/M12 as role-permission seeds through the M01 owner module). Agency/reseller delegation uses scoped grants, not new org roles.

## 4. Product principles
1. Capability-driven: nothing is offered unless verified for that provider account, plan and region.
2. Money is exact: integer minor units, append-only ledger, idempotent callbacks, quote → authorize → record → reconcile.
3. Tenant isolation is a database property (RLS) and an API property (verified org context), not a convention.
4. Everything long-running is a durable operation reconciled against the provider before any retry.
5. Everything billable emits a metering event through one pipeline.
6. Arabic/RTL and English are first-class in every UI screen from M01.
7. AI-generated code is untrusted; spend and destructive actions are capped and human-approved.
8. Evidence over assertion: acceptance is PASS only with recorded command output or artifacts.

## 5. Requirement catalogue (traceability IDs)
Each ID is owned by exactly one milestone; milestone prompts must cite the IDs they close.
- **FR-IAM-01..08** (M01): OIDC login; session lifecycle; MFA enroll/recovery; scoped API keys; org/workspace/project/environment CRUD; invitations; RBAC; audit trail.
- **FR-PLT-01..05** (M01): durable operations; transactional outbox; idempotency keys; feature flags; notifications.
- **FR-LED-01..05** (M02): double-entry ledger; plan/entitlement model; spend limits and approvals; credits/wallet; ledger statements.
- **FR-MTR-01..08** (M02): meter catalogue; ingestion with dedupe; aggregation; price books and rating; quota enforcement; provider cost capture; usage UI/API; metering reconciliation.
- **FR-PAY-01..10** (M03): PSP abstraction; payment methods; subscriptions; invoices; VAT; credit notes/refunds; dunning; wallet top-up; payment reconciliation; revenue reports.
- **FR-ZAT-01..08** (M03): invoice model for ZATCA; UBL XML; hash chain/counter; QR; cryptographic stamp; onboarding; clearance/reporting; archive/retry.
- **FR-CMP-01..10** (M04): consent; DSR workflow; ROPA; retention/legal hold; residency policy engine; cross-border transfer controls; NCA control register; evidence; incident notification workflow; regulatory validation register.
- **FR-CLD-01..10** (M05): adapter contract; catalog/capability matrix; credential vault; routing; quotes; durable resource ops; reconciler; Alibaba; Huawei; Contabo.
- **FR-HST-01..08** (M06): node inventory; scheduler; site lifecycle; isolation; SSL; quotas; backups/restore; abuse controls.
- **FR-DOM-01..08** (M07): search; quote; register; transfer; renew; DNS; contacts/eligibility; hosting linkage.
- **FR-DAT-01..10** (M08): managed DB; Redis; object storage; mailbox; email DNS auth; transactional send; suppression; events; metering; restore.
- **FR-AIC-01..08** (M09): model gateway; budgets; sessions; requirements agent; generation; visual editor; versioning; publish.
- **FR-APP-01..10** (M10): agent graph; schema/backend/frontend gen; sandbox; IDE; Git; tests; deploy/rollback; export; Flutter generation; signed builds/release prep.
- **FR-AUT-01..04 / FR-MKT-01..05 / FR-PRG-01..06** (M11): workflows; connectors; marketplace; agency and reseller programs.
- **FR-ENT-01..06 / FR-OPS-01..08** (M12): SSO/SAML/OIDC; SCIM; access reviews; audit retention; load/chaos/DR; incident tooling; launch gates.
- **FR-UI-xx**: owned by the milestone that delivers the screen (see `13-dashboards-spec.md`).

*Numbering rule:* requirement ranges are assigned in the order listed in each milestone's prompt; a prompt's per-ID mapping is authoritative for that milestone once approved.

## 6. Non-functional requirements (measurable; targets are proposals pending D-30 SLO approval)
| Area | Target |
|---|---|
| Availability (control plane API) | proposed 99.9% monthly |
| API latency | p95 < 300 ms for reads, < 800 ms for non-provider writes (excl. async ops) |
| Tenant isolation | 0 cross-tenant reads in automated suite on every table with `org_id` |
| Money | ledger imbalance = 0; duplicate callback effect = 0; daily reconciliation variance reported and < threshold set by finance (D-31) |
| Recovery | RPO/RTO proposed 15 min / 4 h for control plane DB; evidenced in M12 DR exercise |
| Accessibility | WCAG 2.1 AA on customer flows; RTL parity |
| Security | OWASP ASVS L2 target; no open critical/high findings at GA |
| Observability | trace id on every request and operation; audit event on every mutation |

## 7. Out of scope
Building own datacenters; operating a payment institution (use licensed PSP); acting as registrar of record; guaranteeing app-store approval; marketplace publisher payout until licensing is confirmed (D-26).

## 8. Key assumptions
A1 One engineering team executing sprints sequentially unless D-02 approves parallel lanes. A2 Platform operates in SAR with USD/EUR display and provider cost capture in provider currency. A3 Legal counsel confirms regulatory applicability; this PRD does not constitute legal advice. A4 Provider accounts, PSP merchant account, ZATCA onboarding, and registrar accounts are obtained by humans (see blockers register).

## 9. Risks (top)
| ID | Risk | Mitigation |
|---|---|---|
| R1 | Provider lacks Saudi region or API for a feature | Capability matrix; feature disabled; BLOCKED status |
| R2 | ZATCA spec/onboarding changes | Isolate in `invoicing-zatca` module; spec version pinned; sandbox first |
| R3 | PSP/KSA payment eligibility | PSP abstraction; D-10 |
| R4 | Scope growth (58 sprints) | Parallel lanes option; gating review at each milestone |
| R5 | AI spend runaway | Budget caps in gateway; approvals |
| R6 | Shared-hosting escape | CloudPanel isolation validation; per-site Linux users, quotas; pen test |
| R7 | Regulatory classification as cloud service provider | Counsel review early (HG-CMP-01) |

## 10. Glossary
Org (tenant) · Workspace · Project · Environment · Operation (durable async job) · Quote · Order · Entitlement · Meter · Price book · Rating · Residency policy · Adapter · Capability · CSID (ZATCA cryptographic stamp identifier) · DSR (data subject request) · ROPA (record of processing activities).
