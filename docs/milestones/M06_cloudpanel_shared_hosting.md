# M06 — CloudPanel Shared Hosting

Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.

| Field | Value |
|---|---|
| Sprints | S24–S27 (4): S24 CloudPanel validation + node inventory PoC · S25 scheduler, site lifecycle, domains/SSL, DB bindings · S26 isolation, quotas, backup/restore, maintenance · S27 billing/metering, abuse, UI, acceptance (docs/06) |
| Depends on | M01 **H**, M02 **H**, M03 **S**, M04 **H**, M05 **H** (docs/03) |
| Produces | `HostingAdapter` implementation for CloudPanel nodes (documented API/CLI path **or** authenticated node agent), node inventory, capacity scheduler, hosting site API, SSL, quotas, backups/restores, abuse controls, hosting UI (customer + admin) |
| Gate | Gate Review per docs/03 §5; live-node rows BLOCKED unless HG evidence recorded |
| Reference | `09` §3, `10` §3, `04` §2.6, `05` (hosting schema) |

Response format: CLAUDE.md §10.

## 1. Objective
Operate multi-customer shared hosting on **platform-operated** VPS nodes (provisioned via M05) managed with CloudPanel, with isolation strong enough that two unrelated tenants cannot read each other's files, databases, backups or credentials; node capacity is never oversold; sites can be created, bound to domains, secured with TLS, quota-limited, backed up, restored, suspended and safely offboarded. The automation path to CloudPanel is **decided by evidence (D-20)**; UI scraping is forbidden.

## 2. Preconditions & mocked interfaces
| Item | Needed | If missing |
|---|---|---|
| M05 compute provisioning (nodes are Nuzm-owned instances in a platform org) | done | stop |
| Real node with CloudPanel installed (HG-06-01 + HG-05-0x) | for live validation | Spike limited to documentation analysis; adapter built against `CloudPanelTransport` interface with **mock agent**; live rows BLOCKED |
| M07 domains/DNS | not yet | `DomainOwnershipVerifier` mock (TXT/HTTP challenge simulated); real linkage accepted in M07 |
| M08 managed databases | not yet | `DatabaseBindingProvider` mock; `/databases` binding returns `422 unsupported_capability` when no provider is enabled |
| M08 object storage / backup sink (D-07 OPEN) | not yet | `BackupSink` interface: `node-local-segregated` for dev/staging; **production sink BLOCKED** until owner approves an interim or the D-07 outcome (unnumbered proposal P-M06-1: dedicated backup instance on M05 compute in the same verified region) |
| M03 invoicing | soft | Hosting plan subscription via M03 when available; otherwise ledger-only usage |
| ACME | CI uses a local ACME test server; live issuance needs a real public domain + node (HG-06-01) |

## 3. Requirement IDs closed
FR-HST-01..08 (node inventory; scheduler; site lifecycle; isolation; SSL; quotas; backups/restore; abuse controls). FR-UI: UI-M06-01..16.

