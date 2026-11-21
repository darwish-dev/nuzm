# ADR-065: AI Intelligence Center — a `knowledge` module for admin-curated projects, themes, components and documentation

- Status: **Accepted by the owner in the session of 2026-11-20, as drafted** (reply "Approve as drafted" to the agent's request to approve ADR-065 and
  SCR-K-01 so that slice S-K1 can start). The agent recorded the decision; the owner made it. Acceptance covers the design in this ADR and the
  contracts in `docs/spec-change-requests/SCR-K-01-ai-intelligence-center.md`; it does **not** lift any gate listed under "Depends on" (D-18, D-21,
  HG-09-01, HG-AS-01, PA-M10-01), and it does not accept a model-tool-use contract (D-46: separate SCR).
- Related decisions: D-41 … D-49 (new, OPEN in `docs/07`); depends on open D-18, D-21, HG-09-01, HG-AS-01, PA-M10-01
- Evidence: `docs/ai-intelligence/AUDIT_AND_PLAN.md` (audit 2026-11-20)
- Related ADRs: ADR-004 (schema per module + RLS), ADR-007 (durable operations), ADR-012 (residency), ADR-013 (metering), ADR-015 (sandbox, OPEN),
  ADR-052 (object storage provider), ADR-061 (model gateway), ADR-064 (AI Studio: GitHub, Skills, instructions)

## Context

The AI Builder generates web apps from an **app spec** through a deterministic scaffold (`appbuilder/internal/gen`) and Flutter apps from built-in
templates. It cannot start from an administrator-approved existing project or theme, cannot learn a theme's design language, and has no retrieval over
reusable components or documentation. The owner asks for a staff-managed library ("AI Intelligence Center") of source projects, themes, component
libraries, design systems and documentation that the builder uses to produce better, editable customer projects.

Constraints already decided or open, and which this ADR must respect (see the audit §1–2):
- Uploaded source is untrusted. There is no isolated sandbox runtime (D-21 open): nothing uploaded may be installed, built, run or previewed.
- No real model provider contract or data terms (HG-09-01, D-18): no live generation, no embeddings sent to a vendor.
- Durable work is `platform.operations` + outbox (ADR-007); there is no BullMQ/Redis queue.
- Contracts are OpenAPI-first; tables live in one module's schema and are listed in `spec/db/ownership.yaml` with a data class per column.
- Customer-imported repositories (ADR-064) are tenant data and must never reach a global library.

## Decision (proposed)

1. **A new modular-monolith module `knowledge`** (`apps/api/src/modules/knowledge`, pure libraries in `packages/domain/src/knowledge`, worker consumers
   in `apps/worker/src/knowledge-consumers.ts`, admin UI under `apps/admin/.../ai-knowledge`). It owns the Postgres schema `knowledge`. No new service,
   no graph database, no vector database.

2. **Data model** (20 tables, all in `spec/db/ownership.yaml`, forced RLS, UUIDv7, `snake_case`, UTC): `resources`, `resource_versions`, `resource_files`,
   `resource_permissions`, `resource_manifests`, `resource_components`, `resource_dependencies`, `resource_relationships`, `resource_search_documents`,
   `processing_jobs`, `analysis_results`, `quality_scores`, `usage_events`, `theme_tokens`, `theme_variants`, `template_defaults`, `uploads`,
   `generation_plans`, `generation_resource_links`, `generation_evaluations`. Versions are immutable once past `VALIDATING`; a state change is a new
   row or an append-only transition record, never an overwrite of source bytes. Checksums (SHA-256) and provenance (source kind, commit, uploader,
   time) are stored on every version. Soft delete (`deleted_at`) plus a retention field; hard deletion only through the data-retention job.

3. **Visibility and tenancy.** A resource row has `org_id NULL` (platform library, staff-owned) or `org_id = <tenant>` (a customer's private template
   or import). RLS:
   - staff (platform realm) read and write platform rows through `admin:ai_knowledge:*` permissions;
   - a customer session reads tenant rows of its own org only, and platform rows **only through the view `knowledge.v_published_templates`**, which
     exposes metadata, compatibility facts, design summary and preview asset references — never file contents, manifests' source excerpts or object
     keys — and only for versions that are `ACTIVE`, published, licence-eligible and reuse-permitted;
   - file bytes and analysis internals are readable by the worker/orchestrator role only, and are copied into a project workspace by the
     orchestrator, never returned by an API.
   Every query path gets a cross-tenant test (CLAUDE.md §4). Customer imports and customer-authored templates are stored with their own `org_id`
   and have **no write path** into platform rows.

