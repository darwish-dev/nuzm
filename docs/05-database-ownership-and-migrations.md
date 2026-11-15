# Nuzm — Database Ownership & Migration Strategy (draft)

Authoritative until bootstrap creates `spec/db/ownership.yaml`; afterwards the manifest wins and CI fails if a migration touches a schema its milestone does not own.

## 1. Rules
1. One PostgreSQL cluster, **one schema per module**. A module is the only writer of its schema.
2. Cross-module reads go through the owning module's service interface, a published read-only view (`<schema>.v_*`), or events via outbox. **No cross-schema foreign keys** except `org_id uuid` references to `tenancy.organizations` (enforced by RLS/tests, FK allowed to `tenancy.organizations(id)` only).
3. Every tenant table has `org_id uuid not null`, RLS enabled and forced, policy `org_id = current_setting('app.org_id')::uuid`. A test enumerates `information_schema` and fails if a table with `org_id` lacks a policy. Tenant-less tables are listed explicitly in the manifest.
4. Primary keys UUIDv7. `created_at`, `updated_at`, `version` (optimistic lock) on mutable tables. Soft-delete via `deleted_at` only where the product requires recovery; otherwise hard delete after retention rules (M04).
5. Money: `amount_minor bigint` + `currency char(3)`; never float. Rates `numeric(20,8)`. Quantities `numeric(24,8)`.
6. Region-bearing tables carry `data_region text` and `provider_region_id text` (M04 residency).
7. Secrets: columns hold `vault_ref text` only. Classified PII columns use application-level encryption (key refs from vault), designated in manifest `classification`.
8. **Append-only tables** (`billing.ledger_*`, `audit.audit_logs`, `invoicing.zatca_submissions`, `metering.usage_events`): `INSERT` only grants to runtime role, `UPDATE/DELETE` revoked, plus trigger raising on mutation; correction = new reversing row.
9. DB roles: `nuzm_migrator` (DDL), `nuzm_app` (DML, RLS-bound), `nuzm_worker` (DML, RLS-bound with explicit org switching), `nuzm_readonly_reporting` (views only), `nuzm_admin_breakglass` (audited, time-boxed).

## 2. Migration strategy
- Location: `packages/db/migrations/<schema>/<NNNN>__<schema>__<slug>.sql`, SQL-first, reviewed. `NNNN` is a **global ordinal** drawn from the owning milestone's reserved range (§2a); timestamps are not used in file names.
- **Forward-only in production**, every migration ships a documented reversal (`.down.sql` for dev/staging; production rollback = forward fix or restore) and a rollout note. Destructive changes use expand → backfill → contract across ≥2 releases.
- Migration CI: apply from empty; apply from previous release snapshot; lint (no locks > threshold, no `NOT NULL` without default on large tables); RLS coverage test; ownership test.
- Seed data separated into `packages/db/seeds/{reference,dev,test}`; reference data is migration-managed, dev/test never runs in production.
- Each milestone owns the contiguous range in §2a, recorded in `spec/db/ownership.yaml`; a milestone may add to a schema owned by an earlier milestone **only through that schema's owner module PR** (listed as "extends" below).