## 4. Automatable engineering tasks
**S24 — validation spike + inventory PoC**
1. **D-20 validation spike** (documentation analysis, optionally live on a node when granted): read the *official CloudPanel documentation*, record cited findings (URL + read date + version) for: documented CLI/API surface, site creation/deletion, user/database/vhost/SSL management, authentication model, idempotency/listing/query capability, output formats (machine-readable?), versioning/stability, licence/edition constraints. Findings table: capability × `documented | not documented | unclear`. **Do not assume any command exists**; unverified items stay `unclear`. Output `docs/adr/ADR-017-cloudpanel-automation-path.md` (Status: Proposed) with recommendation: (a) documented API/CLI sufficient → `cloudpanel-cli` transport via node agent executing allow-listed commands; (b) otherwise bespoke node agent operating on documented/system primitives; **(c) UI scraping rejected**.
2. Node agent design doc + threat model (`docs/runbooks/node-agent-threat-model.md`): outbound mTLS channel from agent to control plane (no inbound exposure proposal), per-node client certs from Nuzm internal CA with short lifetime + rotation, **signed command envelope** (Ed25519: node id, operation id, idempotency token, nonce, expiry, command id, args), strict **allow-list** of commands with JSON-schema args, execution via argv arrays (no shell), per-command timeout/output cap, local append-only audit log shipped to control plane, agent runs as dedicated unprivileged user with narrowly scoped sudo rules, signed self-updates, replay protection.
3. Migrations: `hosting.nodes`, `node_agents`, `node_capacity`; admin APIs for nodes; inventory job (`inventory()` → versions, health, disk, memory, load); node enrolment flow (agent bootstrap token single-use).
4. `HostingAdapter` contract (docs/09 §3) + `mock-cloudpanel` (in-memory filesystem simulation with per-site users) + conformance cases.
**S25 — scheduler, lifecycle, domains/SSL, DB bindings**
5. Capacity scheduler: reservation model `node_capacity.sellable_*` vs `reserved_*`; **atomic conditional update** `reserved = reserved + n WHERE reserved + n <= sellable` inside the allocation transaction; allocation rows in `site_allocations`; overcommit factor default 1.0, changes require dual approval + audit; no hidden oversell; region/residency filter; spread/binpack strategy configurable.
6. Site lifecycle workflow on `platform.operations`: `quote consumed → authorization → allocate → create_site(token) → configure runtime → issue cert (if domain) → active`; states `creating|active|suspended|restoring|deleting|deleted|failed`; reconcile-before-retry via `findByToken` (site name token).
7. Runtime types offered = **those reported by adapter probe** for that node (no assumptions).
8. Domains: `site_domain_bindings` with ownership verification (via M07 when available; mock now), vhost update; SSL: `ssl_certificates` issue/renew (renew ≥ 30 days before expiry, proposal), custom cert upload with key stored via vault ref only; failure/backoff respecting ACME rate limits.
9. Database binding interface + mock; `/databases` endpoints.
**S26 — isolation, quotas, backups, maintenance**
10. Isolation implementation checklist verified by tests: per-site system user and group; filesystem permissions 0700/umask; per-site PHP-FPM pool (where PHP) with `open_basedir`/disabled dangerous functions per probe; separate temp dirs; per-site DB user restricted to its DB; per-site cron under site user; per-site credentials and backup encryption keys (vault refs); resource limits (cgroup/ulimit/disk quota) per site; SSH/SFTP chroot/jail where offered; log segregation (site logs readable only by site user).
11. Quotas: `site_quotas` (disk MB, inodes, bandwidth GB/month, processes/memory limits, DB count) from plan entitlements; enforcement (soft warn 80%, hard block 100% proposals) with user notifications.
12. Backups: scheduled + on-demand; per-site encryption; `site_backups` with checksum manifest; `POST /restores` performs **pre-restore safety backup** then restore; restore verification checksum; retention per plan/M04; backup region = node region.
13. Node maintenance/drain: node status `active|draining|maintenance|retired`; drain stops new placements; admin-triggered site migration operation (backup → restore on target → verify → switch → notify); no customer data loss on failure (rollback to source retained until verified).
**S27 — billing, abuse, UI, acceptance**
14. Metering emitters (§10), hosting plan billing integration (M02 plans/entitlements; M03 subscription when present), suspension on dunning/non-payment hooks (M03), reinstatement.
15. Abuse controls: detectors (sustained CPU/IO, outbound connection/port policy such as restricted SMTP egress, suspicious process signatures, inbound abuse reports via admin `abuse-cases`), actions throttle/suspend/notify with reason codes; appeal workflow; AUP text is a human deliverable.
16. Safe offboarding: export window, then verified wipe (files, DB, vhost, user, backups per retention, certificates), wipe verification report; respects legal hold (M04).
17. UI screens, runbooks, report, demo.

## 5. Human approvals & external gates
| ID | Item | Agent does meanwhile | Default |
|---|---|---|---|
| HG-06-01 | CloudPanel licensing/edition decision; nodes provisioned (needs M05 + HG-05-0x); node access for validation | Documentation spike, mock agent, fixtures | PENDING → live rows BLOCKED |
| D-20 | CloudPanel automation path | Recommends in ADR-017 from evidence; adapter behind `CloudPanelTransport` | OPEN (decided only after spike evidence; owner approves) |
| D-07 / P-M06-1 | Backup sink for production | `BackupSink` mock; prod BLOCKED | OPEN |
| HG-05-0x | Provider capacity/limits for nodes | n/a | PENDING |
| HG-04-01 | Backup/log retention periods; AUP/abuse policy text | proposal defaults | PENDING |
| HG-12-01 | Independent pen test covers shared hosting | prepares scope | PENDING (GA) |
Agent may not mark any HG GRANTED; ADR-017 stays Proposed until owner accepts.

