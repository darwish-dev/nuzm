# M08 — Managed Data & Email

Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.

| Field | Value |
|---|---|
| Sprints | S32–S36 (5 sprints) |
| Depends on (docs/03) | **H:** M01, M02, M04, M05, M07 · **S:** M03, M06 |
| Produces | Managed PostgreSQL/MySQL/Redis, object storage, business email, transactional email services; `DatabaseBindingPort` for M06/M10; email sending port for M09 forms/M11 |
| Gate | Gate Review signed; provider-selection ADRs accepted for every service enabled in production |
| Response format | CLAUDE.md §10 (A–I) |

## 1. Objective
Deliver managed data services and email on the adapter pattern of docs/09 §5, **without hardcoding any provider choice**. Selections D-05 (PostgreSQL/MySQL), D-06 (Redis), D-07 (object storage), D-08 (transactional email), D-09 (business email) are OPEN; docs/14 compares options and docs/07 holds proposed defaults. Each service ships behind a feature flag `data.<service>.<provider>` that stays **off** until (a) the decision is recorded as an accepted ADR, (b) the adapter `probe` returns verified capabilities/region for the real account, and (c) HG-08-01 evidence exists. Unverified options remain disabled and their acceptance rows BLOCKED; they are never mocked into PASS.

## 2. Preconditions & mocked interfaces
| Interface | Status | Allowed mock until | Real needed for |
|---|---|---|---|
| M05 compute (verified Saudi ECS) for `self-operated-*` family | DONE (gate); real nodes need HG-05-01/02 | compute mock adapter | real provisioning rows |
| M05 provider framework, vault refs, quotes→orders, reconciler | DONE | — | all |
| M07 `DnsLinkagePort`, zones | DONE | — | AC-M08-10/11 real DNS |
| M04 residency, consent, retention | DONE | — | all |
| M02/M03 metering, ledger, invoices | DONE | PSP sandbox | billing rows |
| Local dev-reference containers (Postgres, MySQL, Redis, S3 emulator, mail catcher) from bootstrap | available | **dev/CI only**, tagged `environment=local`, never selectable in staging/production | contract/integration tests |
| Provider-managed APIs / vendor email APIs / mailbox partner | no credentials | recorded fixtures + mock server | HG-08-01 |
Reports label dev-reference results `NOT VERIFIED (local reference)`.

## 3. Requirement IDs closed
FR-DAT-01 managed DB · FR-DAT-02 Redis · FR-DAT-03 object storage · FR-DAT-04 mailbox · FR-DAT-05 email DNS auth · FR-DAT-06 transactional send · FR-DAT-07 suppression · FR-DAT-08 events · FR-DAT-09 metering · FR-DAT-10 restore. Consumes FR-CMP-05, FR-CLD-03 (vault), FR-MTR-02.

## 4. Automatable engineering tasks
### Sprint S32 — Decision records, adapters, managed PostgreSQL/MySQL
1. Prepare ADR drafts (Proposed) for D-05..D-09 from docs/14 with decision criteria, probe plans and exit conditions; **do not accept them**. Create `data.data_providers` selection config + admin API `GET/POST /v1/admin/data-providers`; each row = (service, family `provider-*|self-operated-*`, provider code, account ref, `enabled`, `verified_at`, `evidence_ref`).
2. Contracts in `packages/adapters/contracts`: `DatabaseAdapter`, `CacheAdapter`, `ObjectStorageAdapter`, `TransactionalEmailAdapter`, `MailboxAdapter` per docs/09 §5, with conformance suites (probe, idempotent create/`findByToken`, uncertain→reconcile, backup/restore, credential rotation, usage reporting).
3. `self-operated-database` family: orchestrator that provisions via M05 `ComputeAdapter` and configures PostgreSQL/MySQL through a **signed, allow-listed agent** (no arbitrary SSH commands): TLS required, no public listener by default, automated base backups + WAL/binlog archive to a bucket in the same `data_region`, patch policy. Version matrix proposals: supported majors per engine are config, not code.
4. `provider-database` family skeleton: implemented only against official vendor docs cited in `docs/adapters/<provider>.md`; undocumented ⇒ capability `unsupported`.
5. `POST/GET /v1/databases`, `GET/PATCH/DELETE /v1/databases/{id}` with `engine=postgresql|mysql|redis`; create requires `quoteId` (`kind=database`); connection secrets created as vault entries, API returns only `vaultRef` metadata plus one-time reveal (see issue list on secret retrieval).
6. Metering hooks for instance hours/storage.

