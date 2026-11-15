# Nuzm — Provider Selection Decision Records (draft)

Applies to D-05, D-06, D-07, D-08, D-09, D-10, D-18 (`07-open-decisions-and-blockers.md`). All records are **OPEN**. Nothing below asserts that any vendor offers a feature, region, API or price; each claim must be established by the **verification probes** using sandbox/test accounts supplied by the owner (HG-05-01/02, HG-08-01, HG-03-02, HG-09-01). Scores are intentionally blank. Decision owner and date are placeholders to be filled by the owner; the agent may propose, never decide.

## 0. Shared method
**Scoring template (weights are proposals; owner may change):**
| Criterion | Weight | Option A | Option B | Option C |
|---|---|---|---|---|
| Residency/verified in-Kingdom or approved-region placement (D-14) | 20 | _ | _ | _ |
| Tenant isolation model (separate instance/credentials/keys) | 15 | _ | _ | _ |
| Backup, PITR/restore-to-new, tested restore | 12 | _ | _ | _ |
| API/automation completeness (idempotent create, tags/lookup by token, webhooks) | 12 | _ | _ | _ |
| Metering data availability (usage by resource/period) | 8 | _ | _ | _ |
| Cost model predictability / margin viability (D-23) | 10 | _ | _ | _ |
| Ops burden for Nuzm (HA, patching, on-call) | 10 | _ | _ | _ |
| Exit/portability (standard protocol, data export) | 8 | _ | _ | _ |
| Contract/data terms (retention, training, sub-processors) | 5 | _ | _ | _ |
Score 0–5 per cell **only with an evidence link** (probe output, contract clause, documentation URL read on date). Unscored cell = 0 and flagged.

**Common outcomes the agent implements in M08 (and M05 for D-18 plumbing):**
| Outcome | Agent behaviour |
|---|---|
| Option verified and approved | Implement that adapter family; run conformance kit; mark live checks `LIVE-VERIFIED` only with evidence |
| Several approved | Implement primary; define secondary as capability-gated adapter, disabled by flag |
| None verified / none approved | Feature **disabled** (`/v1/offers?kind=…` returns none; endpoints return `422 unsupported_capability`); UI shows "not available"; mock adapters remain for tests only; milestone rows BLOCKED (never PASS via mocks) |

**Common probe protocol:** (1) obtain sandbox/test credentials into non-prod vault (human); (2) run read-only `probe()` and record capability report; (3) run provisioning in sandbox only after owner enables the live-verification job; (4) capture raw evidence redacted; (5) human reviews and signs the evidence index entry.

---
## D-05 Managed PostgreSQL / MySQL
**Context:** M08 FR-DAT-01, FR-DAT-10. **Requirements:** residency per class; per-tenant instance (no shared DB users across orgs); PITR or scheduled backups with tested restore-to-new; encrypted connection secrets in vault; resize; metering `database.instance_hours`, `database.storage_gb_months`, `database.backup_gb_months`; API-driven lifecycle; cost; HA/ops.
**Options:** (A) provider-managed RDS from Alibaba or Huawei, only where verified in a Saudi region; (B) Nuzm-operated PostgreSQL/MySQL on verified Saudi ECS with automated backups; (C) hybrid, B first with A added when verified. **Proposed default (docs/07):** C — launch with B unless A verified first.
**Probes:** A: list RDS offerings/engines/versions per verified region from live account; create/delete test instance; backup/restore-to-new; metrics; tagging/lookup by idempotency token; bill line items for RDS. B: provision on verified ECS, replication/failover test, backup (full + WAL/binlog) and restore-to-new within target RTO, patching procedure, connection TLS, noisy-neighbour limits.
**Fallback/exit:** Standard engine protocol; logical dump export always available; instance migration runbook.
**Adapter mapping (docs/09 §5):** `DatabaseAdapter` families `provider-rds` and `self-operated-postgres|mysql`.
**Risks:** operational burden of B (patching, HA); provider RDS unavailable in Saudi; backup residency.
**Owner/date:** ___ / ___ **Status:** OPEN. **Agent in M08:** per common outcomes; for B, build provisioner on M05 compute with idempotent bootstrap scripts, backup scheduler, restore drill automation; for none → databases disabled.

## D-06 Managed Redis
**Context:** FR-DAT-02. **Requirements:** TLS + ACL per tenant, memory limits, persistence option, eviction policy declared, failover info, metering `cache.instance_hours`.
**Options:** (A) provider Redis service where verified; (B) Nuzm-operated Redis (primary+replica) on verified ECS; (C) hybrid. **Proposed default:** same as D-05.
**Probes:** A: engine versions, TLS/ACL support, HA topology, region list, metrics, billing items. B: failover test, memory-limit enforcement, ACL isolation test between two tenants, persistence/restore test.
**Exit:** RDB export / standard protocol. **Adapter:** `CacheAdapter` (`provider-redis`, `self-operated-redis`). **Risks:** shared-instance multi-tenancy temptation (**forbidden**: one instance or one verified isolation unit per org). **Status:** OPEN. **Agent in M08:** as above; none → `engine=redis` rejected with `unsupported_capability`.

