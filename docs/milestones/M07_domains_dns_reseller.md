# M07 — Domains & DNS Reseller

Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.

| Field | Value |
|---|---|
| Sprints | S28–S31 (4 sprints) |
| Depends on (docs/03) | **H:** M01, M02, M03, M04, M05 · **S:** M06 (hosting linkage acceptance needs it) |
| Produces | `RegistrarAdapter` implementations (Openprovider, ResellerClub), domain commerce flow, DNS zone engine, eligibility engine, `DnsLinkagePort` for hosting/email/AI publish |
| Gate | Gate Review signed (docs/03 §5); `spec/` in sync; all acceptance rows PASS or listed BLOCKED with HG owner |
| Response format | CLAUDE.md §10 (A–I) |

## 1. Objective
Deliver registrar-agnostic domain commerce (search → quote → authorize → register/transfer/renew → reconcile) and a DNS engine, using Openprovider and ResellerClub as the initial adapters. The platform must never double-register or double-charge on timeout or duplicate webhook, must block ineligible/unsupported TLD orders **before payment**, and must link domains to M06 hosting sites with HTTPS. Optional registrars (OpenSRS, CentralNic, eNom, Namecheap, GoDaddy) are *not* built here; the contract must make them addable.

## 2. Preconditions & mocked interfaces
| Interface | Status at start | Allowed mock until | Real needed for |
|---|---|---|---|
| M01 auth/RBAC/operations/outbox/idempotency/audit | DONE (gate) | — | all |
| M02 `LedgerPostingService`, `commerce.quotes`, spend approval, `MeteringIngestService` | DONE | — | all |
| M03 PSP intents, invoices, `finrec` framework | DONE | PSP **sandbox** only | AC-M07-12 live charge BLOCKED (HG-03-02) |
| M04 `ResidencyPolicyService`, consent, transfer assessment | DONE | — | contacts PII flow |
| M05 adapter framework, conformance kit, vault refs, `cloud.providers/provider_accounts` | DONE | — | adapter registration |
| M06 `HostingSiteReadPort`, `hosting.sites`, SSL issuance | may be in progress | in-memory fake **for dev/CI only** | AC-M07-14 (HTTPS linkage) |
| Openprovider / ResellerClub APIs | no credentials | recorded sandbox fixtures + local mock server | HG-07-01 (any live/sandbox-account evidence) |
| `.sa`/restricted TLD registration route | unknown | none: treated as **unsupported** | HG-07-02 |

Mocks are labeled `NOT VERIFIED` in every report. A mock may test gating logic; it may never produce a PASS for a row that requires vendor evidence.

## 3. Requirement IDs closed (docs/01 §5)
FR-DOM-01 search · FR-DOM-02 quote · FR-DOM-03 register · FR-DOM-04 transfer · FR-DOM-05 renew · FR-DOM-06 DNS · FR-DOM-07 contacts/eligibility · FR-DOM-08 hosting linkage. Also consumes FR-LED-03 (spend approval), FR-MTR-02 (ingestion), FR-CMP-05 (residency).

## 4. Automatable engineering tasks
### Sprint S28 — Registrar contract, Openprovider, search, quote
1. Implement `RegistrarAdapter` TypeScript contract in `packages/adapters/contracts` exactly per docs/09 §4 (+`AdapterBase`); extend `packages/adapters/conformance` with registrar suite (probe, search, register idempotency, `findByToken`, timeout→`uncertain`, normalized errors, webhook signature).
2. Read the **official vendor documentation** for Openprovider; write `docs/adapters/openprovider.md` citing doc URL + retrieval date + the exact operations used. Any operation not documented ⇒ capability `unsupported`. Do not invent methods.
3. Implement `packages/adapters/openprovider` against recorded sandbox fixtures + mock server: `probe`, `supportedTlds`, `search`, `register`, `findByToken`, `parseWebhook?`. `findByToken`: if vendor lacks client tokens, define a documented lookup (e.g., domain name + order-time window + stored provider order ref) and prove it in the conformance kit.
4. Domain search service: `GET /v1/domains/search` with price, premium flag, availability cache (TTL proposal: 60 s availability, 15 min TLD price catalog), per-org rate limit, residency-safe logging (search terms are `internal`, not `personal`).
5. Quote integration: `POST /v1/quotes` `kind=domain` — item per (name, years, action); includes tax estimate (M03), eligibility result, `expiresAt` (proposal 15 min), immutable once issued; quote creation **fails `422 eligibility_blocked`/`422 unsupported_capability`** when blocked.
6. Admin registrar registry: `GET/POST /v1/admin/registrars`, `POST /v1/admin/registrars/{id}/verification` (probe → capability matrix rows in `cloud.provider_capabilities`, `kind=registrar`).
7. Migrations for `domains.registrars`, `registrar_accounts`, `eligibility_checks`, `domain_orders` (see §7).

