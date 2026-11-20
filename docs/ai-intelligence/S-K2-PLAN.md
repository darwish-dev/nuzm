# S-K2 implementation plan — secure ingestion, archive extraction, framework detection and project intelligence

Date: 2026-11-20 · Status: **PLAN, not started.** Depends on S-K1 (accepted on its evidence, see `docs/reports/K-S1-report.md`), ADR-065 and SCR-K-01.
Rule for the whole slice: **nothing from an uploaded package is ever executed, installed, built or imported.** Archives are parsed as bytes by pure functions with hard limits;
analysis reads text. Anything that would need a runtime (build, preview, tests) stays BLOCKED on D-21.

## 1. Goal and non-goals
Goal: a package that S-K1 left in `QUARANTINED` is validated, safely unpacked into an immutable snapshot, scanned (secrets, licence, dependencies, risky files), analysed
(frameworks, structure, dependencies, routes, modules, components) and presented to staff for review and activation, with every step observable and failures actionable.

Not in S-K2: model calls or embeddings (D-18, D-47), GitHub import (HG-AS-01), theme Design DNA and Flutter widget analysis beyond what framework detection needs (S-K4),
retrieval/recommendation (S-K5), customer endpoints (S-K7), running anything (D-21), malware scanning claims (D-44).

## 2. Delivery in three sub-slices (each ends with a report in the CLAUDE.md §10 format)
| Sub-slice | Content | Exit criteria |
|---|---|---|
| **S-K2a Ingestion** | State machine and workers; safe extraction; file inventory and snapshot; secret, licence, dependency-manifest and risky-file scans; processing-job monitor; review and activation with two approvers | A crafted hostile corpus is rejected with a clear reason, a clean package reaches `AWAITING_REVIEW`, a second approver activates it, nothing outside limits is ever written |
| **S-K2b Detection and manifest** | Framework registry and detectors; Project Intelligence Manifest with evidence and confidence; dependency graph rows; module/route inventory | Golden manifests for the three sample projects; no capability without evidence |
| **S-K2c Structure and components** | TypeScript/JavaScript AST analysis (parse only); Dart via the bundled parser (D-45); component discovery and registry rows; relationship rows | Components and imports of the samples found; analysis is incremental by content hash |

## 3. State machine and workers (S-K2a)
- States as in ADR-065: `QUARANTINED → VALIDATING → ANALYZING → INDEXING → AWAITING_REVIEW → ACTIVE` plus `FAILED`, `DISABLED`, `ARCHIVED`. A transition is one guarded UPDATE
  (state and expected previous state in the WHERE clause) plus a `processing_jobs` row; a stale worker cannot move a version backwards.
- Job kinds (existing CHECK list): `VALIDATE`, `EXTRACT`, `DETECT`, `ANALYZE`, `COMPONENTS`, `INDEX`, `QUALITY` (S-K2 uses the first six; `QUALITY` records only static evidence).
  Each job is a `platform.operations` row (ADR-007) so retries, timeouts, cancellation, backoff and dead-lettering come from the existing worker loop; `processing_jobs` carries progress,
  attempt, error code and the actionable message shown in the admin console.
- **Where handlers run — decision at kickoff (recommended):** in the worker process under the `nuzm_worker` role with a migration (`1861+`) that adds `INSERT/UPDATE` on only the
  derived tables (`resource_files`, `resource_manifests`, `resource_components`, `resource_dependencies`, `resource_relationships`, `analysis_results`, `processing_jobs`, `resource_versions` state/licence columns)
  and a policy keyed on `app.worker_scope = 'knowledge'`. The API keeps no write access to derived tables. If the existing operation handlers are only registered inside the API process, the
  fallback is the AI Studio pattern (handlers in the module, claimed by the worker, executed with the platform scope), with the same limits.
- Upload completion enqueues `VALIDATE`; each stage enqueues the next only after it committed (outbox), so a crash re-runs one stage, never skips one.
- Concurrency: per-version single-flight (advisory lock on the version id); global cap and per-org cap from the settings (until the settings table exists: constants, lowered only).
- Cancel (`POST …/deactivation` while a stage runs) flips a cancel flag the stage polls between files; partial output is discarded because the snapshot is written to a temporary prefix and promoted only on success.
- Expiry/sweep job: abandoned upload sessions (S-K1 expires lazily) and orphaned temporary snapshots are removed on a schedule.