### Sprint S33 — Backups, restores, Redis, rotation
1. Backup policies from entitlements (retention days, frequency); `POST/GET /v1/databases/{id}/backups` (manual), scheduled backups; `database.backup_gb_months` metering.
2. **Restore**: `POST /v1/databases/{id}/restores` defaults to *restore-to-new instance in same org/region*; in-place restore requires `confirmInPlace=true` + approval step and automatic pre-restore backup. Cross-org/cross-region restore denied unless M04 policy allows.
3. **Restore verification job**: weekly (proposal) and on-demand: restore latest backup into a scratch instance, run integrity checks (engine-native checks, schema/row-count/checksum on sampled tables), record result in `data.database_restores` (`verification` jsonb), destroy scratch; failures raise `ops` alert and `platform.notifications`.
4. Redis (`engine=redis`): `CacheAdapter`, TLS + ACL users, persistence mode option only if capability, `cache.instance_hours`.
5. `POST /v1/databases/{id}/credential-rotations`: dual-credential window (proposal 24 h), audit, new secret one-time reveal, old revoked; M06/M10 consumers notified through `DatabaseBindingPort`.
6. Resize/scale only if `probe` capability; else action disabled.

### Sprint S34 — Object storage
1. `ObjectStorageAdapter` + `self-operated-object-storage` and `provider-object-storage` families (flags off until verified); S3 compatibility claims verified by a **compat suite** run against the real endpoint (list of operations tested stored as evidence; unsupported operations disable corresponding features).
2. `POST/GET /v1/storage/buckets`, `GET/PATCH/DELETE …/{id}`, `GET/PUT …/{id}/access-policy`, `POST …/{id}/signed-urls` (max TTL proposal 7 d, default 15 min; method-scoped), `GET/PUT …/{id}/lifecycle` (expiry, abort-incomplete-multipart; transitions only if capability).
3. **Tenant-scoped credentials**: per-bucket (or per-org-prefixed) access keys issued by adapter, vault-stored; no shared admin keys at runtime; bucket names namespaced `nz-<orgShort>-<name>` and checked for collisions; public access off by default; making public requires explicit confirmation, audit event, and warning UI.
4. Quotas via entitlements (bucket count, bytes); usage collector for `storage.object_gb_months`, `storage.requests_k`, `storage.egress_gb` (from adapter `usage`; if provider cannot report egress/requests, meter is marked `unavailable` and billing for it disabled — never estimated silently).
5. Backup/replication target for M08 DB backups uses a **system** bucket pair in same `data_region`.

### Sprint S35 — Business email
1. `POST/GET /v1/email/domains`, `POST /v1/email/domains/{id}/verification`: domain ownership proof (TXT token) + required MX/SPF/DKIM/DMARC records generated declaratively by `MailboxAdapter` / `TransactionalEmailAdapter`; if domain DNS is in an M07 zone the UI offers one-click apply via `DnsLinkagePort` (`managed_by='email-verification'`), else shows manual instructions; verification re-checks by live DNS lookup (multiple resolvers) with TTL-aware retries.
2. `POST/GET /v1/email/mailboxes`, `PATCH/DELETE …/{id}`, `POST/GET /v1/email/aliases`; mailbox provisioning via `MailboxAdapter` per D-09; quotas; password handling via provider reset-link flow or one-time secret (no persisted plaintext).
3. Mailbox metering `email.mailbox_months`, `email.mailbox_storage_gb_months` (if provider reports storage).
4. DMARC policy guidance (start `p=none` proposal, UI nudges); no advice beyond configuration state.

### Sprint S36 — Transactional email and acceptance
1. `POST/GET /v1/email/sender-identities` (domain-verified); `GET/POST /v1/email/templates` (versioned, variable schema, HTML sanitized, ar/en/RTL), `POST /v1/email/messages` (Idempotency-Key mandatory; only `category=transactional` accepted; marketing/bulk blocked by policy), `GET /v1/email/messages/{id}`, `GET /v1/email/events`, `GET/POST /v1/email/suppressions`.
2. Webhooks `POST /v1/webhooks/email/{provider}`: signature, replay window, dedupe; hard bounce and complaint ⇒ automatic suppression; soft-bounce policy (proposal: 3 in 72 h); suppression checked before every send.
3. Deliverability guardrails: per-org rate limits and warm-up caps (proposal), auto-throttle at bounce rate > 5% or complaint rate > 0.1% over rolling 24 h (proposal values; tune with provider guidance), admin override.
4. Message storage: metadata + body hash by default; body retained encrypted for N days (proposal 7, D-34) only if org enables; recipients `personal` class.
5. Metering `email.transactional_messages` on provider-accepted send (not on queue); usage vs provider-reported reconciliation.
6. UI, runbooks, report, acceptance; verify forms-notification port for M09.