## 3. Schema ownership
| Schema | Owner module | Milestone (creates) | Extended by | Core tables |
|---|---|---|---|---|
| `platform` | platform | M01 | all (via owner PR) | `operations`, `operation_steps`, `outbox`, `idempotency_keys`, `feature_flags`, `notifications`, `webhook_events_inbound` (**no inventory table here**: `cloud.resources` is the only resource inventory) |
| `identity` | identity | M01 | M12 (sso) | `users`, `credentials_refs`, `sessions`, `mfa_factors`, `recovery_codes`, `api_keys`, `sso_connections` (M12), `scim_tokens` (M12) |
| `tenancy` | tenancy | M01 | M11 | `organizations`, `memberships`, `invitations`, `roles`, `permissions`, `role_permissions`, `workspaces`, `projects`, `environments` |
| `audit` | audit | M01 | M04, M12 | `audit_logs` (single store), `audit_checkpoints` (hash chain), `retention_policies` (M04), `legal_holds` (M04), `access_reviews` (M12) |
| `metering` | metering | M02 | all producers emit events | `meters`, `usage_events`, `usage_aggregates`, `rated_usage`, `provider_cost_records` (reconciliation results live only in `finrec`; M02 ships consistency *checks*, not a store) |
| `billing` | billing | M02 | M03, M11 | `ledger_accounts`, `ledger_transactions`, `ledger_postings`, `plans`, `plan_versions`, `price_books`, `price_book_versions`, `price_items`, `entitlements`, `quotas`, `spending_limits`, `spend_approvals`, `wallet_balances` (projection), `subscriptions` (M03), `dunning_cases` (M03), `reseller_price_rules` (M11) |
| `commerce` | commerce | M02 | M05..M08 | `quotes`, `quote_items`, `orders`, `order_items`, `authorizations` |
| `payments` | payments | M03 | — | `psp_accounts`, `customers_psp`, `payment_methods` (token refs), `payment_intents`, `payment_attempts`, `refunds`, `psp_events` (reconciliation results only in `finrec`) |
| `invoicing` | invoicing | M03 | M11 | `billing_entities` (issuer legal entities), `tax_profiles`, `tax_rates`, `invoices`, `invoice_lines`, `credit_notes`, `invoice_sequences`, `zatca_onboarding`, `zatca_credentials_refs`, `zatca_documents`, `zatca_submissions` (append-only) |
| `finrec` | finrec | M03 | M05 (cost) | `reconciliation_runs`, `reconciliation_items`, `reconciliation_resolutions` (single financial reconciliation store; replaces per-module reconciliation tables) |
| `compliance` | compliance | M04 | M12 | `consents`, `dsr_requests`, `dsr_tasks`, `ropa_entries`, `data_classes`, `residency_policies`, `transfer_assessments`, `control_catalog`, `control_mappings`, `evidence_items`, `breach_cases`, `regulatory_validations`, `policy_versions` (M12) |
| `cloud` | cloud | M05 | M06..M08 | `providers`, `provider_accounts`, `provider_regions`, `provider_plans`, `provider_capabilities`, `catalog_snapshots`, `routing_rules`, `resources` (generic inventory: kind, provider ref, state, org, data_region), `resource_reconciliations` |
| `compute` | compute | M05 | — | `instances`, `instance_actions`, `images`, `snapshots` |
| `hosting` | hosting | M06 | M10 (none) | `nodes`, `node_capacity`, `site_allocations`, `sites`, `site_quotas`, `site_backups`, `ssl_certificates`, `site_domain_bindings`, `abuse_cases`, `node_agents` |
| `domains` | domains | M07 | — | `registrars`, `registrar_accounts`, `domains`, `domain_contacts`, `domain_orders`, `domain_transfers`, `dns_zones`, `dns_records`, `eligibility_checks` |
| `data` | data | M08 | — | `database_instances`, `database_backups`, `database_restores`, `storage_buckets`, `bucket_policies`, `data_providers` (selection config) |
| `email` | email | M08 | — | `email_domains`, `mailboxes`, `aliases`, `sender_identities`, `messages`, `email_events`, `templates`, `suppressions` |
| `ai` | ai | M09 | M10 | `sessions`, `messages`, `runs` (**single** agent run table), `run_steps` (M10), `tool_calls` (M10), `artifacts`, `model_providers`, `model_usage`, `budgets`, `credit_balances`, `evaluations` (**created M09** for the website eval harness; M10 extends) |
| `builder` | builder | M09 | M10 | `projects` (type website/webapp/mobile), `project_files` (**single** file store), `project_versions`, `changes`, `previews`, `pages`, `forms`, `form_submissions`, `cms_collections`, `cms_items`, `sandboxes` (M10), `test_runs` (M10), `exports` (M10), `git_repos` (M10), `app_specs` (M10) |
| `deploy` | deploy | M09 | M10 | `deployments`, `deployment_logs`, `builds` (moved out of `hosting`) |
| `mobile` | mobile | M10 | — | `builds`, `artifacts`, `signing_credential_refs`, `releases` |
| `automation` | automation | M11 | — | `workflows`, `workflow_versions`, `executions`, `execution_steps`, `connectors`, `connector_authorizations`, `dead_letters`, `webhook_endpoints`, `webhook_deliveries` |
| `marketplace` | marketplace | M11 | — | `listings`, `listing_versions`, `purchases`, `entitlements_mkt`, `v_entitlements` (view consumed by the billing entitlement resolver), `installations`, `publisher_accounts`, `moderation_cases` |
| `programs` | programs | M11 | — | `agencies`, `agency_clients`, `delegated_access`, `resellers`, `reseller_sub_orgs` |
| `ops` | ops | M12 | — | `incidents`, `incident_updates`, `alerts`, `provider_incidents`, `recovery_exercises`, `slo_definitions`, `launch_gates` |

