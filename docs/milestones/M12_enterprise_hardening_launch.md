# M12 — Enterprise, Hardening & Launch

> Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.
> Response format: CLAUDE.md §10. Status words: PASS / FAIL / BLOCKED / NOT VERIFIED only.

| Field | Value |
|---|---|
| Sprints | S55–S58 (4) |
| Depends on (docs/03) | **H:** M01–M11 (all) |
| Produces | Enterprise SSO (SAML + OIDC) and SCIM, access reviews, audit retention/export, load/chaos/DR evidence, security-assessment package and pen-test management, full provider + billing reconciliation (RC-01..RC-06, TR-01..TR-04), observability and alerting, incident tooling and runbooks, launch gates and the go/no-go **decision package** |
| Gate | GA readiness: no open critical/high defects (tracker evidence incl. external pen-test retest), recovery targets evidenced, all RC reconciliations pass, every earlier BLOCKED/NOT VERIFIED row dispositioned by its owner, release approved **by a human (HG-12-03)**. |

## 1. Objective
Convert a feature-complete platform into one that can be launched responsibly: enterprise identity, proven resilience, evidence-backed security posture, reconciled money and provider state, operable by a support/SRE team. The agent builds tooling, runs automatable tests, assembles evidence and the decision package. **The agent cannot perform or certify the independent pen test, regulatory/legal/tax sign-offs, certifications, support training acceptance or the launch decision.**

## 2. Preconditions & mocked interfaces
| Dependency | Needed for | Mock allowed |
|---|---|---|
| Signed Gate Reviews M01–M11 (or explicit BLOCKED lists) | S55 start | none — M12 is not started on unsigned gates; mocked-interface work only if owner records exception |
| Test IdP tenants (HG-12-02) | SSO on real enterprise IdPs | Local SAML/OIDC test IdP containers (label `NOT VERIFIED` against real IdPs) |
| Provider sandbox/test credentials (HG-05-01..05-03, HG-07-01, HG-03-02) | Live reconciliation | Recorded fixtures/mocks; results labelled `NOT VERIFIED (fixtures)` |
| Production-like staging with M05 compute | Load/chaos/DR | Smaller scale; extrapolation not accepted as evidence — report real scale run |
| External pen-test vendor (D-28, HG-12-01) | AC security rows | Internal assessment only; external rows BLOCKED |

## 3. Requirement IDs closed
FR-ENT-01 SAML SSO · FR-ENT-02 OIDC enterprise SSO · FR-ENT-03 SCIM 2.0 · FR-ENT-04 access reviews · FR-ENT-05 audit retention/export · FR-ENT-06 org security policy (SSO/MFA enforcement) · FR-OPS-01 load tests · FR-OPS-02 chaos/failure drills · FR-OPS-03 security assessment & pen-test management · FR-OPS-04 provider + billing reconciliation · FR-OPS-05 DR backup/restore · FR-OPS-06 observability/alerts · FR-OPS-07 incident tooling/runbooks · FR-OPS-08 launch gates/go-no-go package. *(docs/01 §5 lists ranges ENT-01..06 and OPS-01..08 with seven topic phrases; this mapping is an interpretation — confirm.)*