## 5. Human approvals & external gates
| ID | Gate | Agent does meanwhile | Default |
|---|---|---|---|
| D-05 / D-06 | DB and Redis provider decision | Build contracts, self-operated reference against mock compute, local dev containers | OPEN |
| D-07 | Object storage provider decision | Contract + S3 compat suite; local emulator | OPEN |
| D-08 | Transactional email provider | Contract + mock; no real sends | OPEN |
| D-09 | Business email provider | Contract + mock | OPEN |
| HG-08-01 | Contracts, API keys, sending IP/domain warm-up, abuse policy | Mock/fixtures only; label NOT VERIFIED | PENDING |
| HG-05-01/02 | Verified Saudi ECS accounts for self-operated family | compute mock | PENDING |
| HG-04-01 | Counsel memo on email content/metadata and backup residency | Default: block non-permitted regions via policy | PENDING |
| D-34 | Retention periods (backups, email bodies, events) | Parameterized, conservative defaults | OPEN |
| D-31 | Metering vs provider usage tolerance | parameter | OPEN |

## 6. API specifications (docs/04 §2.8; no additions)
Common conventions as docs/04 §1. Roles: `owner|admin|developer` write; `billing_admin` quotes/approvals; `viewer` read. All create endpoints return `202` + operation unless noted.
| Endpoint | Key request | Key response | Errors | Behavior |
|---|---|---|---|---|
| POST `/v1/databases` | `quoteId`, `engine`, `version`, `name`, `network` | database `status=provisioning`, `operationId` | 402/403 approval_required, 422 `unsupported_capability`/`residency_denied`, 409 | idempotent; reconcile-before-retry |
| GET `/v1/databases` · GET/PATCH/DELETE `…/{id}` | PATCH `name, backupPolicy, plan` + If-Match; DELETE requires `confirmName` | database incl. `endpoint{host,port}`, `tlsRequired`, `dataRegion`, `vaultRef` | 412, 409 `in_use` (bound to site) | DELETE takes final backup (policy) |
| POST/GET `/v1/databases/{id}/backups` | `type=manual` | backup `{id,size,state,expiresAt}` | 422 | op |
| POST `/v1/databases/{id}/restores` | `backupId`, `target: new|inplace`, `confirmInPlace?` | op `restoreId` | 403 cross-tenant, 422 `restore_not_supported` | restore-to-new default |
| POST `/v1/databases/{id}/credential-rotations` | `role` | op; one-time reveal | 409 rotation_in_progress | |
| POST/GET `/v1/storage/buckets`; GET/PATCH/DELETE `…/{id}` | `name`, `region`, `versioning?`, `quoteId` | bucket `{endpoint, dataRegion, public:false}` | 409 name_taken, 422 | DELETE requires empty or `force` + approval |
| GET/PUT `/v1/storage/buckets/{id}/access-policy` | policy doc (validated subset) | policy + ETag | 422 `policy_invalid` | public requires `confirmPublic` |
| POST `/v1/storage/buckets/{id}/signed-urls` | `key, method, ttlSeconds` | `{url, expiresAt}` | 422 ttl_too_long | no secret in logs |
| GET/PUT `/v1/storage/buckets/{id}/lifecycle` | rules[] | rules | 422 | capability-gated actions |
| POST/GET `/v1/email/domains` · POST `…/{id}/verification` | `domain`, `purposes[mailbox,transactional]` | required records, `state` | 422 `domain_not_owned` | idempotent; re-verifiable |
| POST/GET `/v1/email/mailboxes` · PATCH/DELETE `…/{id}` · POST/GET `/v1/email/aliases` | `localPart`, `domainId`, `quotaMb`, `quoteId` | mailbox state | 402, 409, 422 | op |
| POST/GET `/v1/email/sender-identities` | `domainId`, `fromAddress` | verification state | 422 | |
| POST `/v1/email/messages` | `senderId`, `to[]`, `templateId|subject+html`, `variables`, `category=transactional` | `202` `{id, status=queued}` | 422 `suppressed`, 429 `rate_limited`, 422 `category_not_allowed` | `Idempotency-Key` mandatory |
| GET `/v1/email/messages/{id}` · GET `/v1/email/events` | filters | message + event timeline | | |
| GET/POST `/v1/email/templates` · GET/POST `/v1/email/suppressions` | | | | |
| POST `/v1/webhooks/email/{provider}` | signed payload | `200` after durable record | 401, 409 replay | dedupe |
| GET/POST `/v1/admin/data-providers` | selection config | config + probe evidence | 422 enabling unverified | two-person approval to enable in production |