4. **Platform object-store port.** Original archives, extracted snapshots, preview assets and reports live in object storage, not in Postgres
   (`ai.artifacts` stores bytes in Postgres and is unsuitable for archives). A port `KnowledgeObjectStore` (put/get stream, multipart, head, delete,
   short-lived signed URL) with a **dev filesystem adapter** and a **provider adapter** built on the existing `ObjectStorageAdapter` once the
   ADR-052 provider and region are chosen (D-42). Content-addressed keys allow safe deduplication by checksum.

5. **Ingestion is a state machine run by workers, with no execution of uploaded code.**
   `UPLOADING → QUARANTINED → VALIDATING → ANALYZING → INDEXING → AWAITING_REVIEW → ACTIVE` (plus `FAILED`, `DISABLED`, `ARCHIVED`). Job kinds are
   `platform.operations` types `knowledge.validate|extract|detect|analyze|components|design|document|index|quality` (and later `embed`, `preview`),
   each with timeout, bounded retries, cancel, dead-letter state and progress rows in `knowledge.processing_jobs`.
   Safety rules, all enforced by pure, unit/property-tested functions: allow-listed extension/MIME; entry-count, extracted-size, ratio and depth
   limits; rejection of absolute, `..`, NUL, drive-letter and confusable paths; rejection of symlinks, hardlinks and device entries; binary and
   executable policy; secret detection with redaction (reusing `packages/domain/src/ai/secret-scan.ts`); dependency-manifest and licence inspection
   (reusing the dependency policy and marketplace scan patterns); prompt-injection fencing of README/docs (reusing `ai/untrusted.ts`).
   **No `child_process`, no package manager, no lifecycle script** in any analyzer. Malware scanning is not claimed unless an engine is chosen (D-44).
   Activation of third-party or licensed resources needs two different staff approvers (same rule as D-40); unknown licence ⇒ not activatable (D-43).

6. **Analysis is deterministic first.** A versioned, extensible **framework registry** of pure detectors (Next.js, React, Vue, Angular, Flutter, NestJS,
   Express, Django, Laravel, …; a resource may match several). TypeScript/JavaScript use the TypeScript compiler API; Dart uses a bundled parser that
   never runs the Dart/Flutter SDK (D-45). Output: a **Project Intelligence Manifest** (schema-versioned JSON) where every capability carries
   `evidence` (file/line references) and `confidence`; capabilities without evidence are not written. Theme analysis emits **Design DNA** and design
   tokens from static CSS/Tailwind/theme files. Results are cached by content hash (`analysis_results.content_hash`); unchanged files are not
   re-analysed. A model may add semantic summaries only when the resource permission, `ResidencyPolicyService`, data terms and budget all allow it.

7. **Retrieval is hybrid and permission-first.** Hard eligibility filters (visibility, licence, reuse/AI permissions, platform and framework
   compatibility, availability) run in SQL **before** ranking. Layers: structured metadata; lexical (`tsvector` + trigram, no extra service); symbol and
   dependency-graph search over `resource_components` / `resource_relationships`; design search over `theme_tokens` / Design DNA. A semantic layer
   (embeddings) is added only if the managed Postgres exposes `vector` (capability probe, "unknown = unsupported") **and** D-47 selects a permitted
   embedding model; until then it is `BLOCKED`, and the others work without it. Results return resource id, pinned version, relevance,
   compatibility and quality scores, licence eligibility, permissions, matching components, evidence and a recommended usage strategy.