## 4. Automatable engineering tasks
**S55 — Enterprise IAM.** 1. SAML 2.0 SP: signed assertion/response validation, audience/recipient/`NotOnOrAfter`, clock skew ≤2 min, replay cache, XML signature-wrapping defences, metadata import/export; OIDC enterprise connection (authorization code + PKCE, nonce/state, issuer/JWKS validation). 2. `identity.sso_connections` per org with verified email domain(s) (DNS TXT proof via M07), optional JIT provisioning with default role, enforcement flag (password/social login disabled for enforced domains; owner break-glass policy documented). 3. SCIM 2.0 server (`/scim/v2/*`: `Users`, `Groups`, `ServiceProviderConfig`, `Schemas`, `ResourceTypes`; filter, PATCH, pagination, `externalId` idempotency); bearer tokens from `identity.scim_tokens` (hashed, scoped to one org, rotation). Deprovision → disable membership, revoke sessions/API keys ≤ 60 s. 4. Access reviews: campaign creation (scope: org members, API keys, delegated access, admin roles), reviewer assignment, decisions, auto-revocation on `revoke` decision, evidence export. 5. Audit retention: apply `audit.retention_policies` / `legal_holds` (M04) to `audit.audit_logs` via partition-level archival (no new audit table); hash-chain verification job; export (signed manifest). 6. Org security policy (SSO enforce, MFA required, session max age, IP allow-list for API keys).
**S56 — Scale, chaos, security assessment.** 1. Load-test harness and scenarios (§11) run on staging at declared scale; results archived. 2. Chaos drills (§11) with automated assertions. 3. Security assessment pack: threat models (control plane, shared hosting, sandbox, delegation, payments/ZATCA), ASVS L2 self-assessment matrix, SAST/dependency/container/secret scans, DAST against staging, tenant-isolation sweep (auto-enumerate every endpoint × cross-tenant token), IaC review. 4. **Pen-test management:** scope document, in/out-of-scope assets, test orgs/accounts with seeded data, rules of engagement draft, remediation tracker (severity policy: critical/high/medium/low with SLA proposals 7/14/30/90 days), retest process. The agent **prepares and tracks**; vendor performs (HG-12-01).
**S57 — Reconciliation, DR, observability.** 1. Implement/run RC-01..RC-06 and TR-01..TR-04 (§6a) through `/v1/admin/billing/reconciliations` (financial) and `cloud.resource_reconciliations` (technical), with tolerance thresholds from D-31, resolutions workflow, and a **billing close checklist** run. 2. DR exercises (§11) recorded in `ops.recovery_exercises`. 3. Observability: dashboards and alert rules (`ops.alerts`) with owner, severity, runbook link; SLO definitions (`ops.slo_definitions`) from D-30; synthetic probes for login, quote, provisioning-mock path, payment-sandbox path, DNS change. 4. Incident tooling: `ops.incidents` + updates timeline, severity workflow, provider incident tracker (`ops.provider_incidents`), breach-case link to M04 workflow. 5. Runbooks (§12).
**S58 — Regression, handover, decision package.** 1. Full regression across all milestones' automated suites (record exact commands/results). 2. Documentation freeze: customer docs, API reference from OpenAPI, admin handbook, support playbooks, FAQ (AR+EN). 3. Support handover: materials, escalation matrix, on-call roster template, training agenda (**training delivery & acceptance are human: HG-12-03**). 4. `ops.launch_gates` populated from §15 checklist. 5. Assemble go/no-go **decision package** (§12); present PASS/FAIL/BLOCKED honestly; no recommendation to launch if any critical-path row is not PASS.

## 5. Human approvals & external gates
| ID | Need | Agent does meanwhile | Default |
|---|---|---|---|
| HG-12-01 / D-28 | Independent penetration test by external vendor (report + retest) | Prepares pack, test accounts, tracker; internal assessment labelled "internal, not independent" | PENDING |
| HG-12-02 | SSO test tenants at enterprise IdPs | Local test IdPs; real-IdP rows BLOCKED | PENDING |
| HG-12-03 | Go/no-go decision, support training, runbook acceptance, on-call roster | Prepares package/materials | PENDING |
| D-27 | Enterprise SSO scope | Build SAML + OIDC + SCIM (proposed default); mark deviations | OPEN |
| D-29 | Support model/SLA tiers | Draft escalation matrix | OPEN |
| D-30 / D-31 | SLO/RPO/RTO targets; reconciliation variance thresholds | Use PRD §6 proposals; flag | OPEN |
| HG-04-01 / HG-04-02 / HG-04-03 | Counsel memo, NCA/CST applicability + filings, third-party assessments/certifications | Compile control-evidence report from `compliance.evidence_items`; **cannot attest or certify** | PENDING |
| HG-03-02 / HG-03-03 / HG-03-04 | PSP production approval; ZATCA production CSID; tax sign-off | Run sandbox reconciliation; production rows BLOCKED | PENDING |
| HG-05-01..05-04, HG-06-01, HG-07-01, HG-07-02, HG-08-01, HG-09-01, HG-10-01, HG-10-02, HG-11-01 | Provider/registrar/vendor accounts and legal items | Re-list status from earlier gate reviews; live rows BLOCKED/NOT VERIFIED | PENDING |
| Incident-notification obligations (e.g. under PDPL/regulator rules — verify against current official text with counsel) | Legal timelines for breach notification | Encode configurable timers; legal values supplied by counsel | PENDING (HG-04-01) |