### Sprint S29 — ResellerClub, register/transfer/renew, contacts, webhooks
1. `docs/adapters/resellerclub.md` + `packages/adapters/resellerclub` (same discipline as S28).
2. Order orchestration as a `platform.operations` workflow: `quote valid → spend authorization → payment/ledger authorize → adapter.register(idempotencyToken) → persist → ledger record → meter → notify`. On `uncertain`: state `needs_reconcile` → `findByToken` → finalize or (only if provably absent) retry once. Authorization released on definitive failure.
3. `POST /v1/domains` (order from `quoteId`), `GET /v1/domains`, `GET/PATCH /v1/domains/{id}` (contacts, nameservers, lock, auto-renew), `POST /v1/domains/{id}/renewals`, `POST/GET /v1/domains/transfers` (transfer-in with auth code held as vault ref, never logged).
4. Contacts: encrypted PII (`personal` class), per-TLD required fields from `supportedTlds`; WHOIS/privacy-proxy only if capability `supported` for that TLD+registrar; otherwise UI states "not available" and registrant data is public per registry policy — user must acknowledge (consent record, M04).
5. Inbound webhooks `POST /v1/webhooks/registrars/{provider}`: signature verify, replay window, dedupe on provider event id (`platform.webhook_events_inbound`), durable record then `2xx`.
6. Cross-border: before sending registrant PII to a registrar, call `ResidencyPolicyService.evaluate(orgId,'personal',registrarRegion)`; deny/require transfer assessment per M04 policy.

### Sprint S30 — DNS engine, eligibility, Saudi TLD gating
1. DNS zone service: `GET/POST /v1/dns/zones`, `GET /v1/dns/zones/{id}`, `GET/PATCH /v1/dns/zones/{id}/records`. DNS hosted via the adapter `dns` capability only; if the registrar has no DNS capability the zone cannot be created (no Nuzm authoritative DNS in this milestone — see issue list; decision needed).
2. Record validation library (`packages/domain/dns-validate`): types A, AAAA, CNAME, MX, TXT, SRV, CAA, NS(delegation only), no CNAME at apex, no CNAME+other at same name, TTL range proposal 60–86400, TXT chunking at 255 bytes, SRV/MX field checks, IDN → punycode, duplicates, quota (`records per zone` entitlement).
3. Atomic change-set semantics: pre-validate whole set → `If-Match` on zone `version` → adapter `applyChangeSet` ; if adapter not atomic, take snapshot, apply, verify by re-read, auto-rollback to snapshot on mismatch, mark zone `degraded` and open reconcile if rollback uncertain. Response includes per-change result and new `ETag`.
4. DNSSEC: feature appears only if adapter `probe` returns `dnssec: supported` for that TLD; otherwise hidden/disabled.
5. Eligibility engine (`domains.eligibility_checks`): per-TLD rule providers (registry rules fetched from adapter `eligibility?`, plus static policy file `spec/providers/tld-policy.yaml` owned by compliance/legal). Rules for Saudi/restricted TLDs are **absent by default ⇒ TLD `blocked: unsupported`** until HG-07-02 evidence is recorded and the owner enables the policy entry; blocking occurs at **quote time**, before any authorization/payment. `GET /v1/domains/{id}/eligibility` returns the last evaluation for existing domains (renewals, transfers).
6. Domain-event consumers: `domain.registered`, `resource.state_changed` into `platform.resources_index`.

### Sprint S31 — Hosting linkage, renewals, reconciliation, UI, acceptance
1. `DnsLinkagePort` (exported by `domains`): `proposeRecordsForSite(siteId, domain)` returns change-set (A/AAAA/CNAME to M06 node targets), `applyLinkage(…, approvedBy)` runs through atomic change-set; `writeAcmeChallenge(domain, token)` limited to `_acme-challenge` TXT for M06 SSL DNS-01; clean-up after validation. M06 `POST /v1/hosting/sites/{id}/domains` calls this port.
2. Renewals: daily scheduler creates reminders at 60/30/7/1 days (proposal) via `platform.notifications`; **auto-renew** creates a spend-approval request (M02) when above limit, otherwise authorizes within standing limit; failed payment → dunning link (M03), domain flagged `renewal_at_risk`.
3. Cost reconciliation: ingest registrar billing (`fetchBilling?`) into `metering.provider_cost_records`; `finrec` run **RC-04 (domain cost vs registrar statement)** — see issue list for ID definition; report variances above D-31 threshold.
4. Technical reconciler: nightly `findByToken`/inspect sweep for operations in `needs_reconcile` and domains whose provider state differs from `domains.domains.state`.
5. UI (§8), runbooks, demo, report.

