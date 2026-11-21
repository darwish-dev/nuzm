# AI Intelligence Center — slice S-K2a report (secure project ingestion)

Date: 2026-11-21 · Branch `claude/run-it-dc3d6a` (S-K1 commit `b30b2c2` preserved; nothing merged or pushed) · Status: **IMPLEMENTED and VERIFIED for its defined scope; production uploads stay OFF (D-42)**.
Governing documents: ADR-065 (addendum A), SCR-K-01 (approved), SCR-K-02 (`docs/spec-change-requests/SCR-K-02-secure-ingestion.md`), plan `docs/ai-intelligence/S-K2-PLAN.md`.

## A. Repository findings and assumptions
- S-K1 left a completed upload in `QUARANTINED` with no processing. S-K2a adds the asynchronous pipeline and the review gate; framework detection and project intelligence (S-K2b/c) are NOT started.
- Decisions applied: D-42 (design + implementation of the adapter, production still blocked), D-43 (licence is only PROPOSED by the scanner; a person decides), D-44 (a "pattern scan", never a malware claim),
  D-41 (no sandbox is needed because nothing is ever executed).
- Deviations from the plan, all recorded in SCR-K-02 §4: own queue on `processing_jobs` instead of `platform.operations` (organization-keyed); a dry pass before any byte is stored instead of a temporary prefix;
  a unique active-job index instead of an advisory lock; the dependency deny-list is an injected predicate (the existing policy lives in the API module).
- Environment: another workspace owns Postgres on :54329, so this worktree ran its own cluster on :54339 (`NUZM_PGPORT`, `NUZM_TEST_ADMIN_URL`, `E2E_PG_PORT`). Nothing of that workspace was touched.
- Assumption: a customer-side import (org-owned rows) is out of scope; the worker scope is limited to `org_id IS NULL` and proved to ignore customer jobs.

## B. Plan and changed files
- `packages/domain/src/knowledge/**`: `archive/` (ZIP and tar.gz readers, path rules, content classifier, limits, test builders), `scan/` (secrets, licence, dependencies, risky files), `ingest.ts` (orchestrator).
- `packages/adapters/knowledge-store/**` (new package): port, filesystem adapter, S3-compatible adapter (own SigV4), `resolveKnowledgeStore`, signature-verifying fake S3.
- `packages/db/migrations/knowledge/1861__knowledge__secure_ingestion(.down).sql`; `spec/db/ownership.yaml`; `packages/platform/src/db.ts` (`withKnowledgeWorker`).
- `apps/worker/src/knowledge/ingest-service.ts` (+ `main.ts`, env-gated); `apps/api/src/modules/knowledge/{internal/review.service.ts, admin-knowledge-processing.controller.ts, internal/object-store.ts, upload.service.ts, resource.service.ts, knowledge.module.ts}`.
- `spec/openapi/openapi.yaml` (+9 operations, 13 schemas), `planned-paths.yaml` (3 paths moved to implemented), `packages/sdk/src/schema.ts` (regenerated).
- Admin console: `components/KnowledgeIngestion.tsx` (+ spec), `lib/knowledge.ts`, `KnowledgeResource.tsx`; 104 message keys (ar/en); CSS block.
- Tests: domain (archive, scan, ingest), adapter, `packages/db/src/knowledge-ingestion.int.spec.ts`, worker int spec, API `review.int.spec.ts`, admin spec, E2E `15-ai-ingestion.spec.ts` (+ approver users in global setup, `E2E_PG_PORT`).
- Docs: this report, SCR-K-02, ADR-065 addendum A, `.env.example`.