## 7. Database migrations (owners: `data`, `email`; ranges in manifest)
| Table | Key columns / notes |
|---|---|
| `data.data_providers` | tenant-less; `service`, `family`, `provider_code`, `provider_account_id`, `enabled`, `verified_at`, `evidence_ref`, `adr_ref` |
| `data.database_instances` | `org_id`, `engine`, `version`, `plan_ref`, `state`, `host`, `port`, `tls_required`, `vault_ref`, `data_region`, `provider_region_id`, `provider_ref`, `backup_policy jsonb`, `resource_id`, `version_lock`; RLS; unique `(org_id,name)` |
| `data.database_backups` | `org_id`, `instance_id`, `type`, `size_bytes`, `state`, `storage_ref`, `checksum`, `expires_at`, `data_region` |
| `data.database_restores` | `org_id`, `source_backup_id`, `target_instance_id`, `mode`, `state`, `verification jsonb`, `operation_id` (restore tests and rotations: rotation tracked as `platform.operations` + audit — docs/05 lists no rotations table) |
| `data.storage_buckets` | `org_id`, `name_global unique`, `provider_ref`, `endpoint`, `versioning`, `public bool default false`, `lifecycle jsonb`, `quota_bytes`, `credential_vault_ref`, `data_region` |
| `data.bucket_policies` | `org_id`, `bucket_id`, `policy jsonb`, `etag` |
| `email.email_domains` | `org_id`, `domain`, `purposes`, `verification_state`, `required_records jsonb`, `dns_zone_id?`, `data_region` |
| `email.mailboxes` / `aliases` | `org_id`, `domain_id`, `local_part`, `provider_ref`, `quota_mb`, `state`; unique `(domain_id, local_part)` |
| `email.sender_identities` | `org_id`, `domain_id`, `from_address`, `state` |
| `email.messages` | `org_id`, `sender_id`, `to_hash`, `recipients_encrypted`, `template_id`, `category`, `state`, `provider_message_ref`, `idempotency_key`, `body_hash`, `body_encrypted?`, `expires_at`; unique `(org_id, idempotency_key)` |
| `email.email_events` | append-only; `org_id`, `message_id`, `type`, `provider_event_id` unique, `payload` redacted |
| `email.templates`, `email.suppressions` | versions; `(org_id,address_hash,reason)` unique |
RLS everywhere except `data.data_providers`. Append-only: `email.email_events`. Reversal: new tables only; down scripts drop in reverse order; production rollback via forward fix. Seed: reference sizes/plan metadata only; no provider rows enabled by default.

## 8. UI screens (ar RTL + en; all states)
| ID | Portal | Route | Purpose | Key states | Roles |
|---|---|---|---|---|---|
| UI-M08-01 | C | `/databases` | List, status, region | empty, provisioning | all read |
| UI-M08-02 | C | `/databases/new` | Engine/plan/region offers (verified only), quote→approval→confirm | unsupported greyed with reason; residency denied | owner/admin/developer |
| UI-M08-03 | C | `/databases/[id]` | Overview, endpoint, TLS notes, bindings, metrics | op in progress; reconciling | read all |
| UI-M08-04 | C | `/databases/[id]/backups` | Backups, restores (to-new default), verification history | restore failed; in-place confirm modal | owner/admin |
| UI-M08-05 | C | `/databases/[id]/settings` | Backup policy, rotation, delete (type-name confirm) | rotation window banner | owner/admin |
| UI-M08-06 | C | `/storage/buckets` | Buckets list, usage vs quota | empty | all read |
| UI-M08-07 | C | `/storage/buckets/[id]` | Policy editor, lifecycle, signed-URL tool, credentials guidance | public-access warning; compat-limited features hidden | owner/admin/developer |
| UI-M08-08 | C | `/email/domains` | Domains and verification | pending/failed DNS | owner/admin |
| UI-M08-09 | C | `/email/domains/[id]` | Required records, one-click apply (M07), re-check | partial verification | owner/admin |
| UI-M08-10 | C | `/email/mailboxes` | Mailboxes/aliases, quotas | provider disabled state | owner/admin |
| UI-M08-11 | C | `/email/senders` | Sender identities | | owner/admin/developer |
| UI-M08-12 | C | `/email/templates` | Template editor with RTL preview, versions | variable errors | developer+ |
| UI-M08-13 | C | `/email/messages` | Message log, events timeline, filters | throttled banner | all read |
| UI-M08-14 | C | `/email/suppressions` | Suppression list, manual add/remove (audited) | | owner/admin |
| UI-M08-15 | X | `/data/providers` | Provider selection config, probes, flags, evidence links | enable blocked until ADR+probe | platform_admin (+second approver) |
| UI-M08-16 | X | `/data/instances` | Fleet view, restore verification status | failing verification | platform_admin, support (metadata only) |
| UI-M08-17 | X | `/email/deliverability` | Bounce/complaint rates, throttles, overrides | | platform_admin, security |