## D-07 Object storage
**Context:** FR-DAT-03. **Requirements:** S3-compatible API (needed for SDK/tooling) **verified**, per-bucket access policies, scoped credentials per org, signed URLs, lifecycle, versioning optional, in-region placement, usage metering `storage.object_gb_months`, `storage.requests_k`, `storage.egress_gb`.
**Options:** (A) provider object storage (Alibaba OSS / Huawei OBS) via S3-compatible adapter only if compatibility and Saudi region verified; (B) self-hosted S3-compatible (Ceph RGW, SeaweedFS, Garage; MinIO only after licence review) on verified ECS; (C) hybrid. **Default:** A if verified else B.
**Probes:** S3 operation matrix actually supported (PutObject/multipart/presign/lifecycle/policy/ACL/versioning/CORS), signature version, per-credential scoping test (credential from org X cannot list/read org Y), egress and request metrics availability, region list, bill lines, delete/erasure semantic (supports DSR erasure), durability/replication description from contract.
**Exit:** S3 API copy tooling; documented bulk export. **Adapter:** `ObjectStorageAdapter` (`provider-s3`, `self-operated-s3`). **Risks:** partial S3 compatibility; licence of self-hosted software; egress cost. **Status:** OPEN. **Agent:** none verified → buckets disabled (builder/DB backups fall back to documented alternative storage decision raised to owner).

## D-08 Transactional email
**Context:** FR-DAT-06..09. **Requirements:** domain verification (SPF/DKIM/DMARC), idempotent send, webhooks for delivery/bounce/complaint with signature, suppression management, per-org sender isolation, rate limits/warm-up, data terms (message retention, sub-processors, location) evaluated by `ResidencyPolicyService` (class `personal`/`customer-content`), metering `email.transactional_messages`.
**Options:** (A) managed API provider behind adapter — shortlist **Amazon SES, Postmark, Mailgun** (others allowed by owner); (B) self-hosted MTA — **rejected for v1** (reputation/ops) unless owner reopens; (C) multi-provider failover later.
**Probes (per shortlisted vendor):** sandbox send with idempotency key behaviour; webhook signature + replay; bounce/complaint event schema; suppression API; dedicated vs shared IP options and terms; message/content retention and log retention terms (contract); data-processing locations and sub-processor list; limits; pricing model for metering mapping; sender-domain isolation (per-org identity) feasibility.
**Exit:** Domain DKIM keys under Nuzm control to switch vendor; templates stored in Nuzm. **Adapter:** `TransactionalEmailAdapter`. **Risks:** cross-border processing of personal data (transfer assessment required, D-16/HG-04-01); deliverability. **Status:** OPEN. **Agent:** build adapter + mock + webhook handler; none approved → `/v1/email/messages` disabled; platform system emails (M01) use the dev mail catcher only in non-prod and are BLOCKED in prod until chosen.

## D-09 Business email (mailboxes)
**Context:** FR-DAT-04..05. **Requirements:** mailbox/alias lifecycle by API or reseller console automation, quota and storage metering (`email.mailbox_months`, `email.mailbox_storage_gb_months`), DNS requirements declarative (MX/SPF/DKIM/DMARC) for M07, deletion/erasure support, tenant isolation, data terms/location.
**Options:** (A) resell via existing registrar partners' email products (ResellerClub/Openprovider — **availability and API to be verified**); (B) Google Workspace / Microsoft 365 reseller programs (eligibility to be verified); (C) self-hosted mail — **rejected for v1**. **Default (docs/07):** A, fallback B.
**Probes:** product catalogue via registrar sandbox; provisioning API method list (as documented), idempotency/lookup by name, suspension/deletion semantics, usage reporting, data location per contract, migration/export options, white-label constraints.
**Exit:** IMAP/MX-based migration; DNS control stays with Nuzm (M07). **Adapter:** `MailboxAdapter`. **Risks:** limited API for reseller email; support burden; data location. **Status:** OPEN. **Agent:** none verified → mailbox feature disabled; sender-domain features (D-08) independent.

## D-10 Payment service provider(s) (shorter)
**Context:** FR-PAY-01..10; HG-03-02. **Requirements:** mada + cards + Apple Pay (others optional), tokenization (no PAN in Nuzm), 3-D Secure, refunds, webhooks with signature, settlement reports for reconciliation, sandbox, KSA merchant eligibility, SAR settlement, data location terms.
**Options (all unverified):** Moyasar, HyperPay, Tap, PayTabs, Checkout.com, Stripe (availability to be verified). **Probes:** merchant onboarding eligibility (human), sandbox flows, webhook replay/idempotency, settlement file/API, refund partials, recurring/token-on-file support, fees structure. **Adapter:** `PspAdapter`. **Exit:** token migration support or customer re-collection plan. **Status:** OPEN. **Agent in M03:** build against abstraction + mock; real PSP sandbox only after HG-03-02; production BLOCKED.

## D-18 Model providers and inference residency (shorter)
**Context:** FR-AIC-01. **Requirements:** per-request residency/processor evaluation, contractual no-training/retention terms (human verified), Arabic quality evidence, token metering (`ai.tokens_input`, `ai.tokens_output`), streaming, tool use, rate limits, cost.
**Options:** (A) external model APIs; (B) in-Kingdom hosted open-weight models on verified compute (GPU availability to be verified); (C) mix with policy routing by data class. **Probes:** data terms review, region of processing declaration, latency, Arabic evaluation set (defined in M09), token counting parity, error/timeout behaviour. **Adapter:** `ModelAdapter` (docs/09 §7). **Status:** OPEN. **Agent in M09:** gateway with ≥1 mock + any approved vendor; classes with no residency-compliant model are blocked from AI features (not silently routed).

## Decision log
| ID | Option chosen | Evidence index refs | Approver | Date | ADR |
|---|---|---|---|---|---|
| D-05 | OPEN | | | | |
| D-06 | OPEN | | | | |
| D-07 | OPEN | | | | |
| D-08 | OPEN | | | | |
| D-09 | OPEN | | | | |
| D-10 | OPEN | | | | |
| D-18 | OPEN | | | | |