## C. Implemented
1. **State machine** (database-enforced): `QUARANTINED → VALIDATING → ANALYZING → AWAITING_REVIEW → ACTIVE`, `FAILED`, `DISABLED`, `ARCHIVED`; no jump to `ACTIVE`. A blocked analysis returns the version to `QUARANTINED` with a reason; a rejected package is `FAILED` with a stable code.
2. **Safe extraction** (pure functions, hard limits, no `child_process`, never touches disk): ZIP (ZIP64, central directory, local-header agreement, overlap detection, CRC and size checked while streaming) and tar.gz (pax and GNU long names, checksum, binary sizes refused). Limits: 50 000 entries, 2 GiB total, 256 MiB per file, ratio 100 per entry and 50 overall, depth 32, path 400 bytes, 10 minutes, cancellation between entries and chunks.
3. **Attack classes refused**: `..`, absolute and drive paths, backslashes, control and bidi-override characters, reserved names, case/Unicode collisions, file-vs-directory clashes, symlinks, hard links, devices/pipes/sockets, reparse points, encrypted entries, exotic compression, lying sizes (both ways), bad CRC, overlapping/quine entries, ZIP64 inconsistencies, decompression bombs (declared and streamed), too many entries, truncated and corrupt archives, junk after the archive.
4. **Scans**: secrets (kind and `path:line` only; high-confidence formats block; placeholders and `vault://` references ignored), licence (fingerprints + manifests + SPDX headers → ALLOWED/RESTRICTED/UNKNOWN/BLOCKED proposal; conflicts reported, stricter verdict wins), dependencies (npm, pub, pip, composer, go, gem; git/URL/path sources, lifecycle scripts, network-fetching install scripts blocked, deny-list hook), risky files (executables by content, nested archives, dynamic code, obfuscation, CI network calls). Credential files and files with secrets are inventoried and never stored.
5. **Isolated asynchronous worker**: separate process, role `nuzm_worker`, scope `knowledge` (platform rows only, column grants), lease + heartbeat + cancel flag, SKIP LOCKED claim, retry with back-off, dead letter, per-job logs. Two passes: the whole package is proved first (nothing stored), only then written; a quarantined package stores nothing. Disabled unless `KNOWLEDGE_INGEST_ENABLED=true` and a store resolves.
6. **Logs and admin review**: jobs, logs, findings, file inventory, review state (blockers, approvals, what the caller may do), cancel, retry of interrupted versions; Arabic/English UI with loading, empty, error and forbidden states.
7. **Two-person approval**: third-party (default) needs two different approvers, neither the uploader; first-party needs one; confirmations required; a rejection voids the analysis; a new analysis voids earlier approvals; the database re-checks everything at activation (ALLOWED licence verdict and proposal, completed analysis, no blocking finding).
8. **Tenant isolation**: customers read none of the new tables; the worker ignores customer rows; a customer-owned job is never claimed.
9. **No execution**: nothing from a package is executed, imported, installed or built; proved with a planted lifecycle script and a marker file (never created).
10. **Object store (D-42)**: S3-compatible adapter — private bucket (no ACL ever set), SSE-S3/KMS required and verified on every write (the object is deleted if the provider ignores it), SigV4 header and presigned-URL signing validated against AWS test vectors, TLS enforced (loopback excepted), multipart compose with checksum verification before publication, `selfTest()` against a real provider, configurable endpoint/region/bucket/path style. Production resolves a store only with a complete configuration, vault-resolved credentials, https and a human attestation (`KNOWLEDGE_S3_ATTESTATION=HG-…`); otherwise uploads and the worker refuse. **Production uploads remain disabled.**

## D. Migrations and rollback
`1861__knowledge__secure_ingestion.sql`: three append-only evidence tables, new columns, guards, worker policies and column grants (see SCR-K-02 §2). Down note in the `.down.sql` (dev/staging only; production is forward-fix, evidence is never dropped). Rollback of behaviour: flag `knowledge.library` off, `KNOWLEDGE_INGEST_ENABLED=false` (default).