## 6. API specifications (doc 04 §2.6, exact)
Common: org context from token; POST create requires `Idempotency-Key`; async → `202` + `operationId`; problem+json.
| Endpoint | Portal / authz | Key fields | Behaviour / errors |
|---|---|---|---|
| GET `/v1/hosting/plans` | C A R; `hosting:plan:read` | plan `{id,name,quotas{diskMb,inodes,bandwidthGb,dbCount,sitesCount},price,runtimes[],country}` — only plans with ≥1 eligible node region | Plans without capacity hidden |
| POST `/v1/hosting/sites` | C A R; `hosting:site:create` | `{quoteId, planId, name, projectId, environmentId?, runtime, primaryDomain?}` → `202 {site{id,status:'creating'},operationId}` | 409 `quote_expired`, 409 `no_capacity` (never oversell), 403 `residency_denied`, 422 `unsupported_runtime`, 429 `quota_exceeded` |
| GET `/v1/hosting/sites`, `/{id}` | C A R; `hosting:site:read` | Site `{status,plan,dataRegion,runtime,domains[],quotas,usageSummary}` | other-org id → 404; node identity hidden for C |
| PATCH `/v1/hosting/sites/{id}` | C A R; `hosting:site:update`; `If-Match` | `{runtime settings, planId (upgrade), name}`; admin-only status changes via X | plan change re-checks capacity |
| DELETE `/v1/hosting/sites/{id}` | C A R; `hosting:site:delete` | → `202` offboarding op | requires confirmation token header `X-Confirm-Delete: <siteName>`; legal hold → 409 `legal_hold_active` |
| POST/GET `/v1/hosting/sites/{id}/backups` | C A R; `hosting:backup:create\|read` | POST `{label?}` → `202`; GET list `{id,size,createdAt,checksum,status}` | quota on backups count/size |
| POST `/v1/hosting/sites/{id}/restores` | C A R; `hosting:backup:restore` | `{backupId}` → `202` | pre-restore safety backup; 409 `restore_in_progress` |
| POST/GET `/v1/hosting/sites/{id}/domains` | C A R | `{domain, primary?}`; response includes `verification{method,record}` | 409 `domain_in_use` (other org), 422 `ownership_unverified` |
| POST/GET `/v1/hosting/sites/{id}/ssl-certificates` | C A R | `{mode:'managed'\|'custom', domains[], certRef?}` → op | custom key material via secure upload to vault ref only |
| POST/GET `/v1/hosting/sites/{id}/databases` | C A R | binding `{databaseId}` (M08) | 422 `unsupported_capability` until M08 provider enabled |
| GET `/v1/hosting/sites/{id}/usage` | C A R | `{diskMb,inodes,bandwidthGbMonth,backupGb,period}` | |
| GET/POST `/v1/admin/hosting/nodes`, PATCH `…/{id}` | X; `hosting_admin` | node `{computeInstanceId, region, status, agentId}`; PATCH `{status:'draining'\|'maintenance'\|'active'\|'retired', overcommit?}` | overcommit change dual approval |
| GET `/v1/admin/hosting/nodes/{id}/capacity` | X | sellable/reserved/free by dimension, allocations | |
| POST `/v1/admin/hosting/abuse-cases` | X; `hosting_admin`, `support` | `{siteId, source, severity, evidenceRefs, action}` | action suspend/throttle audited; also created by detectors |