8. **Recommendation** is a configurable weighted model after the hard filters. Initial configuration (not proven optimal, D-48): functional
   relevance 25%, framework compatibility 20%, architecture compatibility 20%, design relevance 15%, quality 10%, reuse efficiency 10%. Weights live
   in `knowledge` settings with an audit trail; outcomes (`usage_events`, `generation_evaluations`) feed evaluation, never silent auto-tuning of a
   customer-visible default. Strategies: `AUTO_SELECT`, `USER_SELECTED`, `ADMIN_DEFAULT`, `GENERATE_FROM_SCRATCH`. A user's explicit theme choice is
   honoured unless unavailable, unauthorised or incompatible, and the incompatibility is explained, never silently substituted. Admin defaults
   (`template_defaults`) are preferences that still pass compatibility and permission checks.

9. **Generation integration reuses the existing run engine.** New: a requirement-analysis and planning step (structured output) stored as
   `knowledge.generation_plans`; a **workspace initialiser** that copies an immutable resource version into the customer's `builder.project_files`
   (the source version is never modified); context assembly with a token budget (manifest, Design DNA, relevant paths and snippets, component
   contracts, constraints, instruction layers from ADR-064), fetching more files on demand. Changes go through the existing changes/approvals
   pipeline and internal Git so follow-up prompts operate on the current project state. Execution is **not** a new endpoint: it is `POST /v1/ai/runs`
   with a new run kind and a `planId`, so budgets, credits, metering, audit and cancellation stay in one place.
   An agentic coding loop (read/search/edit/create files, run approved commands, view build errors) needs a **tool-use extension of the
   `ModelAdapter` contract** (today: chat, structured output, long context, embeddings, vision), specified separately (D-46). The Claude Code binary and
   customer subscriptions are not used by this engine (D-38 stands). Build/test/visual validation steps are wired but run only on an `isolated`
   runtime that has passed the escape suite (D-21); before that they report `BLOCKED`, never a pass.

10. **Quality and analytics are evidence-based.** `quality_scores` rows reference the evidence that produced them (analysis result, test run,
    build log, scan result); a dimension with no evidence is shown as "not measured". Analytics read real counts (resources, jobs, usage, cost via
    metering). Nothing is trained or fine-tuned on customer source; any future training workflow needs a new ADR and explicit controls.

11. **Operational rules.** Feature flags, all default OFF: `knowledge.library` (admin console, ingestion), `knowledge.customer_templates`
    (gallery, from-template), `knowledge.import_projects` (customer import), `knowledge.semantic_search` (stays off until D-47). Metering event for every
    billable AI step; audit event for every mutation; `data_region` on every resource, `ResidencyPolicyService` before any vendor call; per-org and
    global concurrency/storage quotas; Arabic + English UI with RTL, e2e test and screenshot per screen.

## Alternatives considered
- **Reuse `builder.skills` tables for the library** — skills are small text bundles with a different lifecycle; sharing tables would blur ownership
  and RLS. Governance (approvals, scanning) is reused, tables are not.
- **Separate microservice** — contradicts ADR-001; no scale evidence.
- **BullMQ + Redis** — contradicts ADR-007 and adds an operational dependency for no needed capability.
- **Graph database for the architecture graph** — edge tables with indexes answer the queries needed; revisit only with measured need.
- **Dedicated vector database** — premature and adds a data-residency surface; revisit after D-47 and a measured retrieval gap.
- **Store archives in `ai.artifacts` (Postgres)** — poor for large objects; no signed-URL or lifecycle support.
- **Execute uploaded projects on the API/worker host to "verify" them** — unacceptable for untrusted code; rejected until D-21.

## Consequences
- New public contracts (OpenAPI paths, tables, audit events, error codes, permissions, flags) — proposed in SCR-K-01; none exists until approved.
- A new RLS shape (platform-owned rows readable by customers only through a published-metadata view) is introduced; it needs dedicated
  isolation tests and a security review before `knowledge.customer_templates` can be turned on.
- Several acceptance rows of the request stay `BLOCKED` until D-18, D-21, D-42, D-44, D-46, D-47 and HG-AS-01 are resolved; the deterministic
  slices (S-K1 … S-K5 in the audit) are not blocked by them.
- Licence risk for third-party themes is a legal matter, not an engineering one (D-43); no commercial theme is activated before counsel review.