## E. Tests run (this worktree, actual results)
| Command | Result |
|---|---|
| `pnpm lint` (eslint + prettier) | PASS |
| `pnpm typecheck` | PASS, 52/52 tasks |
| `pnpm turbo run test --filter='!@nuzm/e2e'` | PASS, 52/52 tasks (domain 698 tests incl. 90 knowledge: 67 archive, 16 scanner, 7 ingest; adapter 26; admin 317 incl. 15 new; web 809) |
| `pnpm build` | PASS, 28/28 |
| `pnpm spec:lint`, `spec:drift` (478 routes), `sdk:check` | PASS |
| `pnpm compliance:claims-guard`, `classification-coverage` (3336 columns), `ropa-coverage`, `residency-hooks`, `db:test-rls` | PASS |
| Integration (own cluster): db 93, platform 32, worker 45, api 1960 passed / 2 failed | the 2 failures: `domains-search` registrar probe matrix (pre-existing, caused by another session's `dnet` registrar; unrelated) and one new test that failed once while its source file was being edited mid-run and passed on rerun (19/19 review tests) |
| E2E `15-ai-ingestion.spec.ts`, Arabic + English, real browsers, real worker process | PASS 6/6 (axe WCAG A/AA, 8 screenshots in `docs/reports/screenshots/{ar,en}/ai-ingestion-*.png`) |
| `pnpm scan:secrets` | one hit, `apps/api/src/modules/domains/internal/registrar-dnet-settings.spec.ts:9`, in another session's file (untouched); mine are clean (test literals are built from parts) |
Hostile corpus: 14 end-to-end hostile/unsafe packages through the real worker (each FAILED with its stable code, nothing stored), plus property and fuzz tests (random edits/truncations: only clean rejections, never a crash; random bytes never accepted; accepted names never escape or collide).
Not run: `pnpm verify:full` as a whole (the full browser E2E of other milestones was not re-run; only the files this slice touches: 14 was not re-run after the shared-config change, 15 was).

## F. Security, tenant isolation, billing, residency
- Security: see C3–C9; findings and logs never carry file content or a matched secret (checked byte for byte in E2E and worker tests). The worker cannot set a licence verdict, write a review, activate, or touch a customer row (tested with the real role).
- Tenant isolation: DB tests prove a customer org sees none of jobs, logs, findings, reviews; the claim scope opens nothing; worker ignores org-owned jobs.
- Billing/metering: none (no billable action). Residency: `data_region` unchanged; no vendor call is made.
- Audit: `knowledge.version.approved|rejected|activated`, `knowledge.job.cancelled`, `knowledge.version.reprocessing_requested` (API); worker transitions in `processing_logs`. Known gap: the worker does not write `audit.audit_logs` rows (hash chain); recorded as an open item.

## G. Human gates and live checks still needed
- **D-42 (BLOCKING production)**: choose provider/region/retention; run `selfTest()` against the real bucket; provide vault-resolved credentials (a vault resolver for the worker and API does not exist yet); record the `HG-…` attestation. The S3 adapter is verified only against a signature-verifying fake (NOT VERIFIED against a real provider).
- D-43 counsel review before any commercial third-party theme is activated; D-44 (no malware claim); D-21 (running anything) remains out of scope.

## H. Acceptance checklist
| # | Requirement | Status |
|---|---|---|
| 1 | Secure ingestion state machine | PASS (DB tests, worker tests) |
| 2 | Safe ZIP and tar.gz extraction | PASS (unit, property, end to end) |
| 3 | Traversal, symlink, bomb, malicious-file protection | PASS (see C3) |
| 4 | Secret, dependency, licence scanning | PASS (pattern scan; licence is a proposal) |
| 5 | Isolated asynchronous workers | PASS (separate process, own role/scope, E2E with the real process); a per-job OS sandbox was not added because nothing is executed |
| 6 | Complete logs and admin review | PASS (API, UI, E2E ar/en) |
| 7 | Two-person approval | PASS (DB guards, API, UI E2E with three real staff accounts) |
| 8 | Strict tenant isolation | PASS |
| 9 | Hostile-input and integration tests | PASS |
| 10 | No execution of uploaded code | PASS (marker test) |
| D-42 | Production S3 adapter | adapter and production guards: PASS against a fake; real provider: NOT VERIFIED; production uploads: BLOCKED (D-42) |

## I. Handoff and open decisions
- **S-K2b (framework detection and manifest)** — depends on S-K2a (snapshots, `resource_files`, `resource_dependencies`, `analysis_job_id`) and adds job kinds `DETECT`/`ANALYZE` before `AWAITING_REVIEW`. Acceptance: a versioned detector registry; golden manifests for the three sample projects (Next.js theme, Flutter, Next.js+NestJS); no capability without evidence; negative fixtures (a README that merely mentions Next.js); monorepo roots. Open: wire the platform dependency deny-list (needs an extracted shared module).
- **S-K2c (structure and components)** — depends on S-K2b and D-45 (Dart parser). Acceptance: TypeScript/JavaScript AST in parse-only mode with per-file budgets, Dart parse-only, component and import-relationship rows for the samples, analysis incremental by content hash.
- Open items from this slice: D-42 steps above; worker writes to the audit chain; re-analysis of an already analysed version (blocked by append-only `resource_files`; an upload of a new version is the path); optional OS-level isolation of the extraction (thread/process limits) if the threat model later requires it.