## 9. Security, compliance & tenant isolation
- RLS + cross-tenant tests on every endpoint; restore/bind operations verify source and target `org_id` equality server-side.
- Network: DB endpoints private/IP-allow-listed by default (capability-gated); TLS mandatory; no superuser exposure; per-tenant database users with least privilege.
- Secrets: connection/bucket/API credentials in vault; rotation tested; reveal one-time, audited, never logged.
- Object storage: per-bucket credentials; deny-by-default policy; public requires confirm; signed URL TTL cap; bucket-name enumeration prevented.
- Email: SPF/DKIM/DMARC verified before sending; anti-spoofing: sender must be a verified identity of the org; header injection sanitization; HTML sanitized; no attachments in v1 (decision needed if required).
- Residency: `ResidencyPolicyService.evaluate` before create/restore/backup/send; `data_region` on instances, buckets, backups, email domains; recipient addresses and content classified `personal`; email metadata sent to provider region requires policy pass + transfer assessment where outside permitted region (per published rules — verify with counsel, HG-04-01).
- Audit events: `database.created|deleted|restored|rotated`, `database.restore.verified`, `bucket.created|policy_changed|made_public`, `signed_url.issued`, `email.domain.verified`, `mailbox.created|deleted`, `email.message.sent`, `email.suppression.added`, `data.provider.enabled`.
- Admin access to tenant data content is prohibited; support sees metadata only; break-glass audited with consent flag.

## 10. Metering & billing hooks
| Meter | Emit point |
|---|---|
| `database.instance_hours`, `cache.instance_hours` | hourly while `state=running` |
| `database.storage_gb_months`, `database.backup_gb_months` | daily snapshot of provisioned/used GB (accrual /30) |
| `storage.object_gb_months`, `storage.requests_k`, `storage.egress_gb` | daily usage import from adapter `usage` (unavailable ⇒ meter off, flagged) |
| `email.transactional_messages` | provider-accepted send |
| `email.mailbox_months`, `email.mailbox_storage_gb_months` | daily accrual / daily usage import |
Quota checks via entitlements at create time and at send time (rate/volume). Provider cost captured to `metering.provider_cost_records` for reconciliation (M03 `finrec`).

## 11. Automated tests
- **Contract:** each adapter suite (database, cache, object storage, transactional email, mailbox) on dev-reference + fixtures; capability gating returns 422 for unsupported.
- **Integration:** provisioning timeout after provider success ⇒ reconcile ⇒ single instance; backup→restore-to-new→checksum equals source (PostgreSQL, MySQL, Redis where persistence supported); weekly verification job failure raises alert; rotation dual-credential window; in-place restore requires confirm+approval.
- **Isolation:** tenant B cannot list/read/write tenant A buckets/databases via API or credentials (≥200 generated attack cases); restore across orgs denied; bucket-name enumeration returns uniform error.
- **Email:** DNS verification fixtures (missing/duplicate SPF, multiple DKIM selectors, DMARC variants); duplicate webhook ×100 ⇒ 1 suppression/1 event/1 meter; bounce ⇒ suppression ≤ 60 s from webhook receipt; send to suppressed ⇒ 422; idempotent send replay ⇒ one provider call; header-injection fuzz; template XSS fuzz.
- **Security:** secret scanner on logs/fixtures; signed URL tamper/expiry; public-bucket confirm bypass attempts.
- **E2E (UI):** all 17 screens ar+en; database create→backup→restore-to-new→delete; bucket create→policy→signed URL; domain verify via M07 zone.
- **Failure/chaos:** provider 5xx; vault down; worker crash mid-restore (resumes/reconciles).
- **Load (proposal):** 100 msg/s enqueue; p95 API < 800 ms; signed-URL 200 rps.