## Consistency check (agent, 2026-11-20)
- Does not conflict with ADR-004/007/012/013/061/064. It depends on ADR-015 (OPEN) for any execution and does not assume its outcome.
- The request's endpoint names (`/admin/ai-resources`, `/ai-builder/...`) and table names (`ai_resource_*`) are adapted to `docs/04` and ADR-004
  conventions; the mapping is in the SCR. Where the request and a higher source conflict, the higher source is followed (audit §1, C1–C9).
- ADR-064's GitHub App (D-39) is the only repository-import path; real private-repo import stays BLOCKED on HG-AS-01.

## Addendum A — S-K2a secure ingestion (2026-11-21, SCR-K-02)
Decided while implementing S-K2a; none of it changes an accepted decision, it fixes details the ADR left open.
- **Queue:** the pipeline queues on `knowledge.processing_jobs` (claimed with `FOR UPDATE SKIP LOCKED`, a lease, a heartbeat and a cancel flag) instead of `platform.operations`: operations are keyed by
  organization, the platform library has none. Retry, back-off, dead-letter and cancellation semantics are the same as ADR-007's.
- **Isolation of the worker:** a dedicated worker scope (`app.worker_scope = 'knowledge'`) opens ONLY platform rows (`org_id IS NULL`) of the knowledge schema, and column grants limit what `nuzm_worker`
  may write. It cannot set a licence verdict, write a review or activate a version. The generic `claim` scope sees nothing of this schema.
- **No execution, ever:** the worker parses bytes (pure functions with hard limits). A package is analysed twice: a dry pass proves every size, checksum, path, limit and scan WITHOUT storing a byte; only a
  package that passes and has no blocking finding is written to the snapshot. A rejected or quarantined upload leaves nothing in the object store except its original archive.
- **Activation gate in the database:** a guarded state machine, an activation guard (ALLOWED licence verdict AND proposal, completed analysis, no blocking finding, approvals from different people: two for
  third-party resources, neither the uploader; one for first-party), and a review guard. The API can only produce clearer errors than the database; it cannot bypass it.
- **Third-party is the default** (`resources.provenance_class`); FIRST_PARTY needs the publish permission and is fixed at creation.
- **Object store (D-42):** the port moves to `@nuzm/adapter-knowledge-store` with a development filesystem adapter and an S3-compatible adapter (own SigV4, encryption verified on every write, presigned
  reads, private-bucket self-test). Production uploads stay OFF until a complete configuration, vault-resolved credentials and a human attestation exist; D-42 stays the production blocker.
- **Malware (D-44):** unchanged — a pattern scan, never called a malware scan. **Licence (D-43):** the scanner only PROPOSES; a version can be activated only when the proposal is ALLOWED and people approve.

## Addendum B — S-K2b project detection (2026-11-21, SCR-K-03)
- **Static and evidence-first:** detection reads the stored snapshot as text and emits only what a concrete file proves (dependency line, config file, entry point, directory convention); prose is never evidence, confidence is derived from
  evidence weights, ambiguity is reported instead of resolved, and examples/tests are not counted as the package.
- **Stage placement:** DETECT runs after EXTRACT inside the existing worker architecture (same queue, lease, cancel, retry, dead letter, same least-privilege role and scope). A version reaches review only after the manifest exists; blocked
  and rejected packages never reach it. The stage is behind `KNOWLEDGE_DETECT_ENABLED` (default off).
- **Evidence tables stay append-only;** the worker may write a manifest only for a version in `ANALYZING` (database trigger), bounded in size, platform rows only.
- **AST and component analysis are S-K2c** (parse-only, thread-isolated); S-K2b's route and screen facts are labelled heuristic with their confidence.

## Addendum C — S-K2c component and architecture analysis (2026-11-21, SCR-K-04)
- **Parse-only:** TypeScript/JavaScript via `ts.createSourceFile` alone (no program, type checker, module resolution or plugins), traversed iteratively under a node budget; Dart via an interim lexical analyzer. Facts are path-independent and cached by content
  hash, so an unchanged file is never analysed again, in this version or the next. D-45 is DECIDED in `docs/07` (bundled tree-sitter parsers, no SDK execution; 2026-11-20); the grammar is not bundled yet (selection, licence, pin and build provenance are the open part, see `docs/ai-intelligence/D-42-D-45-status.md`), so the lexical analyzer stays as a reversible interim. (This sentence first said D-45 was undecided; that was wrong and is corrected by addendum D.)