## 7. Database migrations
`hosting` schema created in M06 (docs/05); `compliance`/`platform`/`billing` consumed. Range reserved at S24.
| Table | Key columns / constraints |
|---|---|
| `hosting.nodes` | id, compute_instance_id (opaque), region/data_region, status, cloudpanel_version, agent_id, overcommit_factor numeric default 1.0 (CHECK 0.5..1.0 unless dual-approved flag), tenant-less (platform org) |
| `hosting.node_agents` | id, node_id, cert_fingerprint, enrolled_at, last_seen_at, version, state |
| `hosting.node_capacity` | node_id, dim (`cpu_millicores`,`memory_mb`,`disk_mb`,`sites`), sellable, reserved; **CHECK reserved ≤ sellable AND reserved ≥ 0** |
| `hosting.site_allocations` | site_id, node_id, reserved per dim; unique (site_id); FK within schema |
| `hosting.sites` | id, org_id, project_id, name, plan_id (opaque), runtime, status, data_region, node_id, domain_primary, deletion state, version; RLS; unique (org_id, name) |
| `hosting.site_quotas` | site_id, dim, limit, soft_limit, enforced_at |
| `hosting.site_backups` | id, site_id, org_id, size_bytes, checksum, enc_key_ref (vault), sink_ref, status, created_at, expires_at; RLS |
| `hosting.ssl_certificates` | id, site_id, org_id, domains[], mode, not_after, status, secret_ref (vault) |
| `hosting.site_domain_bindings` | id, site_id, org_id, domain, verified_at, primary; unique (domain) while active (global uniqueness prevents cross-org hijack) |
| `hosting.abuse_cases` | id, site_id, org_id, source, severity, state, actions jsonb, evidence_refs |
All `org_id` tables RLS-forced; node/capacity tables admin-realm only. Seed: default hosting plan fixtures for dev/test only. Reversal: dev/staging down scripts; production forward-fix. Triggers enforce capacity CHECK even if app bug.

## 8. UI screens
All: ar (RTL)/en, loading/empty/error/forbidden, accessible, e2e.
| ID | Portal | Route | Purpose | States / roles |
|---|---|---|---|---|
| UI-M06-01 | C A R | `/hosting/plans` | Plans comparison | no-capacity hidden |
| UI-M06-02 | C A R | `/hosting/sites/new` | Create-site wizard (plan, runtime, domain, quote review incl. residency/tax) | no_capacity, quote_expired |
| UI-M06-03 | C A R | `/hosting/sites` | Site list | status chips |
| UI-M06-04 | C A R | `/hosting/sites/[id]` | Overview, operation timeline, quotas gauges | creating/failed/suspended banners |
| UI-M06-05 | C A R | `/hosting/sites/[id]/domains` | Bind domains, verification instructions | verification pending |
| UI-M06-06 | C A R | `/hosting/sites/[id]/ssl` | Certificates, renew, custom upload | expiring warnings |
| UI-M06-07 | C A R | `/hosting/sites/[id]/databases` | Database bindings | unavailable until M08 |
| UI-M06-08 | C A R | `/hosting/sites/[id]/backups` | Backup list, create, restore (confirm dialog) | restore-in-progress lock |
| UI-M06-09 | C A R | `/hosting/sites/[id]/usage` | Usage vs quota charts | threshold alerts |
| UI-M06-10 | C A R | `/hosting/sites/[id]/settings` | Runtime settings, delete (type-name confirm) | legal-hold block |
| UI-M06-11 | X | `/hosting/nodes` | Node list/health/agent state | |
| UI-M06-12 | X | `/hosting/nodes/[id]` | Capacity by dimension, allocations, drain/maintenance controls | dual-approval modal |
| UI-M06-13 | X | `/hosting/sites` | Cross-org site search (audited), suspend/resume | reason required |
| UI-M06-14 | X | `/hosting/abuse` | Abuse case queue, evidence, actions, appeals | |
| UI-M06-15 | X | `/hosting/agents` | Agent enrolment, cert rotation, command audit log viewer | |
| UI-M06-16 | A | `/agency/clients/[clientId]/hosting/sites` | Read/manage client sites (delegation, M11 flag) | hidden until M11 |

## 9. Security, compliance & tenant-isolation requirements
- **Isolation contract:** §4 item 10; every control has an automated escape test (§11). Failing any → milestone cannot pass.
- Node agent per ADR threat model; control plane cannot send non-allow-listed commands; agent rejects expired/replayed/unsigned envelopes.
- Secrets: site DB passwords/keys/cert private keys only via vault refs; credentials rotation operation; never in logs/backups manifest.
- Backups: per-site encryption keys; download only via authenticated, expiring, org-checked links; cross-org backup id → 404.
- Residency: node `data_region` from M05 resource; site placement filtered by `evaluate()`; backup sink region = site region; hook entries registered in M04 hook registry.
- Audit events: `site.create.requested|succeeded|failed`, `site.suspended|resumed`, `site.deleted`, `site.domain.bound`, `ssl.issued|renewed|failed`, `backup.created|restored`, `node.status.changed`, `node.overcommit.changed`, `agent.enrolled|cert.rotated`, `abuse.case.opened|actioned`, `admin.cross_org_read`.
- PII: site logs may contain personal data (class `personal`), retention per M04; domain/contact data class `personal`.
- Egress controls: per-site outbound SMTP restricted by default; documented exceptions.