## 4. Safe archive extraction (S-K2a) — the security core
A new pure library `packages/domain/src/knowledge/archive` (no I/O, no `child_process`, no third-party unzip that follows links), driven by the worker with streams:
- **Formats:** ZIP (central-directory parser, ZIP64, data descriptors) and `.tar.gz/.tgz` (gzip stream + tar parser). Other formats are refused. Encrypted entries, multi-disk archives and archives nested inside the
  package are **not expanded** (nested archives are listed as files and flagged).
- **Limits (settings, hard caps in code):** entries ≤ 50 000; total extracted ≤ 2 GiB; single file ≤ 256 MiB; compression ratio ≤ 100:1 per entry and ≤ 50:1 overall; directory depth ≤ 32; path ≤ 400 bytes, name ≤ 255; wall-clock
  and CPU-time budget per job; the sum of *declared* sizes is checked before writing and the *actual* bytes are counted while streaming (a lying header is a rejection, not a trust).
- **Path rules:** reject absolute paths, drive letters, UNC, `..` segments after normalisation, backslash separators, NUL and control characters, bidi-override characters, trailing dots/spaces, reserved device names, names that
  collide after Unicode and case folding (two entries that would become one file), and entries whose resolved path leaves the snapshot prefix. Paths are stored as given for display and as the normalised key for storage.
- **Entry types:** only regular files and directories. Symlinks, hardlinks, devices, FIFOs and sockets are rejected (the whole package, not just the entry: a link in a library is a finding worth stopping for) unless the admin policy says "skip and record".
- **Bomb and trick detection:** overlapping local headers, entries sharing data, central/local header disagreement, size/CRC mismatch, quine-style recursion, excessive tiny entries, zero-length floods.
- **Binary and executable policy:** detect by magic bytes and content, not by extension; binaries are inventoried (hash, size) but not stored in the snapshot unless they are on an allow-list of asset types (images, fonts, PDFs); executables, shared libraries, scripts with the executable bit and
  installer formats are flagged `is_executable` and excluded from the snapshot.
- **Sensitive files** (`.env*`, `*.pem`, `id_rsa*`, `.npmrc`, `.pypirc`, `*.keystore`, cloud credential files, `.git/config` with tokens): inventoried with `object_key = NULL` and a finding; never stored, never shown.
- **Output:** `resource_files` rows (path, sha256, bytes, language, flags, secret-finding count) and a content-addressed snapshot in the object store (`snapshots/<sha256 of file>`; identical files are stored once). The original archive is never modified.
- **Tests:** a hostile corpus committed as generated fixtures (zip bomb, quine, `../evil`, absolute path, symlink, hardlink, Unicode-collision pair, RTL-override name, lying sizes, bad CRC, encrypted entry, ZIP64 edge, 60k tiny entries, deep nesting);
  property tests (any entry list the generator builds either extracts inside the prefix within limits or is rejected, never anything else); a fuzz target on the parsers with a time budget; mutation tests on the limits (change a limit, a test must fail).

## 5. Scans (S-K2a)
- **Secrets:** reuse `packages/domain/src/ai/secret-scan.ts` per text file; store only counts and `path:line` evidence, redact before anything is displayed; a package with high-confidence live-looking secrets is quarantined with reason `secrets_found` (admin may override with a recorded reason, but the secret itself is never stored).
- **Licence:** detect from `LICENSE*`, `COPYING*`, manifest fields (`license` in `package.json`, `pubspec.yaml`, `composer.json`, `pyproject.toml`) and SPDX headers; classify by text fingerprint into SPDX ids; map to a *proposed* verdict
  (permissive allow-list → `ALLOWED`, copyleft/network-copyleft/unknown custom → `RESTRICTED`, proprietary or "no redistribution" → `BLOCKED`, missing → `UNKNOWN`). The proposal is evidence for the reviewers; per D-43 it is never final,
  and an `UNKNOWN`/`RESTRICTED`/`BLOCKED` verdict cannot be activated (the database already enforces ACTIVE ⇒ ALLOWED). Counsel review for commercial themes stays an open legal item.