- **Evidence tables stay append-only and bounded:** components and relationships have natural unique keys and are written by the worker only for a version in `ANALYZING`, never with `reuse_allowed = true`; the schema-2 manifest is a second row beside schema 1.
- **Stage placement:** COMPONENTS follows DETECT in the same queue and role; one transaction writes everything, so a stopped or failed stage leaves nothing. Behind `KNOWLEDGE_COMPONENTS_ENABLED` (default off).
- **Deferred:** a memory-limited parser thread (built in addendum D); the bundled Dart grammar (D-45 decided, not yet built); reuse permissions for components (a later, permission-gated decision).

## Owner / date
Owner / 2026-11-20 (session decision, recorded by the agent; drafted by the agent the same day)

## Addendum D — S-K2c parser sandbox (2026-11-21, SCR-K-05)
- **Isolation boundary:** the COMPONENTS stage no longer parses in the ingestion worker's own thread. A pool of `worker_threads` (default 2, at most 4) parses ONE file at a time. A thread receives the file's bytes and returns plain facts; it gets an **empty environment**, no database handle and no credentials; the stage hands it no network, file or database access, and its stdout/stderr are captured, never forwarded (a thread is not technically prevented from asking Node for a file or a socket, which is why this is a fault boundary and not a privilege boundary). This is a **fault and resource boundary, not a privilege boundary**: nothing from a package is executed, so the threat it answers is a parser that hangs, exhausts memory or crashes on hostile input.
- **Limits (all enforced, all configurable downwards or by env, strict by default):** wall-clock per file 10 s (the thread is `terminate()`d, which interrupts a synchronous run; Node 22 has no per-thread CPU accounting, so wall time is the proxy and is stated as such); V8 heap per thread 384 MiB old / 48 MiB young, 4 MiB stack (exceeding the heap ends the thread with `ERR_WORKER_OUT_OF_MEMORY`, never the worker); file size 512 KiB (checked before dispatch and again in the thread); AST node budget 400 000 (a caller can only lower it); result size 190 000 bytes; a thread is replaced after 300 files and after ANY failure; startup 20 s.
- **Failure handling:** a limit hit is a typed per-file outcome (`timeout`, `memory`, `crashed`, `too_large`, `oversize`, `invalid`), reported as the file's skip reason, **never guessed and never cached** (a later run may succeed); deterministic outcomes (`too_large`, `oversize` → `budget`) are cached. After 25 failures or after the stage's 10-minute parsing budget the remaining files are skipped as `deadline` and the package still reaches review with the skips visible. A sandbox that cannot start at all is an infrastructure error: the job is retried with back-off and then dead-lettered, writing nothing. Replies are structurally checked; a reply that is not the expected facts object or is not ours is refused.
- **Cancellation and shutdown:** an administrator's cancel or a lost lease aborts the in-flight parses within ~200 ms (threads terminated), the stage writes nothing (one transaction, as before). A sandbox the stage created is always closed (success, failure or cancel); an injected one is not.
- **Unchanged:** facts, components, relationships, manifests, tables, endpoints, permissions and the UI contract. The skip reasons `timeout`, `memory`, `crashed`, `deadline` appear in the existing architecture panel (Arabic/English).
- **Next:** the bundled tree-sitter Dart grammar of D-45 will run INSIDE this sandbox (WASM, loaded from the repository, no download at run time) once its selection, licence and pin are confirmed; see `docs/ai-intelligence/D-42-D-45-status.md`.
- **Correction:** addendum C first said D-45 was undecided. `docs/07` records it as DECIDED on 2026-11-20 (bundled tree-sitter, no SDK execution); what is open is the concrete grammar (see the status note).