## 6. API specifications (docs/04 §2.12 — exact; plus reuse)
Common: admin endpoints need admin realm token + MFA; org endpoints need org admin; `Idempotency-Key` on POST; problem+json. SCIM endpoints follow RFC 7643/7644 media types and use SCIM bearer tokens (note: path is `/scim/v2/*`, outside `/v1` — see report).
| Method & path | Portal | AuthZ | Key fields / behaviour | Errors | Idem/Async |
|---|---|---|---|---|---|
| POST/GET `/v1/organizations/{orgId}/sso-connections` | C (org admin) | `org:security` (recent MFA) | `{protocol: saml|oidc, metadataUrl|xml|issuer, domains[], jit{enabled,defaultRole}, enforce}`; domain proof status; test-login result | 422 invalid metadata/unsigned, 409 domain claimed | idempotent |
| `/scim/v2/*` (`Users`, `Groups`, `ServiceProviderConfig`, `Schemas`, `ResourceTypes`) | IdP | SCIM bearer (org-scoped) | RFC 7644 CRUD/PATCH/filter; `externalId` idempotent create | SCIM error schema; 401/403/409/429 | idempotent by `externalId` |
| GET/POST `/v1/admin/access-reviews` · POST `…/{id}/decisions` | X | `admin:security` | campaign `{scope, reviewers[], dueAt}`; decision `{itemId, keep|revoke, reason}`; revoke executes via owning module | 409 closed, 403 reviewer not assigned | idempotent |
| GET `/v1/admin/operations/health` | X | `admin:ops:read` | component statuses, queue lag, reconciler last-run, provider health, SLO burn | — | — |
| GET/POST `/v1/admin/incidents` · PATCH `…/{id}` | X | `admin:ops` | `{severity, title, components[], status, timeline}` | 422 | idempotent |
| GET/POST `/v1/admin/alerts` | X | `admin:ops` | alert definitions/state (acknowledge, silence with expiry) | 422 | idempotent |
| GET `/v1/admin/provider-incidents` | X | `admin:ops:read` | provider status events linked to incidents/resources | — | — |
| GET/POST `/v1/admin/recovery-exercises` | X | `admin:ops` | `{scope, startedAt, restoredAt, rpoSeconds, rtoSeconds, evidenceRefs[], result}` | 422 | idempotent |
| GET/PUT `/v1/admin/policy-versions` | X | `admin:compliance` | versioned policy documents (security, privacy, AUP) with effective dates; PUT creates new version | 409 ETag | ETag |
| GET/PUT `/v1/admin/audit-retention` | X | `admin:compliance` | retention periods per audit class, legal holds ref, archive target region | 422 below minimum set by D-34 | ETag |
| GET `/v1/admin/audit-logs` | X | `admin:audit` | (M01 endpoint) used for export/verification | — | — |
| GET `/v1/admin/billing/reconciliations` · POST (run) · GET `…/{id}` · POST `…/{id}/resolutions` | X | `admin:finance` | (M03) kinds RC-01..RC-06 (defined in M03; M12 runs them across all providers) | — | 202 for run |
| POST `/v1/admin/resources/{id}/reconciliations` | X | `admin:cloud` | (M05) forced technical reconcile | — | 202 |
Spec gaps to raise as SCRs before implementing UI/features that need them: SCR-M12-01 SCIM token issuance/rotation endpoint; SCR-M12-02 org security-policy fields (extend `PATCH /v1/organizations/{orgId}` via M01 owner); SCR-M12-03 read/write for `ops.launch_gates` and `ops.slo_definitions`; SCR-M12-04 access-review item listing (`audit` schema has `access_reviews` only). **Do not implement undeclared endpoints before approval.**