## 10. Metering & billing hooks
Meters: `hosting.site_months`, `hosting.disk_gb_months`, `hosting.bandwidth_gb`, `hosting.backup_gb_months`.
| Emit point | Event |
|---|---|
| Site active period (daily accrual; `event_id = hash(site_id, day)`) | `hosting.site_months` fraction |
| Agent usage report (hourly: disk bytes; monthly cumulative bandwidth from per-site access logs) | `hosting.disk_gb_months`, `hosting.bandwidth_gb` |
| Backup size change | `hosting.backup_gb_months` |
Quota checks: M02 entitlement `hosting.sites.max` at create; per-site `site_quotas` enforcement. Node infra cost is captured through M05 `compute.*` meters for the platform org (internal margin view). Suspension on non-payment through M03 dunning → `PATCH` admin status.

## 11. Automated tests
- **Capacity invariant:** property/fuzz test — 100,000 randomized allocate/resize/release operations across 5 nodes with 32 concurrent workers; invariants: `reserved ≤ sellable` per dimension at every committed state; 0 violations; plus direct SQL attempt to violate CHECK fails.
- **Concurrency:** 100 parallel site creates against a node with capacity for 10 → exactly 10 succeed, 90 get `no_capacity`; no leaked reservations after failures (reservation count = active sites).
- **Reconcile-before-retry:** agent timeout after site created → no duplicate site/user; `findByToken` adopts.
- **Isolation/escape suite (each must be denied; ≥25 cases):** read other site's files via path traversal, symlink, `/proc`, `/tmp`, shared sockets; PHP `open_basedir` bypass attempts; DB cross-user query, `information_schema` enumeration of other DBs; read other site's `.env`, cron, logs; access other site's TLS private key; backup download with another org's id/token; credentials endpoint with other org; process list visibility; resource exhaustion (fork bomb, disk fill, inode fill) confined by quotas without impacting neighbour latency beyond threshold (proposal: neighbour p95 degradation < 20%); agent command injection via args; forged/replayed/expired envelopes; node-to-node lateral movement via agent channel.
- **Backups:** backup→mutate→restore round-trip checksum equality for 5 site fixtures; corrupted backup detected; pre-restore safety backup exists; restore time budget (proposal ≤ 10 min for 1 GB fixture on test node) reported.
- **TLS:** ACME test server issuance, renewal at T-30 days (fake clock), failure backoff, custom cert key never logged.
- **Domains:** same domain bound by two orgs → 409; unverified ownership blocks vhost.
- **Quotas:** soft/hard enforcement; notification emitted once per threshold.
- **Drain/maintenance:** drain excludes node from scheduling; migration failure leaves source intact.
- **Billing/metering:** replay fixtures exact; duplicate events no double count; suspension via dunning mock.
- **Abuse:** detector fixtures trigger case; suspend/appeal flows.
- **Offboarding:** wipe verification report lists 0 residual files/DB/user/backup after retention; legal hold blocks.
- **Cross-tenant:** RLS suite over `hosting.*` org tables; agent audit shows no cross-org command.
- **Contract/e2e:** OpenAPI conformance for §6; UI-M06-01..16 e2e; axe ar/en.
- **Live (human-triggered, labelled):** same suites against a real CloudPanel node → `LIVE-VERIFIED`/`NOT VERIFIED`.

