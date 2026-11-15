# Nuzm — Updated Sprint Roadmap (draft)

Baseline: **58 two-week sprints (116 weeks) executed sequentially by one team**, up from 43 in v3. The +15 sprints are: money core split and expanded (M02), payments/invoicing/ZATCA (M03), compliance (M04), dashboards embedded in every milestone, and larger provider/data scope. Calendar compression requires D-02 (team size / parallel lanes). Dates are not committed here.

| Sprint | Milestone | Focus | Exit evidence of sprint |
|---|---|---|---|
| S01 | M01 | **Bootstrap**: repo, tooling, CI, spec/ skeleton, ADRs, local env, design-system skeleton | `verify:all` green on empty skeleton; ADR-001..016 recorded |
| S02 | M01 | Identity: OIDC, sessions, MFA, API keys; platform tables (operations, outbox, idempotency) | Auth e2e; MFA recovery test |
| S03 | M01 | Tenancy: orgs, workspaces, projects, environments, invitations, RBAC, RLS suite | Cross-tenant suite green |
| S04 | M01 | Audit, notifications, portal shells (web + admin), i18n/RTL, admin basics | Portal shells demo; audit hash-chain test |
| S05 | M02 | Ledger (double-entry), accounts, append-only enforcement, plans/entitlements | Ledger balance property tests |
| S06 | M02 | Metering pipeline: meters, ingestion, dedupe, aggregation, price books, rating | Replay/duplicate test; rating fixtures |
| S07 | M02 | Quotas, spend limits/approvals, `commerce.quotes`, usage UI, admin price-book UI | End-to-end usage→rated→ledger demo |
| S08 | M03 | Billing entities, tax profiles, VAT engine, invoice domain model, invoice PDF | Invoice fixtures with VAT |
| S09 | M03 | PSP abstraction + first PSP adapter (sandbox), payment methods, intents, webhooks | Duplicate-webhook test |
| S10 | M03 | Subscriptions, proration, wallet top-up, dunning, credit notes/refunds | Subscription lifecycle e2e |
| S11 | M03 | ZATCA: UBL XML, counter/hash chain, QR, stamping, sandbox onboarding & submission *(needs HG-M03 items)* | ZATCA sandbox validation evidence |
| S12 | M03 | Financial reconciliation framework (`finrec`), revenue reports, billing UI (customer + admin) | Reconciliation fixtures green |
| S13 | M04 | Compliance foundations: data classification, ROPA, consent, retention/legal hold | Services + tests |
| S14 | M04 | Residency policy engine + enforcement hooks, transfer assessments, DSR workflow | Policy matrix tests |
| S15 | M04 | NCA/CST control register, evidence collectors, breach workflow, compliance UI, validation register | Control-mapping report |
| S16 | M05 | Adapter contract, conformance kit, vault refs, provider accounts/health, catalog/capabilities | Mock adapter passes kit |
| S17 | M05 | Routing, quotes→orders, durable resource ops, reconciler, cost authorization, compute API skeleton | Timeout-reconcile test |
| S18 | M05 | Alibaba ECS adapter I: auth, region/catalog verification (Saudi), pricing capture *(needs HG-M05 creds)* | Verified-region report |
| S19 | M05 | Alibaba II: provision/inspect/actions/delete, bill reconciliation | Sandbox/live-marked tests |
| S20 | M05 | Huawei ECS adapter I: auth, region/catalog verification *(HG)* | Verified-region report |
| S21 | M05 | Huawei II: lifecycle, bill reconciliation | Same as S19 |
| S22 | M05 | Contabo adapter: plan-capability detection, EU locations, lifecycle subset | Capability matrix report |
| S23 | M05 | Compute console UX (customer/admin), cost reconciliation, M05 acceptance | Gate review |
| S24 | M06 | CloudPanel validation (documented API vs node agent), node inventory PoC | Decision record D-20 |
| S25 | M06 | Scheduler, site lifecycle, domains/SSL, DB bindings | Site e2e on mock + test node |
| S26 | M06 | Isolation, quotas, backups/restore, node maintenance | Isolation test report |
| S27 | M06 | Hosting billing/metering, abuse controls, hosting UI | Gate review |
| S28 | M07 | Registrar adapter contract, Openprovider search/quote/register (sandbox) *(HG)* | Contract tests |
| S29 | M07 | ResellerClub adapter, renewals, transfers, contacts | Contract tests |
| S30 | M07 | DNS engine, zone/records, eligibility incl. Saudi TLD gating, webhooks | Duplicate-webhook test |
| S31 | M07 | Hosting linkage, domain UI, reconciliation, acceptance | Gate review |
| S32 | M08 | Data provider decision records (D-05..D-09) + `DataProviderAdapter`s; managed PostgreSQL/MySQL lifecycle | Provisioning + backup |
| S33 | M08 | Restore tests, Redis, credential rotation, DB UI | Restore evidence |
| S34 | M08 | Object storage, policies, signed URLs, lifecycle, quotas | Isolation tests |
| S35 | M08 | Business email provisioning + DNS auth (SPF/DKIM/DMARC/MX) | Verification evidence |
| S36 | M08 | Transactional email, suppression, events, metering; M08 acceptance | Gate review |
| S37 | M09 | Model gateway, budgets, residency-aware model routing, credits | Budget-cap test |
| S38 | M09 | Sessions, requirements/architecture agents, templates, Arabic RTL | Eval set |
| S39 | M09 | Website generation, previews, asset handling | Preview isolation test |
| S40 | M09 | Visual editor, AI edits, safe diffs, versioning | Edit round-trip tests |
| S41 | M09 | SEO, forms/CMS, deployments (publish), custom domain; acceptance | Gate review |
| S42 | M10A | Agent graph, checkpoints, approvals; schema/backend agents | Graph tests |
| S43 | M10A | API contract + RBAC scaffolding generation | Contract tests |
| S44 | M10A | Frontend agents, end-to-end scaffold | Reference CRM scaffold |
| S45 | M10A | Sandbox runner (isolation tech per D-21), terminal, quotas | Escape-attempt test report |
| S46 | M10A | Browser IDE, Git, test runner, bounded debugging | IDE e2e |
| S47 | M10A | App deployments, rollback, export; **M10A Gate** (Reference CRM independent E2E) | Gate review |
| S48 | M10B | Flutter templates, mobile design agent, device previews | Template build test |
| S49 | M10B | Build workers, signing refs, artifacts *(needs HG-M10 accounts, macOS capacity)* | Signed artifact evidence |
| S50 | M10B | Release preparation workflow; M10 acceptance | Gate review |
| S51 | M11 | Workflow engine, triggers, retries, DLQ, execution logs | Idempotent retry tests |
| S52 | M11 | Connector OAuth/scoped tokens, outbound webhooks, rate limits | Unauthorized connector test |
| S53 | M11 | Marketplace listings/versions/moderation/purchases/entitlements | Entitlement tests |
| S54 | M11 | Agency + reseller programs, billing statements, portals; acceptance | Gate review |
| S55 | M12 | SSO/SAML/OIDC, SCIM, access reviews, audit retention | SSO e2e (test IdP) |
| S56 | M12 | Load, chaos, security assessment; engage independent pen test *(HG)* | Reports |
| S57 | M12 | Provider/billing full reconciliation, DR backup/restore exercises, observability/runbooks | DR evidence |
| S58 | M12 | Full regression, support handover, go/no-go **decision package** | Launch decision (human) |

## Roadmap rules
1. A sprint may be **entered** with mocks only where the prompt's "Mocked interfaces" table allows it.
2. Sprints marked *(HG)* contain work that stops at a human gate; the agent completes everything automatable, marks the rest BLOCKED, and the sprint may close "Done with BLOCKED items" only if the blocker is non-critical-path (documented in gate review).
3. Re-planning requires a change-log entry in `docs/00-change-log-from-v3.md` (or successor).

## Changes versus v3 (summary; full list in change log)
v3 M01..M12 (43 sprints) → v4 M01..M12 (58 sprints). Merged old M03+M04 into M05; old M02 became part of M05; old M05→M06; old M06→M07; old M07→M08; old M08→M09; old M09+M10→M10; old M11→M11 (expanded with reseller); old M12→M12. New: M02, M03, M04.