### 6a. Reconciliation classes (canonical definitions: RC-xx in docs/11 §Reconciliation; TR-xx in docs/05 §7)
Financial (stored in `finrec`, run via `/v1/admin/billing/reconciliations`): **RC-01** payments vs PSP settlements · **RC-02** ledger vs invoices/credit notes · **RC-03** rated usage vs invoice lines (billing close) · **RC-04** provider/registrar cost records and ledger cost accounts vs provider bills (Alibaba, Huawei, Contabo, CloudPanel node VPS costs, registrars, data/email vendors where `fetchBilling` exists) · **RC-05** ZATCA submissions vs issued invoices · **RC-06** wallet projection vs ledger.
Technical (stored in `cloud.resource_reconciliations`, run via `POST /v1/admin/resources/{id}/reconciliations` and scheduled): **TR-01** `cloud.resources`/`compute.instances` vs provider inventory (0 orphaned billable resources; 0 unknown-state > 1 h) · **TR-02** `hosting.nodes`/`hosting.sites` vs node report (0 sites without allocation; 0 oversold nodes) · **TR-03** `domains.*` vs registrar state/expiry (0 mismatches) · **TR-04** `data.*`/`email.*` resources vs provider state.
Tolerances: D-31 (proposal: 0 minor units for RC-01/02/05/06; ≤ 0.5 % for RC-03/04 pending finance).

## 7. Database migrations (owners per docs/05; extends only)
| Schema.table | Action | Key columns / notes |
|---|---|---|
| `identity.sso_connections` | create | `org_id, protocol, config jsonb (no secrets), verified_domains text[], jit jsonb, enforce bool, status, vault_ref?` |
| `identity.scim_tokens` | create | `org_id, token_hash, scopes, expires_at, last_used_at, revoked_at`; token shown once |
| `audit.access_reviews` | create | `scope, status, due_at, created_by`; item/decision persistence needs manifest approval (SCR-M12-04) |
| `audit.audit_logs` | extend (no new table) | partition archival metadata, `retention_class` column, export manifests via existing tables |
| `compliance.policy_versions` | create | `policy_key, version, body_ref, effective_from, approved_by` (owner approval recorded by human) |
| `ops.incidents`, `ops.incident_updates` | create | severity, status, component set, timeline entries, `breach_case_id?` |
| `ops.alerts` | create | rule, severity, owner, runbook_url, state, silenced_until |
| `ops.provider_incidents` | create | `provider_account_id?, external_ref, status, started_at, resolved_at, related_incident_id` |
| `ops.recovery_exercises` | create | scope, targets, measured RPO/RTO, evidence_refs, result |
| `ops.slo_definitions`, `ops.launch_gates` | create | SLO objective/window; gate key, status enum, evidence_ref, decided_by (human), decided_at |
RLS: `identity`/`audit` org-scoped; `ops`/`compliance.policy_versions` platform-level (explicit tenant-less list in manifest). `audit.*`, `ops.launch_gates` decisions insert-only history. Reversal: forward-only; `.down.sql` dev/staging. Seed: severity policy, default alert rules, launch-gate keys.