## Addendum E — S-K4 Design DNA and theme intelligence (2026-11-21, SCR-K-06)
- **Static, in the sandbox:** stylesheets (CSS, SCSS, Less), design-token JSON, JavaScript/TypeScript theme configuration and Flutter theme code are read as text or syntax trees inside the parser sandbox of addendum D (four new file kinds, same limits, replies validated against the kind asked). A configuration file is never required or evaluated: a value that code would compute is recorded as **dynamic** with its location and no value. Nothing is rendered; screenshots stay blocked on D-21.
- **Evidence and honesty:** every token, role and trait carries the file and line (or token path) that proves it; roles are inferred from names and from how properties use them, with a confidence; contrast is the WCAG formula over resolved opaque colours; references are resolved only inside the same project and anything unresolved is reported.
- **Storage:** `theme_tokens` gains mode, line, origin, dynamic and resolved value (expand-only, migration 1864); tokens and variants are append-only for the worker (INSERT only, platform rows, only for a version in `ANALYZING`, natural keys). The Design DNA document is an append-only analysis result; the schema-3 manifest adds a compact design summary to schema 2. Per-file facts are cached by content hash across versions of the same resource and are not cached when a parser limit was hit.
- **Stage placement:** DESIGN follows COMPONENTS in the same queue and role, behind `KNOWLEDGE_DESIGN_ENABLED` (default off, needs components); one transaction writes everything. Quarantined and rejected packages never reach it.
- **Not decided here:** the bundled tree-sitter Dart grammar (D-45 approach decided; the dependency awaits the owner's go-ahead), reuse permissions for design values (D-43), and production activation (D-42).

## Addendum F — S-K5 retrieval and recommendation (2026-11-21, SCR-K-07)
- **Permission-first, no model:** every platform resource goes through hard filters (publication, licence, reuse permission, platform and framework compatibility, adaptation mode, AI-processing permission, version pin) BEFORE any text is matched or any score computed; only eligible versions are ranked and the excluded ones are listed with every reason. Retrieval is metadata, lexical (`tsvector` with bilingual Arabic/English concept groups), component and symbol names and the Design DNA; the semantic layer stays BLOCKED (D-47).
- **Model (D-48):** functional 25, framework 20, architecture 20, design 15, quality 10, reuse efficiency 10 as editable configuration with optimistic revisions, a mandatory reason, an append-only history and audit events (publish permission). Weights are renormalised over the dimensions the requirement exercises and that have evidence; the exercised share is reported as confidence; unmeasured quality is "not measured". A relevance gate gives 0 to a resource that meets none of what was asked, so structure, quality and permissions can never select a resource on their own.
- **Strategies:** a user's choice is honoured or explained and never substituted; an admin default is a preference that still passes every filter and its pin; below the minimum score the answer is "generate from scratch".
- **Indexing:** the INDEX stage runs last, writes bounded search documents from proved facts and already-scanned documentation in one transaction (insert-only for the worker, `ANALYZING` guard); quarantined and rejected packages never reach it.
- **Not decided here:** customer endpoints (S-K7), embeddings (D-47), generation (S-K6), production activation (D-42).

## Addendum G — S-K7 customer gallery and start from a template (2026-11-22, SCR-K-08)
- **One narrow door:** customers read platform resources only through `v_published_templates` (D-41), which now carries a database-built, safe design summary, capability names and counts; files are readable only through `v_template_copy_files`, which is empty unless the transaction names one eligible version. No file content, path, key, evidence location or excluded resource ever reaches a customer; an ineligible resource is a 404 identical to a missing one, including as a user's choice in a recommendation.
- **Copy, not link:** "start from a template" copies the pinned immutable version into a NEW web-app project through the existing safe-change pipeline (digest verification, path, secret and canary checks, size limits, dependency policy, one Git commit). Eligibility for the adaptation mode is re-checked at copy time; a template that changed after it was shown is refused, never copied under the old pin; nothing is created before everything is validated. The template and other copies are never modified.
- **Records:** usage events, the version-to-project link and the audit event are the customer's own tenant rows (forced RLS, usage append-only). These are the data D-48's evaluation will read; no weight is tuned automatically.
- **Plans, not runs:** a generation plan records the requirement and the deterministic selection and says execution is blocked until S-K6 (model and run engine). No model is called and nothing is executed in this slice.
- **Flag:** `knowledge.customer_templates`, per organization, default off, 404 while off; copying additionally needs `app_builder.enabled`.
- **Not decided here:** customer import and chat on the current state (S-K6, and D-42 for any upload path), the semantic layer (D-47), previews (D-21), production activation (D-42).

