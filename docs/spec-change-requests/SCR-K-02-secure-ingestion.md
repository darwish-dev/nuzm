# SCR-K-02 — Secure project ingestion (AI Intelligence Center, slice S-K2a)

Status: **IMPLEMENTED on branch `claude/run-it-dc3d6a`, pending owner acceptance** · Date: 2026-11-21 · Governed by ADR-065 (addendum A) and SCR-K-01 (approved 2026-11-20).
This change refines SCR-K-01; it adds no customer-facing contract. Everything below is platform-admin only and sits behind the flag `knowledge.library`.

## 1. Why
SCR-K-01 approved `activation`, `reviews` and `processing-jobs` as paths and left the pipeline behind them open. Implementing them needed three more tables, a few columns, a dedicated worker scope
and a handful of read/operate endpoints so that staff can see what the worker did and why a package was refused.

## 2. Database (migration `1861__knowledge__secure_ingestion`, down note in `.down.sql`; production is forward-fix)
| Change | Detail |
|---|---|
| `knowledge.processing_logs` (new, append-only) | `job_id, version_id, level, stage, code, message (≤500), data (≤4 KB)`; never file content or a matched secret |
| `knowledge.scan_findings` (new, append-only) | `scanner, code, severity (info/warn/block), path, line, detail`; evidence is a kind and `path:line` only |
| `knowledge.resource_reviews` (new, append-only) | `decision APPROVE/REJECT, reviewer_id, reason, checklist, analysis_job_id`; one approval per reviewer per analysis |
| `resources.provenance_class` | `THIRD_PARTY` (default, two approvers) or `FIRST_PARTY` (one); immutable |
| `resource_versions` | `state_reason`, `analysis_job_id`, `license_proposal`, `ingest_summary` |
| `processing_jobs` | `lease_owner/lease_expires_at/heartbeat_at/run_after/cancel_requested/trace_id/result/created_by`; one active job per `(version, kind)`; transitions guarded; finished jobs frozen |
| State machine trigger | the only edges: `QUARANTINED→VALIDATING→ANALYZING→(INDEXING)→AWAITING_REVIEW→ACTIVE`, plus `FAILED`, `DISABLED`, `ARCHIVED`, retry `FAILED→QUARANTINED`, rejection/blocked `→QUARANTINED` |
| Activation guard | `ACTIVE` needs: licence verdict AND proposal `ALLOWED`; a SUCCEEDED EXTRACT job that is the version's `analysis_job_id`; no `block` finding of that job; no REJECT of that job; approvals from distinct people (2 third-party, 1 first-party), none of them the uploader for third-party |
| Review guard | only the current analysis of a version `AWAITING_REVIEW`; the uploader cannot review a third-party upload; an approval confirms `findingsReviewed` and `licenseReviewed` |
| Worker scope `app.worker_scope='knowledge'` | policy `worker_knowledge` (platform rows only, `org_id IS NULL`) on jobs, logs, findings, versions, resources, files, dependencies, reviews; column grants: the worker writes job/state columns, inserts logs, findings, files, dependencies, jobs; it has no grant on `license_verdict`, `activated_by`, identity columns or reviews |

Ownership manifest (`spec/db/ownership.yaml`): three tables added (tenant-less list included: they hold platform rows), every new column classified (`internal`, finding `path` is `customer-content`).

## 3. API (all `x-nuzm-realm: admin`; paths under `/v1/admin/knowledge/resources/{id}`)
| Operation | Method and path | Permission |
|---|---|---|
| `listKnowledgeProcessingJobs` (approved in SCR-K-01) | `GET /processing-jobs[?versionId]` | `read` |
| `listKnowledgeProcessingLogs` (new) | `GET /processing-jobs/{jobId}/logs` | `read` |
| `cancelKnowledgeProcessingJob` (new) | `POST /processing-jobs/{jobId}/cancellation` | `manage` |
| `listKnowledgeFindings` (new) | `GET /versions/{versionId}/findings` | `read` |
| `listKnowledgeFiles` (new) | `GET /versions/{versionId}/files` | `read` |
| `getKnowledgeReviewState` (new) | `GET /versions/{versionId}/review` | `read` |
| `reprocessKnowledgeVersion` (new) | `POST /versions/{versionId}/reprocessing` | `manage` |
| `reviewKnowledgeResource` (approved) | `POST /reviews` body `{versionId, decision: approve\|reject, note?, checklist?}` | `publish` |
| `activateKnowledgeResource` (approved) | `POST /activation` body `{versionId, note?}` | `publish` |

Differences from the SCR-K-01 draft: `reviews` and `activation` return the **review state** (`KnowledgeReviewState`) instead of `KnowledgeResourceDetail` (it carries what the console needs next: blockers, approvals,
what the caller may do); `KnowledgeJob` gains `versionId, versionSeq, maxAttempts, cancelRequested, createdAt`; `KnowledgeResource` and `KnowledgeMetadata` gain `provenanceClass`.
Completion of an upload (`202`) now also enqueues the `VALIDATE` job. No new error code: the database guards map to `knowledge_approval_required`, `knowledge_license_blocked`,
`knowledge_resource_ineligible`, `forbidden`, `conflict`, `validation_failed`.
Audit actions: `knowledge.version.approved|rejected|activated`, `knowledge.job.cancelled`, `knowledge.version.reprocessing_requested`. Worker transitions are recorded in `processing_logs`.

## 4. Behaviour that differs from `docs/ai-intelligence/S-K2-PLAN.md` (recorded, not silent)
| Plan | Implemented | Why |
|---|---|---|
| each job is a `platform.operations` row | own queue on `processing_jobs` (SKIP LOCKED, lease, heartbeat, cancel flag) | operations are keyed by organization; the platform library has none |
| snapshot written to a temporary prefix, promoted on success | two passes: a dry pass proves the whole package, only then is anything stored; blocked packages store nothing | no orphan objects, simpler failure model, nothing to promote or sweep |
| advisory lock per version | unique partial index: one active job per `(version, kind)` | enforced by the database, no lock lifetime to manage |
| stages `ANALYZE`, `INDEX` in this slice | the chain ends at `AWAITING_REVIEW` after `EXTRACT`; `DETECT/ANALYZE/…` jobs arrive with S-K2b/c | scope: S-K2a is ingestion and review |
| dependency deny-list from `appbuilder/internal/policy` | an injected `denied(ecosystem, name)` predicate (empty by default) | the policy lives in the API module and cannot be imported into the domain library; the wiring is S-K2b work |

## 5. Not in this change
Framework detection, manifests, components (S-K2b/c); malware engine (D-44); counsel review (D-43); a production object store (D-42): production uploads stay off; GitHub import (HG-AS-01);
customer-facing endpoints; settings table (limits are constants that can only be lowered).

## 6. Rollback
Flag `knowledge.library` off hides every route; `KNOWLEDGE_INGEST_ENABLED=false` (default) stops the worker from claiming. Dev/staging: `1861__…down.sql`. Production: forward-fix only (evidence tables are not dropped).