## 8. UI screens (AR-RTL + EN; loading/empty/error/forbidden states)
| ID | Portal | Route | Purpose | Roles |
|---|---|---|---|---|
| UI-M12-01 | C | `/settings/security/sso` | SSO connections, domain proof, test login, enforcement toggle | org:security |
| UI-M12-02 | C | `/settings/security/scim` | SCIM status/token rotation (**depends on SCR-M12-01**) | org:security |
| UI-M12-03 | C | `/settings/security/policy` | MFA/session/IP policy (**SCR-M12-02**) | org:security |
| UI-M12-04 | X | `/operations/health` | Health, queue lag, reconciler status, SLO burn | admin:ops:read |
| UI-M12-05 | X | `/incidents` | Incident list/create | admin:ops |
| UI-M12-06 | X | `/incidents/[id]` | Timeline, comms drafts, breach-case link | admin:ops |
| UI-M12-07 | X | `/alerts` | Rules, ack/silence | admin:ops |
| UI-M12-08 | X | `/provider-incidents` | Provider incident feed | admin:ops:read |
| UI-M12-09 | X | `/recovery-exercises` | DR exercise records and evidence | admin:ops |
| UI-M12-10 | X | `/access-reviews` | Campaign list/create | admin:security |
| UI-M12-11 | X | `/access-reviews/[id]` | Review items & decisions (**SCR-M12-04**) | reviewer |
| UI-M12-12 | X | `/policies` | Policy versions | admin:compliance |
| UI-M12-13 | X | `/audit` | Audit explorer, hash-chain status, export | admin:audit |
| UI-M12-14 | X | `/audit/retention` | Retention + legal hold view | admin:compliance |
| UI-M12-15 | X | `/billing/reconciliations` | RC-01..RC-06 / TR-01..TR-04 dashboard (extends M03 screen), run/resolve | admin:finance |
| UI-M12-16 | X | `/launch` | GA readiness board from §15 (**SCR-M12-03**; read-only until approved) | admin:ops |
| UI-M12-17 | X | `/support/handbook` | Embedded runbook index, escalation matrix | support |

## 9. Security, compliance & tenant isolation
- SSO: enforced-domain accounts cannot authenticate by other methods; SAML defences (wrapping, replay, algorithm allow-list: no SHA-1/`none`); IdP-initiated flow disabled unless explicitly enabled; JIT never grants admin roles by default; SCIM tokens hashed, org-bound, rate-limited; deprovision revokes sessions, API keys and delegated grants it created.
- Admin plane: separate realm/network, MFA, break-glass audited with two-person rule, impersonation time-boxed.
- Audit: append-only, hash-chain verified daily; retention archival never deletes held records; exports signed.
- Incident/breach: timers/notification templates configurable; legal deadlines supplied by counsel (hedged: *per published PDPL / regulator rules — verify against current official text with counsel*); DSR and breach workflows exercised in drills.
- Tenant isolation: automated sweep over **every** endpoint in `spec/openapi` × cross-tenant token; any unexplained 200 fails the build.
- Data residency: DR backups and audit archives placed per `ResidencyPolicyService`; restore drills run in-region.
- PII: incident records exclude raw PII; evidence artifacts scanned.
- Audit events: `sso.connection.created|enforced`, `scim.token.issued|revoked`, `scim.user.provisioned|deprovisioned`, `access_review.decision`, `audit.retention.changed`, `incident.opened|closed`, `recovery_exercise.recorded`, `launch_gate.decided`, `policy.version.published`.

## 10. Metering & billing hooks
No new meters. Verification tasks: every meter in the catalogue has (a) producer, (b) emission test, (c) rating fixture, (d) invoice-line fixture, (e) provider-cost mapping where applicable (RC-04) — matrix in `docs/reports/M12-metering-coverage.md`: `compute.*`, `network.egress_gb`, `hosting.*`, `storage.*`, `database.*`, `cache.instance_hours`, `email.*`, `domain.*`, `dns.zone_months`, `ai.*`, `builder.build_minutes`, `mobile.build_minutes`, `automation.*`. Missing coverage = FAIL. Enterprise SSO/SCIM billing as plan entitlement flags only (no meter).