## 4. Duplicates and conflicts removed from v3
| v3 conflict | Resolution |
|---|---|
| `security.audit_logs` (M12) vs audit trails (M01) | Single `audit.audit_logs`; M12 only adds retention, review, export |
| `ai.agent_runs` in M08 and M09 | One `ai.runs`; M09 creates, M10 adds `run_steps`/`tool_calls` |
| `builder.generated_files` in M08 and M09 | One `builder.project_files` |
| `hosting.builds/deployments` inside hosting schema (M09) | `deploy.*` schema; hosting stays site/node focused |
| `cloud.quotes` + domain quotes + hosting quotes | `commerce.quotes` |
| `cloud.reconciliations`, domain/hosting reconciliations, M12 reconciliation | `finrec.*` (financial) and `cloud.resource_reconciliations` (technical state); no others |
| `cloud.resource_operations`, `hosting.site_operations` | `platform.operations` |
| `billing.ledger_accounts` vs `payments` ledger duplicates | Only `billing.ledger_*` has postings |
| `mobile.mobile_projects` | `builder.projects` type `mobile` |
| `marketplace.entitlements` vs `billing.entitlements` | Marketplace entitlements stored as `marketplace.entitlements_mkt`, exposed to billing entitlement resolver via view |

## 5. Event contracts (outbox topics, schema in `spec/events/`)
`org.created` · `resource.state_changed` · `usage.recorded` · `invoice.issued` · `payment.succeeded|failed` · `ledger.posted` · `domain.registered` · `site.deployed` · `ai.run.completed` · `compliance.dsr.opened` · `provider.incident.opened`. Events carry `eventId` (dedupe key), `orgId`, `occurredAt`, `schemaVersion`.

## 6. Backup/restore and residency
Control-plane DB: PITR with WAL archive to in-Kingdom storage when verified (D-15); restore drill in M12 and a lighter restore verification in M01 bootstrap CI (restore dump into scratch DB). Tenant data in `data`/`hosting` is backed up by the owning module with `data_region` honoured.

## 2a. Reserved migration ranges (ordinal)
M01 0001–0199 · M02 0200–0299 · M03 0300–0499 · M04 0500–0599 · M05 0600–0799 · M06 0800–0899 · M07 0900–0999 · M08 1000–1199 · M09 1200–1399 · M10 1400–1599 · M11 1600–1699 · M12 1700–1799. Hotfix migrations use the owning milestone's range if free, otherwise the next 9000-series number with an ADR note.

## 7. Reconciliation classes (single definition)
**Financial — stored only in `finrec`; run through `/v1/admin/billing/reconciliations`** (definitions, matching keys and tolerances in `11-payments-billing-zatca-track.md`): RC-01 payments vs PSP settlements · RC-02 ledger vs invoices/credit notes · RC-03 rated usage vs invoice lines · RC-04 provider/registrar cost vs bills (ledger cost accounts) · RC-05 ZATCA submissions vs invoices · RC-06 wallet projection vs ledger.
**Technical — stored only in `cloud.resource_reconciliations`:** TR-01 compute/cloud resources vs provider inventory · TR-02 hosting nodes/sites vs node report · TR-03 domains vs registrar state · TR-04 data/email resources vs provider state.
No other reconciliation tables may be created.

## 8. Modeling notes accepted from milestone drafting
1. Org→plan assignment is an `entitlements` row with `source='plan'` (M02); `subscriptions` (M03) links to it; no separate assignment table.
2. Subscription items are stored as a JSON column on `billing.subscriptions` in M03 (promote to a table only by owner PR).
3. Dunning policy is configuration (`spec/billing/dunning-policy.yaml`), not a table.
4. Domain renewals and reminders: `domains.domain_orders.type='renewal'` plus `platform.notifications`; no extra tables.
5. Database/bucket credential rotations and compliance data exports are `platform.operations` records with vault refs/export sinks, not tables. Consent purposes are catalogued in `spec/compliance/purposes.yaml`. Breach-case timeline is a JSON column on `compliance.breach_cases`. A residency exception is an *approved* `compliance.transfer_assessments` row.
6. ADR numbers continue after 016 (ADR-017+).
7. Event topics beyond §5 are added per milestone in `spec/events/` with the owning milestone recorded; a topic with no registered owner fails CI.

## 9. Conventions adopted from the execution-pack PDF (compatible additions)
1. Canonical hierarchy: user → organization → workspace → project → environment → resource.
2. Provider identifiers live **only** in `cloud`-owned mapping columns/tables (`cloud.resources.provider_ref`, provider-specific mapping tables); other schemas reference Nuzm UUIDs.
3. Canonical resource states (`cloud.resources.state`): `DRAFT, QUOTED, AWAITING_PAYMENT, PROVISIONING, ACTIVE, FAILED, DELETING, DELETED, UNKNOWN`. `UNKNOWN` = outcome uncertain; only the reconciler may leave it.
4. Soft-delete uses tombstones: `deleted_at` + `tombstone_until`; hard purge runs only after the retention rules (M04) and any legal hold.

