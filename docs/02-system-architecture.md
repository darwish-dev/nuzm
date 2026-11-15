# Nuzm — System Architecture (Revised, draft)

All decisions marked **ADR-P** are *proposed defaults*; they become binding only when recorded as accepted ADRs in the repo (`docs/adr/`) after owner approval. Alternatives are in `07-open-decisions-and-blockers.md`.

## 1. Style
**Modular monolith + worker processes**, with strict module boundaries enforced by lint rules and per-module database schemas. Services are extracted later only with evidence. (ADR-P-001)

```
                     ┌────────────┐   ┌─────────────┐
 Browser ──────────► │ apps/web   │   │ apps/admin  │  Next.js (App Router), Arabic/RTL + English
                     └─────┬──────┘   └──────┬──────┘
                           │  typed client generated from spec/openapi
                     ┌─────▼─────────────────▼──────┐
                     │ apps/api  (NestJS)           │  HTTP, authz, validation, idempotency
                     │  modules = bounded contexts  │
                     └───┬───────────┬──────────────┘
          outbox/jobs    │           │ RLS + org context
                  ┌──────▼───┐  ┌────▼─────────┐   ┌───────────┐
                  │ Redis    │  │ PostgreSQL   │   │ Vault/KMS │ secret references only in DB
                  │ (BullMQ) │  │ schema/module│   └───────────┘
                  └──────┬───┘  └────▲─────────┘
                 ┌───────▼───────────┴─────────┐
                 │ apps/worker (NestJS context)│ durable operations, reconcilers, metering, ZATCA submit
                 └───────┬─────────────────────┘
        packages/adapters/{alibaba,huawei,contabo,cloudpanel,openprovider,resellerclub,psp-*,zatca,email-*,storage-*,...}
                         │ egress allow-list, per-adapter credentials from vault
                 external providers
```

## 2. Repository layout (created during bootstrap, doc 08)
```
apps/api  apps/worker  apps/web  apps/admin  apps/node-agent (CloudPanel agent, M06 only if required)
packages/{contracts,db,domain,adapters,ui,i18n,config,testing,telemetry,sdk}
spec/{openapi,db,milestones,providers,compliance}      # machine-readable single source of truth
docs/{adr,runbooks,reports,milestones}
infra/{docker,terraform-or-equivalent,ci}
```

## 3. Core platform mechanisms (all built in M01 unless stated)
| Mechanism | Design |
|---|---|
| Org context | Derived from verified token/API-key claims, never from request body. Per-request `SET LOCAL app.org_id`; Postgres RLS on every tenant table. Platform-admin access uses a separate DB role with audited break-glass. |
| Authz | RBAC (roles → permissions) + resource-level checks through one `PolicyService`; deny by default. ABAC attributes for residency/classification (M04). |
| Idempotency | `Idempotency-Key` required on side-effecting POSTs; stored in `platform.idempotency_keys` with request hash and response. Provider calls carry derived idempotency tokens where the provider supports them; otherwise the reconcile-before-retry rule applies. |
| Durable operations | `platform.operations` (state machine: `pending → running → waiting_provider → succeeded | failed | cancelled | needs_reconcile`), step log, lease/heartbeat, retry policy. One table for all modules. |
| Transactional outbox | `platform.outbox` written in the same transaction as the state change; relay publishes to queue and internal event consumers (metering, audit, notifications, webhooks). |
| Audit | Single `audit.audit_logs` (append-only, hash-chained per partition), written via outbox consumer plus synchronous critical events. Retention/legal hold from M04, extended in M12. |
| Feature flags | `platform.feature_flags` with org and global scope; every new capability ships behind a flag. |
| Observability | OpenTelemetry traces/metrics/logs; trace id returned in `traceparent` and problem+json. |
| Secrets | Only vault references in DB (`vault://…`). Local dev uses a file-based dev vault stub; production vault product is decision D-12. |

## 4. Financial architecture
`metering` (events → aggregates → rated usage) → `billing` (ledger, plans, entitlements, spend control) → `invoicing` (invoices, tax, ZATCA) → `payments` (PSP). Rule: **only `billing.ledger` posting service writes ledger rows**; other modules emit events or call the posting API. Details: `11-payments-billing-zatca-track.md`, `12-metering-spec.md`.

## 5. Provider orchestration
`cloud` module owns provider registry, provider accounts, capabilities, catalog, routing, quotes→orders, resource inventory. Each provider-facing module (compute, hosting, domains, data, email) talks only to an **adapter interface** (doc 09). Adapters never write DB; they return typed results and raw-evidence blobs; the orchestrator persists. Reconciler compares `platform.operations`/inventory with provider truth on schedule and before any retry of an uncertain operation.

## 6. Residency and compliance
`compliance` module exposes `ResidencyPolicyService.evaluate(orgId, dataClass, targetRegion)` used by routing, storage, backup, AI gateway (model/region), email, and exports. Every region-bearing resource stores `data_region` and `provider_region_id`. Defaults and legal interpretation are decisions (D-14..D-18), not code assumptions.

## 7. AI architecture (M09/M10)
Model gateway (provider-agnostic, per-org budgets, token metering, region/residency aware) → agent runner (task graph, checkpoints, approvals) → **sandbox runner** on isolated compute (no platform secrets, egress allow-list, CPU/mem/time/disk quotas, ephemeral) → artifact store → deployment pipeline. The control plane never executes generated code.

## 8. Frontend architecture
Next.js App Router, TypeScript strict, shared `packages/ui` design system (tokens, RTL logical properties, Arabic typography), `packages/sdk` generated from OpenAPI, server components for data screens, React Query for client state, i18n via `packages/i18n` (ar default configurable, en). Portal gating by org type and role; a context switcher moves between customer org, agency, reseller. Admin app is a separate Next.js deployment and auth realm. Full screen inventory: `13-dashboards-spec.md`.

## 9. Environments
`local` (docker-compose, all adapters in mock mode) · `ci` · `staging` (sandbox/test credentials only; live provider calls only in explicitly flagged "live verification" jobs, human-triggered) · `production`. No production provider credentials in non-production environments.

## 10. Security baseline (every milestone inherits)
TLS everywhere; argon2id for any local secrets; secrets in vault; least-privilege DB roles per module (migration role ≠ runtime role ≠ read-only reporting role); dependency and secret scanning in CI; SBOM; signed container images; rate limiting; CSRF/CORS policy; webhook signature verification and replay window; PII field encryption for classified fields (M04); backups encrypted; audit on every mutation.

## 11. Proposed ADR list (seed at bootstrap, status Proposed)
001 Modular monolith · 002 pnpm + Turborepo · 003 Contract-first OpenAPI + generated SDK · 004 Postgres schema-per-module + RLS · 005 SQL-first migrations, forward-only with documented reversal · 006 Next.js apps split (web + admin) · 007 Outbox + BullMQ durable operations (alternative: Temporal) · 008 Identity provider (see D-04) · 009 Money as integer minor units · 010 Ledger append-only enforcement · 011 Adapter contract + conformance kit · 012 Residency policy engine · 013 Metering pipeline · 014 ZATCA module isolation · 015 Sandbox isolation model · 016 Secrets/vault approach.