## 5. Human approvals & external gates
| ID | Gate | Agent does meanwhile | Default status |
|---|---|---|---|
| HG-07-01 | Openprovider + ResellerClub reseller accounts, API access/IP allow-list, sandbox credentials | Build against fixtures/mock; mark vendor rows NOT VERIFIED | PENDING |
| HG-07-02 | `.sa` / restricted-TLD eligibility route (per D-19) | Keep Saudi TLDs `blocked: unsupported`; build gating only | PENDING |
| D-19 | TLD portfolio and `.sa` route | Policy file supports per-TLD enable flag, default off | OPEN |
| HG-03-02 | PSP production (live charge) | Sandbox payments only | PENDING |
| HG-04-01 | Counsel memo on cross-border transfer of registrant data | Default deny non-in-Kingdom registrars for `personal` data if policy says so; otherwise needs recorded transfer assessment | PENDING |
| D-31 | Reconciliation variance threshold | Parameterize; default alert on any non-zero variance | OPEN |
The agent may not mark any HG `GRANTED`; the owner records evidence in `docs/07`.

## 6. API specifications (subset of docs/04 §2.7 and §1; no additions)
Common: org context from token; `Idempotency-Key` required on POSTs; errors `application/problem+json`; `traceId` in all errors. Roles: `owner|admin|developer` write, `billing_admin` renew/pay, `viewer` read.
| Endpoint | Portal | Key request | Key response | Errors | Behavior |
|---|---|---|---|---|---|
| GET `/v1/domains/search` | C A R | `q`, `tlds[]`, `country?` | items `{name, tld, available, premium, price{amount,currency}, eligibility, cacheTtl}` | 422 `unsupported_capability`, 429 | cached; only verified registrar capabilities |
| POST `/v1/quotes` (`kind=domain`) | C A R | `items[{name,years,action}]` | `{id, items, total, taxEstimate, eligibility[], residency, expiresAt}` | 422 `eligibility_blocked`, 409 `quote_conflict` | idempotent; immutable |
| POST `/v1/domains` | C A R | `quoteId`, `contacts`, `nameservers?`, `autoRenew`, `privacy?` | `202` + `operationId`, domain `status=pending` | 402 `payment_required`, 409 `quote_expired`, 422 `eligibility_blocked`, 403 `approval_required` | async operation; reconcile-before-retry |
| GET `/v1/domains` | C A R | filters, cursor | page | | |
| GET/PATCH `/v1/domains/{id}` | C A R | PATCH `contacts, nameservers, lock, autoRenew` with `If-Match` | domain | 409, 412, 422 `unsupported_capability` | PATCH may spawn operation |
| POST `/v1/domains/{id}/renewals` | C A R | `years`, `quoteId` | `202` operation | 402, 403 `approval_required` | idempotent |
| POST `/v1/domains/transfers` | C A R | `name`, `authCodeRef`/`authCode` (write-only), `quoteId` | `202` operation `transferId` | 422 `transfer_locked`, `eligibility_blocked` | auth code never returned/logged |
| GET `/v1/domains/transfers` | C A R | | page | | |
| GET `/v1/domains/{id}/eligibility` | C A R | | latest evaluation `{rule, state, evidence}` | 404 | |
| GET/POST `/v1/dns/zones` · GET `/v1/dns/zones/{id}` | C A R | `domainId` | zone `{id, version, state}` | 422 `unsupported_capability` | |
| GET `/v1/dns/zones/{id}/records` | C A R | filters | records + `ETag` | | |
| PATCH `/v1/dns/zones/{id}/records` | C A R | `{create[],update[],delete[]}` + `If-Match` | per-change result, new `ETag`; may be `202` | 412 `etag_mismatch`, 422 `record_invalid` with `errors[]` | atomic as §4 S30.3 |
| GET/POST `/v1/admin/registrars` · POST `…/{id}/verification` | X | account refs (vault), probe | capability matrix | 422 | audit |
| POST `/v1/admin/domains/{id}/reconciliations` | X | | `202` op | | forced reconcile |
| POST `/v1/webhooks/registrars/{provider}` | provider | signed payload | `200` after durable record | 401 bad signature, 409 replay | dedupe on event id |
Operation states per docs/02 §3. Residency fields on domains: `dataRegion`, `providerRegionId` of registrar account.