- **Dependencies and lifecycle scripts:** parse manifests (`package.json`, lockfiles, `pubspec.yaml/lock`, `requirements.txt`, `pyproject.toml`, `composer.json`, `go.mod`, `Gemfile`) into `resource_dependencies` (ecosystem, name, range, kind, path, declared licence, risk);
  flag lifecycle scripts (`preinstall`, `postinstall`, `prepare`), `git:`/URL/tarball dependencies, install-time downloads and deny-listed packages using the existing dependency policy (`appbuilder/internal/policy`). Nothing is installed.
- **Risky files:** obfuscated or minified blobs over a threshold, `eval`/dynamic-code patterns reported as information, large base64 blobs, hidden directories, CI files that call out to the network (information only).
- **Malware:** no claim (D-44). The pattern scan result is labelled "pattern scan", never "malware scan"; an AV adapter (e.g. a `clamd` socket) can be added behind a port when D-44 chooses an engine.
- **Documentation and README text** is stored as reference content and flagged as untrusted (`untrusted.ts` fences); S-K2 never feeds it to a model.

## 6. Framework detection (S-K2b)
- A versioned **framework registry**: each detector is a pure function over the file inventory and parsed manifests, returning `{ framework, version?, confidence, evidence[] }`; detectors are data-driven where possible (file/glob and dependency rules) and code only when a rule needs logic.
  Initial set: Next.js, React, Vue, Angular, Flutter, NestJS, Express, Django, Laravel, plus Tailwind, Prisma/TypeORM, Bloc/Riverpod/Provider/GetX (state management) as sub-signals. Adding one is a new file plus a golden test.
- **Monorepos:** detect per workspace root (`pnpm-workspace.yaml`, `package.json` workspaces, `melos.yaml`, `apps/*`, `packages/*`); a resource may match several frameworks; roles (frontend/backend/mobile/library) are inferred from evidence.
- **Evidence rule:** no framework without at least one concrete evidence item (a dependency line, a config file, an entry-point file); confidence is derived from evidence strength, not guessed. Conflicting signals lower confidence and are reported.
- **Golden tests:** the three E2E sample packages (Next.js theme, Flutter starter, Next.js + NestJS full stack) with exact expected detections, plus negative fixtures (a README that merely mentions Next.js, a `package.json` with no framework, a Dart package that is not Flutter).

## 7. Project intelligence analysis (S-K2b/S-K2c)
- **Project Intelligence Manifest** (schema-versioned, stored in `resource_manifests`, summarised by the existing resource API): frameworks, languages (by bytes and files), architecture roles, modules, routes/pages, API endpoints (NestJS controllers, Next route handlers, Express routers),
  database models (migrations, Prisma, TypeORM), authentication/authorisation signals (guards, middleware), styling approach (Tailwind config, CSS modules, ThemeData), tests and build scripts, and `capabilities` — each with `evidence[]` (path and line) and `confidence`. **Anything without evidence is not written.**
- **Structure:** directory tree summary, entry points, workspace graph, internal import graph (resolved relative imports only) into `resource_relationships`; third-party imports into `resource_dependencies`.
- **TypeScript/JavaScript:** the TypeScript compiler API in *parse-only* mode (no type-check, no module resolution from the file system outside the snapshot, no plugins, no `require` of project code), with a node/time budget per file; JSX/TSX supported.
- **Dart:** bundled tree-sitter grammar (D-45) in WASM or native binding, parse-only; Flutter entry points, routes (`go_router`/`Navigator`), screens and widgets are *detected* here and *modelled* in S-K4.
- **Components (S-K2c):** discover exported React/Vue/Angular components and Flutter widgets with name, path, props/parameters where statically visible, imports (dependencies and style dependencies) and a `reuse_allowed` flag derived from the resource permission (default false); quality stays "not measured".
- **Incremental and cached:** `analysis_results` is keyed by `(version, analyzer, analyzer version, content hash)`; unchanged files and unchanged analyzer versions are skipped on re-analysis; `force` re-runs. All analysers are deterministic, so golden manifests are stable.
- **Search documents:** after analysis the INDEX job writes `resource_search_documents` (summary, components, symbols, doc sections) so S-K5 can add retrieval without re-reading source.