## 12. Deliverables
Contracts + adapters (as enabled), data/email modules, OpenAPI for §6, migrations + reversal, UI §8, ADR drafts D-05..D-09 (Proposed), `docs/adapters/*.md`, runbooks (`db-restore.md`, `db-failover.md`, `storage-incident.md`, `email-deliverability.md`, `suppression-handling.md`), demo script, `docs/reports/M08-report.md`, provider verification evidence index, gate review draft.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Status |
|---|---|---|---|
| AC-M08-01 | All five adapter conformance suites pass 100% on dev-reference/fixtures | CI log | PENDING |
| AC-M08-02 | No provider row can be enabled without accepted ADR + passing probe + evidence ref (negative tests ×10) | test log | PENDING |
| AC-M08-03 | Restore-to-new reproduces source: 100% sampled tables checksum/row-count equal (PostgreSQL, MySQL) | restore report | PENDING |
| AC-M08-04 | Restore verification job runs end-to-end and alerts on injected corruption | log + alert | PENDING |
| AC-M08-05 | Tenant isolation: 0 successful cross-tenant actions in ≥200 attack cases (DB, bucket, email) | security log | PENDING |
| AC-M08-06 | Credential rotation: old credential rejected ≤ 60 s after window end; zero downtime for binding test | test log | PENDING |
| AC-M08-07 | Duplicate provider webhooks ×100 ⇒ exactly 1 suppression, 1 event, 1 meter | test log | PENDING |
| AC-M08-08 | Hard bounce ⇒ suppressed ≤ 60 s; suppressed send blocked 100% | test log | PENDING |
| AC-M08-09 | Metering accuracy on fixtures: meter totals equal injected usage (exact) | metering test | PENDING |
| AC-M08-10 | Email domain DNS verification passes SPF/DKIM/DMARC/MX checks on a **real** domain with the **real** provider | DNS lookup logs + provider console evidence | BLOCKED-until-evidence (HG-08-01, D-08/D-09, M07) |
| AC-M08-11 | Real transactional send delivered; bounce/complaint webhooks received from real provider | provider logs, LIVE-VERIFIED | BLOCKED-until-evidence (HG-08-01, D-08) |
| AC-M08-12 | Managed DB/Redis provisioned and restored on **verified Saudi** infrastructure | provisioning logs, region evidence | BLOCKED-until-evidence (D-05/D-06, HG-05-01/02) |
| AC-M08-13 | Object storage S3-compat suite passes on selected real endpoint; list of unsupported operations recorded | compat report | BLOCKED-until-evidence (D-07, HG-08-01) |
| AC-M08-14 | Metering vs provider-reported usage within D-31 tolerance (proposal 1%) | finrec report | BLOCKED-until-evidence (D-31, HG-08-01) |
| AC-M08-15 | Residency denial test: `personal` data to disallowed region blocked for create/restore/send | test log | PENDING |
| AC-M08-16 | UI 17 screens e2e PASS in ar+en, axe 0 serious/critical | CI report | PENDING |

## 14. Handoff
- **M06:** `DatabaseBindingPort` (bind managed DB to hosting site).
- **M09:** form-notification sending via `POST /v1/email/messages`; asset storage buckets for generated sites; custom-domain mail records.
- **M10:** per-app databases/buckets provisioning, test-run databases.
- **M11:** email/DB connectors for workflows.
- **M12:** restore drills, provider reconciliation, deliverability monitoring.
- Open: any D-05..D-09 still OPEN; attachments policy; authoritative DNS decision.

## 15. Compliance hooks checklist
- [ ] `data_region`/`provider_region_id` on every regional resource; residency evaluation stored
- [ ] Personal data fields classified (recipients, mailbox names, DB user labels)
- [ ] Consent/lawful-basis capture for email processing recorded (M04)
- [ ] Audit events §9 emitted/tested
- [ ] Retention periods for backups, email bodies, events set from D-34 (no hardcoded legal periods)
- [ ] DSR export/erase covers messages, suppressions (with legal-obligation exceptions documented)
- [ ] Backup/restore stays within allowed regions

## Completion instruction
Do not mark M08 DONE until every acceptance row is evidenced. Rows depending on D-05..D-09, HG-08-01, HG-05-01/02, HG-04-01 or D-31 stay BLOCKED-until-evidence and must not be satisfied by mocks, fixtures or local dev-reference containers. A provider that is not verified stays disabled. The agent may not mark any HG as granted or accept any ADR for an OPEN decision.