## 7. Database migrations (owner: `domains`; migration range recorded in `spec/db/ownership.yaml`, files `…__domains__<slug>.sql`)
| Table | Key columns / constraints | Notes |
|---|---|---|
| `domains.registrars` | `id`, `provider_code` (unique), `contract_version`, `enabled` | tenant-less (listed in manifest) |
| `domains.registrar_accounts` | `registrar_id`, `provider_account_id` (→cloud ref by id only), `vault_ref`, `data_region`, `health` | tenant-less, admin only |
| `domains.domains` | `org_id`, `name` (citext, unique per org+active), `tld`, `state` (`pending|active|expired|redemption|transferring|failed|renewal_at_risk`), `registrar_account_id`, `provider_ref`, `expires_at`, `auto_renew`, `locked`, `privacy_state`, `nameservers jsonb`, `data_region`, `provider_region_id`, `version` | RLS; unique `(registrar_account_id, name)` globally to prevent dup |
| `domains.domain_contacts` | `org_id`, `domain_id`, `role` (registrant/admin/tech/billing), `payload_encrypted bytea`, `key_ref`, `classification='personal'` | app-level encrypted |
| `domains.domain_orders` | `org_id`, `type` (`register|renewal|transfer_in`), `quote_id`, `operation_id`, `idempotency_token`, `state`, `years`, `price_minor`, `currency`, `provider_order_ref`, unique `(org_id, idempotency_token)` | renewals are rows with `type='renewal'` (no separate renewals table in docs/05) |
| `domains.domain_transfers` | `org_id`, `domain_id?`, `name`, `auth_code_ref`, `state`, `provider_ref` | |
| `domains.dns_zones` | `org_id`, `domain_id`, `state`, `version`, `provider_zone_ref`, `degraded bool` | |
| `domains.dns_records` | `org_id`, `zone_id`, `name`, `type`, `ttl`, `value jsonb`, `managed_by` (`user|linkage|email-verification`), unique `(zone_id,name,type,value_hash)` | index `(zone_id,name,type)` |
| `domains.eligibility_checks` | `org_id?`, `quote_id?`, `domain_id?`, `tld`, `rule_set_version`, `result` (`allowed|blocked|needs_info`), `reason`, `evidence jsonb` | append-only |
Append-only: `eligibility_checks`. Seed (reference): none for TLD policy except `spec/providers/tld-policy.yaml` baseline with Saudi TLDs absent. Reversal: all tables are new; down script drops in reverse FK order; production rollback = forward fix (docs/05 §2). RLS test and ownership test must pass.

## 8. UI screens (Arabic RTL + English; loading/empty/error/forbidden states on all)
Agency/Reseller read views are delivered with M11 reusing these components.
| ID | Portal | Route | Purpose | Key states | Roles |
|---|---|---|---|---|---|
| UI-M07-01 | C | `/domains` | Domain list (status, expiry, auto-renew, renewal risk) | empty→CTA search; expiring banner | all read |
| UI-M07-02 | C | `/domains/search` | Search with price, premium, eligibility badges | cache stale hint; unsupported TLD disabled with reason | owner/admin/developer |
| UI-M07-03 | C | `/domains/checkout` | Quote → spend approval → confirm (cost disclosure, tax, contacts) | quote expiring countdown; approval required state | owner/admin/billing_admin |
| UI-M07-04 | C | `/domains/[id]` | Overview, nameservers, lock, auto-renew, operation status | pending/reconciling/degraded | read all; write owner/admin |
| UI-M07-05 | C | `/domains/[id]/dns` | Records table, add/edit, diff + apply change-set, ETag conflict resolution | validation errors inline; degraded zone banner | owner/admin/developer |
| UI-M07-06 | C | `/domains/[id]/contacts` | Contacts form per TLD requirements, privacy availability, consent notice | cross-border blocked state | owner/admin |
| UI-M07-07 | C | `/domains/transfers` | Transfer list and start transfer (auth code input, write-only) | locked/unsupported states | owner/admin |
| UI-M07-08 | C | `/domains/[id]/hosting` | Link domain to hosting site, proposed records preview, SSL status | M06 unavailable → disabled | owner/admin/developer |
| UI-M07-09 | X | `/domains/registrars` | Registrar accounts, health, capability matrix, verify | probe results; vendor "NOT VERIFIED" tag | platform_admin |
| UI-M07-10 | X | `/domains/orders` | Orders queue, needs_reconcile, force reconcile | filters | platform_admin, support |
| UI-M07-11 | X | `/domains/reconciliation` | RC-04 cost reconciliation runs & variances | variance resolution | finance |
| UI-M07-12 | X | `/domains/[id]` | Support lookup (metadata only; contacts masked unless break-glass) | masked PII | support, platform_admin |
Each has a Playwright-style e2e, RTL screenshot, and axe check (docs/13).