## 11. Automated tests and drills
- **SSO/SCIM:** SAML: valid, unsigned, wrong audience, expired, replayed, wrapped, wrong issuer, algorithm downgrade; OIDC: bad nonce/state/issuer/JWKS rotation; enforcement bypass attempts; SCIM RFC 7644 conformance (create/patch/filter/pagination/idempotency), deprovision latency, cross-org token reuse denied.
- **Access review:** campaign → revoke decision removes membership/API key/delegation; reviewer not assigned denied; double decision idempotent.
- **Audit retention:** legal hold blocks archival purge; hash-chain tamper test detected; export manifest verification.
- **Load (proposals tied to D-30; run on staging at declared scale, report real numbers):** control-plane API mixed workload 500 rps for 30 min, p95 reads < 300 ms, writes < 800 ms, error rate < 0.5 %; 2,000 concurrent sessions; ledger posting ≥ 200 tx/s with imbalance 0; metering ingest 5,000 events/s sustained, 0 loss, 0 duplicates; workflows 100 executions/s; 200 concurrent AI runs (mock gateway) respecting caps; reconcilers finish within window under load; soak 4 h with no memory growth > 20 %.
- **Chaos/failure drills (automated assertions):** provider timeout/`uncertain` on provision (adapter fault injection) → reconcile-before-retry, **0 duplicate billable resources**; provider outage → circuit breaker, offers hidden, operations `waiting_provider`; DB primary failover → API recovers ≤ 5 min, 0 acknowledged writes lost, 0 ledger imbalance; Redis/queue loss → outbox replay, 0 lost events, duplicates deduped; duplicate/out-of-order webhooks (PSP, registrar, email, cloud) ×50 → 0 duplicate effects; worker crash mid-operation → resume; clock skew on ZATCA submit; secrets-vault unavailable → fail closed.
- **DR exercises (record in `ops.recovery_exercises`):** control-plane DB PITR restore into scratch environment (target RPO ≤ 15 min, RTO ≤ 4 h — D-30 proposals); object-storage/bucket sample restore; one hosting site restore; one managed DB restore; secrets/KMS recovery procedure dry-run; regional loss tabletop (human-led). Measured timestamps must be recorded, not estimated.
- **Provider lifecycle regression:** per adapter conformance kit (Alibaba, Huawei, Contabo, CloudPanel, Openprovider, ResellerClub) on fixtures; live-sandbox lifecycle only with HG evidence, labelled `LIVE-VERIFIED` or `NOT VERIFIED`.
- **Reconciliation:** RC-01..RC-06 on seeded fixtures including injected discrepancies (missing resource, extra resource, cost variance, duplicate PSP event, unsubmitted ZATCA invoice) — each must be detected and routed to resolutions.
- **Security:** tenant sweep, ASVS L2 checklist automation where possible, dependency/container/secret scans, DAST on staging, sandbox escape suite re-run (M10), rate-limit/abuse tests.
- **Full regression:** all milestone suites + Playwright journeys (signup → org → quote → provision → invoice → pay (sandbox) → domain → site → AI build → deploy) in AR and EN.

## 12. Deliverables
Source, migrations, `spec/` updates, UI §8; reports in `docs/reports/`: `M12-report.md`, `M12-load-report.md`, `M12-chaos-report.md`, `M12-dr-report.md`, `M12-reconciliation-report.md`, `M12-security-assessment-pack/` (threat models, scans, ASVS matrix, pen-test scope & tracker), `M12-metering-coverage.md`, `blocked-register.md` (every BLOCKED/NOT VERIFIED/DEFERRED row across M01–M12 with owner, reason, disposition, target date), `ga-readiness-checklist.md` (§15); runbooks in `docs/runbooks/`: incident-response, provider-outage, db-failover, queue-recovery, webhook-storm, reconciliation-variance, billing-close, zatca-backlog, psp-outage, sandbox-escape-suspected, data-breach-workflow (with counsel placeholders), dr-restore (per data store), sso-lockout, scim-failure, abuse-takedown, access-review-process; customer + admin + support documentation; **decision package**: readiness checklist, risk register, open-defect list with severities, reconciliation and DR evidence index, compliance evidence status, cost model vs actual provider bills, support readiness (human-completed fields marked), rollback/hotfix plan, communications drafts. Demo script: end-to-end journey + failure drill replay.