## 12. Deliverables
Code (hosting module, node-agent app, adapter, scheduler), migrations, `spec/openapi/hosting.yaml`, ADR-017, node-agent threat model, runbooks (`node-onboarding.md`, `site-recovery.md`, `drain-and-migrate.md`, `abuse-handling.md`, `offboarding.md`), UI, `docs/reports/M06-report.md`, evidence folder `docs/reports/evidence/M06/` (spike findings with citations, isolation test report), demo script: add mock node → create two tenants' sites → attempt cross-read (denied) → backup/restore → fill capacity (no_capacity) → drain node.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Default |
|---|---|---|---|
| AC-M06-01 | ADR-017 contains cited findings for ≥ 8 capability rows with `documented/not documented/unclear` and a recommendation | ADR + citations | PENDING |
| AC-M06-02 | Capacity fuzz: 100,000 ops, 32 workers, 0 invariant violations; direct SQL violation rejected | test log | PENDING |
| AC-M06-03 | 100 parallel creates / capacity 10 → exactly 10 created; 0 leaked reservations | test log | PENDING |
| AC-M06-04 | Isolation suite ≥ 25 escape attempts, 100% denied (mock + real-node when available) | isolation report | PENDING (mock) / BLOCKED live until HG-06-01 |
| AC-M06-05 | Timeout-after-create → 0 duplicate sites/users in 500 injected runs | test log | PENDING |
| AC-M06-06 | Backup/restore checksum equality 5/5 fixtures; corrupted backup rejected | test log | PENDING |
| AC-M06-07 | TLS issue + renew at T-30d against ACME test server; 0 private keys in logs | test log | PENDING |
| AC-M06-08 | Live TLS issuance on a real domain/node | evidence | **BLOCKED until HG-06-01 (+ domain from M07)** |
| AC-M06-09 | Quota soft/hard enforcement and notifications per threshold | e2e | PENDING |
| AC-M06-10 | Metering replay exact (0 diff) on 3 fixtures; duplicates no effect | test log | PENDING |
| AC-M06-11 | Dunning suspension/reinstatement flow | e2e | PENDING (needs M03; else NOT VERIFIED) |
| AC-M06-12 | Drain: 0 new placements on draining node; failed migration leaves source serving | test log | PENDING |
| AC-M06-13 | Offboarding wipe report 0 residual artifacts; legal hold blocks | test log | PENDING |
| AC-M06-14 | Node-agent: unsigned/expired/replayed envelopes 100% rejected (≥ 10 cases); non-allow-listed command rejected | test log | PENDING |
| AC-M06-15 | RLS cross-tenant suite 0 leaks for `hosting.*` | RLS report | PENDING |
| AC-M06-16 | UI-M06-01..16 e2e pass, axe 0 critical/serious (ar/en) | e2e+axe | PENDING |
| AC-M06-17 | D-20 decided (ADR-017 Accepted by owner) | owner sign-off | **BLOCKED until owner decision + node evidence** |
| AC-M06-18 | Production backup sink in place and restore tested in-region | evidence | **BLOCKED until D-07/P-M06-1** |
| AC-M06-19 | Independent pen test of shared-hosting isolation | report | **BLOCKED until HG-12-01** |

## 14. Handoff
M07: domain linkage replaces `DomainOwnershipVerifier` mock and auto-creates DNS records for Nuzm-managed zones; M08: database binding provider and backup sink; M09/M10: publish target = hosting site (deployment adapter); M11: agency view; M12: pen test scope, DR for nodes/backups. Open: D-20, D-07/P-M06-1, HG-06-01.

## 15. Compliance hooks checklist
- [ ] Residency `evaluate()` for node selection and backup sink; `data_region` on sites/backups
- [ ] PII classification of site logs, domain contacts; field encryption for credentials
- [ ] Audit events (§9) incl. cross-org admin reads
- [ ] Retention: backup/log policies from M04; legal hold respected by wipe/offboarding
- [ ] ROPA entry for hosting processing (Nuzm as processor/controller per D-16)

**Spec issues found:** SI-M06-1 doc 04 has no admin endpoint to list/inspect abuse cases or per-site quotas; SI-M06-2 `/v1/hosting/plans` vs `/v1/offers?kind=hosting` overlap undefined; SI-M06-3 no endpoint for site suspension/reinstatement (assumed via admin PATCH not in doc 04; M06 uses `PATCH /v1/admin/hosting/nodes` only for nodes — site suspend path unspecified); SI-M06-4 backup sink ownership (hosting vs data) unspecified pending D-07; SI-M06-5 ADR numbering beyond 016 not reserved.

## Completion instruction
Do not mark M06 DONE until every acceptance row is evidenced. Rows depending on HG-06-01, D-20, D-07/P-M06-1 or HG-12-01 stay BLOCKED until the owner records evidence; mocks never convert them to PASS. Never rely on UI scraping or on CloudPanel capabilities not documented in cited official sources. The agent may not mark any HG GRANTED. Deliver `docs/reports/M06-report.md` in the CLAUDE.md §10 format.