## 9. Security, compliance & tenant isolation
- RLS on all tenant tables; cross-tenant tests for every endpoint in §6. A domain name is unique per registrar account globally (registrar-level uniqueness) — second org ordering a taken name gets `409 domain_unavailable` without leaking the owner.
- Registrant contacts: classification `personal`; encrypted at rest; masked in logs/UI for non-owners; DSR export/erase hooks (M04) — erase constrained by registry retention rules (document per TLD; verify with counsel, HG-04-01).
- Auth codes and registrar credentials: vault refs only; write-only API; never in operation payload logs.
- Webhooks: signature verified, replay window (proposal 5 min), dedupe; unknown event types stored and ignored.
- DNS abuse controls: record-count quotas, rate limit on change-sets, block dangling-CNAME takeover patterns to Nuzm hosting domains, block `_acme-challenge` writes except via `DnsLinkagePort`.
- Audit events: `domain.search.quota_exceeded`, `domain.quote.issued`, `domain.order.created|succeeded|failed|reconciled`, `domain.renewal.*`, `domain.transfer.*`, `domain.contacts.updated`, `dns.changeset.applied|rolled_back`, `registrar.verified`, `domain.eligibility.blocked`.
- Residency: `ResidencyPolicyService` called before registrant PII leaves; result stored with order.

## 10. Metering & billing hooks
| Meter | Emit point | Quota/limit |
|---|---|---|
| `domain.registration_years` | on registrar-confirmed registration (qty = years) | domains per org (entitlement) |
| `domain.renewal_years` | on confirmed renewal | — |
| `domain.transfers` | on confirmed transfer completion | — |
| `dns.zone_months` | daily accrual per active zone (1/30 per day, proposal) | zones/records per entitlement |
Events carry `eventId = hash(operationId, 'meter')` for dedupe. Cost side: registrar fee captured to `metering.provider_cost_records`. Charging: quote→authorize→record→reconcile; ledger posting keyed by `operationId` so repeated callbacks post zero additional rows.

## 11. Automated tests
- **Unit:** record validation (≥40 negative fixtures), IDN/punycode, TTL bounds, quote expiry, state machine transitions, TLD policy loader (Saudi TLD absent ⇒ blocked).
- **Contract (conformance kit, both adapters):** probe, search, register idempotency, `findByToken`, uncertain-on-timeout, error normalization, webhook signature, capability gating.
- **Integration:** order happy path (sandbox fixtures); `timeout_after_vendor_success` ⇒ reconcile finds domain ⇒ single ledger posting; `timeout_before_vendor` ⇒ reconcile proves absence ⇒ single retry; duplicate webhook ×100 ⇒ 1 state change/1 meter/0 extra postings; concurrent identical orders (same Idempotency-Key and same name from two orgs) ⇒ exactly one registration; change-set atomicity with injected failure at record k ⇒ rollback verified; ETag conflict `412`.
- **Security:** cross-tenant matrix for all §6 endpoints; auth code leakage scan of logs; SSRF/injection in record values; webhook forged/replayed signature rejected; PII never in `audit_logs.payload`.
- **E2E (UI):** search→quote→approve→order→DNS edit→link to hosting site (fake M06 until gate) in `ar` and `en`; unsupported Saudi TLD shows blocked reason and creates **0** authorizations/payments.
- **Failure/chaos:** registrar 5xx/429 storms with circuit breaker; vault unavailable; DB failover during order.
- **Load (proposal):** 50 rps search with 90% cache hit, p95 < 1.5 s cached; zone change-set 200 records p95 < 5 s on mock.