## 13. Measurable acceptance criteria
| ID | Criterion | Evidence | Status |
|---|---|---|---|
| AC-M12-01 | SAML/OIDC test suite: 100 % of negative cases rejected, positive cases succeed on local test IdPs | test output | PENDING |
| AC-M12-02 | SSO verified against ≥1 real enterprise IdP tenant per protocol | login evidence | BLOCKED-until-evidence (HG-12-02) |
| AC-M12-03 | SCIM RFC 7644 conformance suite passes; deprovision revokes sessions ≤ 60 s p95 | test output | PENDING |
| AC-M12-04 | Access review campaign revokes access end-to-end; 0 residual access in verification query | test + query output | PENDING |
| AC-M12-05 | Audit hash-chain verification passes; tamper test detected; legal hold prevents purge | job output | PENDING |
| AC-M12-06 | Load targets (§11) met at declared scale with real run output (or each miss recorded FAIL with remediation) | load report | PENDING |
| AC-M12-07 | Chaos drills: 0 duplicate billable resources, 0 lost outbox events, 0 duplicate webhook effects, 0 ledger imbalance | drill report | PENDING |
| AC-M12-08 | DR: measured RPO ≤ 15 min and RTO ≤ 4 h (or approved D-30 values) for control-plane DB; store restore samples succeed | `ops.recovery_exercises` rows with timestamps | PENDING |
| AC-M12-09 | Tenant sweep: 0 unexplained cross-tenant 2xx across 100 % of endpoints | sweep output | PENDING |
| AC-M12-10 | Internal security assessment complete: 0 open critical/high from SAST/DAST/dependency/container scans | scan reports, tracker | PENDING |
| AC-M12-11 | Independent pen test completed, all critical/high fixed and retested | vendor report + retest letter | BLOCKED-until-evidence (HG-12-01) |
| AC-M12-12 | RC-01..RC-06 and TR-01..TR-04 run on fixtures: 100 % of injected discrepancies detected; clean data → 0 variance within D-31 tolerance | reconciliation report | PENDING |
| AC-M12-13 | RC-01..RC-06 on live sandbox/provider data where credentials granted; variance within tolerance | report labelled LIVE-VERIFIED | BLOCKED-until-evidence (HG-05-xx, HG-07-01, HG-03-02) |
| AC-M12-14 | ZATCA production clearance/reporting in production environment | ZATCA responses | BLOCKED-until-evidence (HG-03-03) |
| AC-M12-15 | Metering coverage matrix complete for all catalogue meters | matrix | PENDING |
| AC-M12-16 | Full regression green (commands + results recorded); 0 failing P0/P1 tests | CI logs | PENDING |
| AC-M12-17 | All earlier BLOCKED/NOT VERIFIED rows listed with owner and disposition in `blocked-register.md`; 0 undispositioned | document | PENDING |
| AC-M12-18 | Runbooks exist for every §12 item; each executed once in a drill or tabletop with notes | drill notes | PENDING |
| AC-M12-19 | Compliance evidence report generated; counsel/regulatory/certification rows tracked as owner-supplied | report | BLOCKED-until-evidence (HG-04-01..04-03) |
| AC-M12-20 | Support training delivered and runbooks accepted by support/on-call | sign-off | BLOCKED-until-evidence (HG-12-03) |
| AC-M12-21 | Go/no-go decision recorded by owner | signed decision | BLOCKED-until-evidence (HG-12-03) |
| AC-M12-22 | All §8 screens: AR-RTL + EN screenshots, 4 states, axe 0 critical | report | PENDING |

## 14. Handoff
→ Operations/support: runbooks, dashboards, alert routing, escalation matrix, blocked-register ownership. → Post-GA backlog: DEFERRED items with approved change-log entries; hypercare plan (proposal: 2 weeks daily reconciliation review); periodic access-review and DR cadence (proposal quarterly/semiannual).

## 15. Compliance hooks checklist & GA readiness checklist
Compliance hooks: [ ] DR/backup/archive regions obey residency policy · [ ] Retention periods set per D-34 with counsel values · [ ] Breach-notification workflow exercised (timers configured by counsel) · [ ] DSR exercised end-to-end across all data stores · [ ] Policy versions published with effective dates · [ ] Control evidence collectors green · [ ] Regulatory validation register reviewed (statuses owner-supplied).