## 8. API, spec and UI changes
- **Spec (planned → implemented as built, per `spec/openapi/planned-paths.yaml`):** `GET …/resources/{id}/processing-jobs`, `POST …/analyses`, `POST …/activation`, `POST …/reviews`, `GET …/resources/{id}/components` (S-K2c). No new paths beyond SCR-K-01; new error codes are limited to the registry already merged. Each path moves into `openapi.yaml`
  only with its implementation (`spec:drift` is two-way).
- **Activation and review:** activation requires state `AWAITING_REVIEW`, licence verdict `ALLOWED`, and for third-party or licensed resources two different staff accounts with `admin:ai_knowledge:publish` (neither the uploader); decisions are append-only; the previous ACTIVE version is retired, never overwritten; activation never happens automatically.
- **Admin UI:** processing-job monitor on the resource page (stage, progress, attempt, actionable error), findings panel (secrets by path with redaction, licence evidence, risky files, dependency risks), analysis summary (frameworks with evidence, manifest, counts), review and activate with the two-approver flow, upload state `QUARANTINED → VALIDATING …` live (poll). Arabic and English, RTL, loading/empty/error/forbidden states, axe, screenshots, E2E.
- **Audit and metering:** audit event per stage transition and decision; no billable AI action exists in S-K2, so no metering events (recorded so the pipeline is ready when S-K4+ adds model use).

## 9. Data and migrations
Migration `1861` (worker grants and policy, any index the job monitor needs) and, only if the settings decision is taken, `1862` for `knowledge.settings` (limits and ranking weights; today they are constants). No change to the S-K1 tables' shape is expected;
`ownership.yaml` and classification are extended in the same change; `compliance:classification-coverage` must stay green. Down migrations documented; production is forward-fix as for S-K1.

## 10. Test strategy (CLAUDE.md §7)
Unit and property tests for every limit and rule of §4; hostile corpus and fuzz budget; golden manifests; worker tests for retry, timeout, cancel, crash-between-stages, duplicate operation delivery and concurrent duplicate uploads; integration tests with the real database (state-machine guards, RLS and cross-tenant, the worker
role's narrow grants, activation rules, two-approver rule, append-only decisions); API contract tests; E2E in Arabic and English for the admin flow (upload sample → validating → awaiting review → second approver activates, and a hostile package is rejected with its reason); performance test (a 2 GiB-limit package and a 50 000-entry package within memory and time budgets).

## 11. Decisions and gates
| Item | Needed for | Default if not decided |
|---|---|---|
| D-44 malware engine | a malware scan claim | none claimed; pattern scan only |
| D-45 Dart parser | S-K2c Dart analysis | tree-sitter, bundled, parse-only |
| D-42 provider object store | production use of the whole library | stays dev-only; production refuses (tested) |
| D-43 counsel on commercial themes | activating any third-party commercial theme | none activated; verdicts are proposals |
| Settings table (limits, weights) | S-K5 weights; editable limits | constants (lowered only) |
| Worker handler location | S-K2a start | worker + narrow grants (§3) |
| Quarantine override policy for secrets/risky files | S-K2a review UX | override needs a reason and `publish`, audited |

## 12. Risks
Parser attack surface (mitigated by pure functions, limits, fuzzing, no third-party unzip); resource exhaustion (limits, budgets, single-flight, per-org caps); false confidence from detectors (evidence rule, golden and negative tests); licence misclassification (proposal only, human decision, DB rule);
worker privilege creep (narrow grants, policy test that the worker cannot write source-owned or tenant tables); scope growth (three sub-slices, each shippable and reported).

## 13. Definition of done for S-K2
Every acceptance row of the sub-slice PASS with evidence, or listed BLOCKED/NOT VERIFIED with its gate; hostile corpus rejected; no code path executes package content (static check: the analysis modules import no `child_process`, `vm`, `worker_threads` for package code, or dynamic `import()`/`require` of snapshot paths — enforced by an ESLint rule and a test);
spec/SDK/ownership/classification/residency checks green; E2E ar/en with stored screenshots; report in the §10 response format; commit separate from other work; no merge to `main` without the owner.