## 12. Deliverables
Source (adapters, domains module, DNS engine, linkage port), OpenAPI under `spec/openapi` for §6, migrations + reversal notes, UI screens §8, `docs/adapters/{openprovider,resellerclub}.md`, runbooks (`docs/runbooks/domains-reconcile.md`, `domains-registrar-outage.md`, `dns-degraded-zone.md`), demo script (search→register→DNS→link), fixtures, `docs/reports/M07-report.md` (CLAUDE.md §10), per-sprint completion, updated `spec/providers/tld-policy.yaml`, gate review draft.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Status |
|---|---|---|---|
| AC-M07-01 | Both adapters pass registrar conformance kit 100% against fixtures/mock | CI log | PENDING |
| AC-M07-02 | Duplicate webhook ×100 ⇒ exactly 1 registration, 1 meter event, 1 ledger transaction | test log + SQL counts | PENDING |
| AC-M07-03 | 50 randomized fault-injection runs (timeout before/after vendor success) ⇒ 0 duplicate registrations, 0 duplicate charges, 100% operations terminal in ≤ 15 min | test log | PENDING |
| AC-M07-04 | Quote for any TLD without capability/policy enablement returns 422; **0** authorizations created (100 attempts, incl. Saudi TLDs) | test log + DB assertion | PENDING |
| AC-M07-05 | Record validation rejects 100% of ≥40 invalid fixtures; accepts 100% of ≥40 valid | unit log | PENDING |
| AC-M07-06 | Change-set atomicity: injected failure at each position of a 20-change set leaves zone equal to pre-state | integration log | PENDING |
| AC-M07-07 | Cross-tenant matrix: 0 successful cross-org reads/writes across all §6 endpoints | security log | PENDING |
| AC-M07-08 | No auth code, vault ref content or contact PII in logs/audit (scanner 0 findings) | scan output | PENDING |
| AC-M07-09 | Search p95 < 1.5 s cached / < 4 s uncached on mock; proposal values | load report | PENDING |
| AC-M07-10 | RC-04 reconciliation run on fixtures reports injected variance exactly | finrec output | PENDING |
| AC-M07-11 | UI: 12 screens e2e PASS in ar+en, axe 0 serious/critical | CI report + screenshots | PENDING |
| AC-M07-12 | Live sandbox-account registration/renewal/transfer for each registrar with real vendor responses | vendor-side record + run log tagged LIVE-VERIFIED | BLOCKED-until-evidence (HG-07-01) |
| AC-M07-13 | Real `.sa`/restricted-TLD order eligible and completed | registrar evidence | BLOCKED-until-evidence (HG-07-02, D-19) |
| AC-M07-14 | A supported domain connected to an M06 CloudPanel site serves valid HTTPS (cert chain verified, HTTP→HTTPS redirect) | curl/openssl output, site screenshot | BLOCKED-until-evidence (HG-07-01 real domain + M06 gate/node) |
| AC-M07-15 | Cost reconciliation against a real registrar statement within D-31 threshold | finrec report | BLOCKED-until-evidence (HG-07-01, D-31) |

## 14. Handoff
- **M08:** `DnsLinkagePort` for email-domain verification records (`managed_by='email-verification'`); domain/zone ownership checks for sender identities.
- **M09:** custom-domain publishing via `POST /v1/hosting/sites/{id}/domains`.
- **M10/M11:** domain purchase actions as workflow connector; agency/reseller portal views reuse components.
- **M12:** registrar cost reconciliation in launch reconciliation; registrar outage runbook drill.
- Open: authoritative DNS hosting decision, `.sa` route, optional registrars.

## 15. Compliance hooks checklist
- [ ] Residency evaluation recorded per order; registrar account `data_region` stored
- [ ] Consent for public WHOIS exposure / registrar processing captured (M04 consent record)
- [ ] Contacts classified `personal`, encrypted, DSR export/erase implemented with registry-retention caveat documented
- [ ] Audit events listed in §9 emitted and tested
- [ ] Retention: order/invoice records follow D-34; contacts deleted per policy after domain release
- [ ] Transfer assessment reference attached where registrar outside permitted region

## Completion instruction
Do not mark M07 DONE until every acceptance row is evidenced. Rows depending on HG-07-01, HG-07-02, HG-03-02 or D-19/D-31 stay BLOCKED-until-evidence and must not be satisfied by mocks or recorded fixtures. The agent may not mark any HG as granted; only the owner records evidence in `docs/07`.