**GA readiness checklist** (all PENDING by default; the agent may **not** change any status to PASS/GRANTED — the owner records evidence; `Agent may mark` = No for every row).
| # | Item | Owner | Source | Status |
|---|---|---|---|---|
| G-01 | HG-00-01 documentation approval | Owner | docs/07 | PENDING |
| G-02..G-12 | Gate Reviews M01…M11 signed (one row each) | Owner | docs/03 §5 | PENDING |
| G-13 | M12 Gate Review signed | Owner | this doc | PENDING |
| G-14 | HG-01-01 repo/CI · HG-01-02 IdP hosting | Owner/DevOps | docs/07 | PENDING |
| G-15 | HG-02-01 price book approved (D-23, D-25) | Finance | docs/07 | PENDING |
| G-16 | HG-03-01 VAT-registered entities (D-33) | Finance | docs/07 | PENDING |
| G-17 | HG-03-02 PSP production approval (D-10) | Finance | docs/07 | PENDING |
| G-18 | HG-03-03 ZATCA production CSID/onboarding (D-11) | Finance/Tax | docs/07 | PENDING |
| G-19 | HG-03-04 tax advisor sign-off (incl. D-24 reseller treatment) | Tax advisor | docs/07 | PENDING |
| G-20 | HG-04-01 counsel memo (D-14, D-16, D-17, D-34) | Legal | docs/07 | PENDING |
| G-21 | HG-04-02 NCA/CST applicability + filings | Legal/Security | docs/07 | PENDING |
| G-22 | HG-04-03 third-party assessments/certifications | Security | docs/07 | PENDING |
| G-23 | PDPL obligations validated (DPO, ROPA, transfers, DSR) | Legal | M04 register | PENDING |
| G-24 | HG-05-01 Alibaba · HG-05-02 Huawei · HG-05-03 Contabo accounts + verified regions/capabilities | Owner | docs/07 | PENDING |
| G-25 | HG-05-04 provider quotas/spend caps | Owner | docs/07 | PENDING |
| G-26 | HG-06-01 CloudPanel licensing/nodes (D-20 outcome) | Owner | docs/07 | PENDING |
| G-27 | HG-07-01 registrar accounts · HG-07-02 `.sa` route (D-19) | Owner/Legal | docs/07 | PENDING |
| G-28 | HG-08-01 data/email providers contracted (D-05..D-09) | Owner | docs/07 | PENDING |
| G-29 | HG-09-01 model provider contracts (D-18) | Owner | docs/07 | PENDING |
| G-30 | HG-10-01 store accounts/signing/macOS (D-22) · HG-10-02 sandbox security review (D-21) | Owner/Security | docs/07 | PENDING |
| G-31 | HG-11-01 marketplace terms/payout route (D-26) | Legal | docs/07 | PENDING |
| G-32 | HG-12-01 independent pen test + retest (D-28) | Owner | docs/07 | PENDING |
| G-33 | HG-12-02 SSO tenants · D-27 scope | Owner | docs/07 | PENDING |
| G-34 | HG-12-03 training, runbook acceptance, on-call roster (D-29), go/no-go | Owner | docs/07 | PENDING |
| G-35 | Remaining OPEN decisions D-01…D-34 closed or explicitly deferred | Owner | docs/07 | PENDING |
| G-36 | `blocked-register.md` fully dispositioned | Owner | AC-M12-17 | PENDING |
| G-37 | No open critical/high defects (tracker export attached) | Owner | AC-M12-10/11 | PENDING |
| G-38 | DR and reconciliation evidence accepted | Owner/Finance | AC-M12-08/12/13 | PENDING |

## Completion instruction
Do not mark this milestone DONE until every acceptance row is evidenced. Mark missing external approvals, vendor reports, certifications, legal/tax sign-offs, accounts or decisions as BLOCKED rather than simulating success. The agent must not mark any HG, D, or GA-checklist item as granted/passed, must not present internal assessments as independent ones, and must not recommend or announce launch: the go/no-go decision belongs to the owner (HG-12-03).
