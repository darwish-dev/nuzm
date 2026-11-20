# AI Intelligence Center — slice S-K1 report (library foundation)

Date: 2026-11-20 (implementation) and 2026-11-21 (final verification, section J) · Branch `claude/run-it-dc3d6a` · Status: **ACCEPTED ON EVIDENCE for S-K1: database, API, admin UI, live upload workflow and browser E2E (ar + en) verified; three listed items are open (section J.8). Not merged to `main`.**
Governing documents: `docs/adr/ADR-065-ai-intelligence-center-knowledge-module.md` (ACCEPTED 2026-11-20), `docs/spec-change-requests/SCR-K-01-ai-intelligence-center.md`
(APPROVED 2026-11-20), audit and plan `docs/ai-intelligence/AUDIT_AND_PLAN.md`.

## A. Repository findings and assumptions
- Findings are in the audit. Assumptions recorded while implementing:
  1. **Settings endpoints are deferred to S-K5.** The approved 20-table model has no settings table; storing weights and limits needs one more table or a decision. Upload limits are constants
     (platform hard caps) until then. `GET/PATCH /v1/admin/knowledge/settings` stay in `spec/openapi/planned-paths.yaml`.
  2. **Permission names use underscores** (`admin:ai_knowledge:*`): `tenancy.permissions.name` allows only `[a-z_]` segments. Recorded as a correction in SCR-K-01.
  3. **A completed upload stays QUARANTINED.** Validation, extraction and analysis are S-K2; nothing reads inside an uploaded archive yet.
  4. **Default data region** of a new resource is `sa-central` unless the upload says otherwise; the residency hook `k-knowledge-library` is registered as `listed` (not yet enforced).
  5. The decisions D-41 … D-49 were recorded as DECIDED on the owner's "Approve as drafted"; D-46 (model tool use) stays OPEN. Interim defaults (D-42, D-43, D-44, D-47) keep their reviews open.

## B. Plan and changed files
- New module `apps/api/src/modules/knowledge/` (`knowledge.module.ts`, `admin-knowledge-uploads.controller.ts`, `admin-knowledge-resources.controller.ts`,
  `internal/{model,object-store,upload.service,resource.service,flag}.ts`, `index.ts`) registered in `apps/api/src/app.module.ts`; `app.setup.ts` parses `application/octet-stream` (64 MiB cap).
- Migration `packages/db/migrations/knowledge/1860__knowledge__library_foundation.sql` (+ `.down.sql`), range `K: 1860-1899`.
- Spec: `spec/openapi/openapi.yaml` (+11 operations, 15 schemas), `planned-paths.yaml` (+17 planned), `spec/openapi/errors.yaml` and `apps/api/src/common/errors.ts` (+6 codes),
  `spec/db/ownership.yaml` (schema, tenant-less list, migration range, 292 classified columns, 4 justified exceptions), `spec/compliance/residency-hooks.yaml`, `packages/sdk/src/schema.ts` (regenerated).
- Supporting: `packages/db/src/residency-hooks.ts` (accepts milestone `K`), `apps/api/src/platform-scope.spec.ts` (allow-list), `apps/api/src/modules/ai/testing/ai-harness.ts` (admin helper takes PUT/PATCH/DELETE and binary bodies),
  `.env.example`, `docs/07` (D-41 … D-49), ADR-065 and SCR-K-01 status.

## C. Implemented
- **Upload API** (5 operations): open a resumable session, put parts (SHA-256 per part, out of order, idempotent re-send, size cap), read the session (resume), cancel, complete
  (contiguous part list, declared size, whole-object SHA-256; content-addressed archive; deduplicated by checksum; lazy expiry).
  File names are allow-listed (`.zip .tar.gz .tgz .md .markdown .txt .pdf .docx .json .yaml .yml .png .jpg .jpeg .webp`); paths, hidden names, control characters, scripts, executables and SVG are refused.
- **Resources API** (6 operations): list with filters and cursor paging, get (metadata, permissions, current version, manifest summary with evidence, quality scores, jobs), patch with `If-Match`,
  versions, disable, archive (soft delete). The licence verdict and identity are not editable; publish-only changes (publish, default-eligible, AI processing) need `admin:ai_knowledge:publish`.
- **Object-store port** `KnowledgeObjectStore` with a development filesystem adapter; production gets an "unconfigured" adapter that answers 404 (no silent local-disk use).
- **Flag** `knowledge.library` (global, default OFF): every route answers 404 while off.
- **Audit**: opened, completed, cancelled, updated (before/after), disabled, archived; no package bytes or secrets in events.
- **Admin UI** (`apps/admin`): new top-level category **AI Intelligence Center** (`/ai-intelligence`, permission `admin:ai_knowledge:read`) with the Knowledge Library:
  list (GET filter form: search, type, status, platform, framework; cursor "show more"; cards/table), upload panel, resource page (facts, permissions, analysis/quality "not measured",
  versions, edit with `If-Match`, disable and archive with a recorded reason), states for loading, empty, filtered-empty, error, forbidden, flag-off and not-found; Arabic (RTL) and English.
  The upload runs in the browser: allow-list check, whole-file SHA-256 (own streaming implementation, verified against Node), verified 8 MiB parts with up to three tries, resume of the same file after an
  interruption, Cancel that discards the session. Files: `components/Knowledge{Library,Upload,Resource}.tsx`, `lib/{knowledge,knowledge-upload,sha256}.ts`, pages under `app/[locale]/(console)/ai-intelligence/`,
  161 + 1 message keys (ar/en, own block in `packages/i18n/src/messages.ts`), CSS block in `packages/ui/src/console-css.ts`.
- **Not built (by design of this slice)**: ingestion stages, analysis, manifests, components, retrieval, recommendation, GitHub import, settings, defaults, analytics, customer endpoints.

## D. Migrations and rollback
`1860__knowledge__library_foundation.sql`: schema `knowledge`, 20 tables, 3 permissions and role grants (`platform_admin`: read/manage/publish; `security`: read/publish; `support` and `compliance_officer`: read),
RLS enabled and forced on every table, guard triggers, `knowledge.v_published_templates` (definer view with `security_barrier`). Reversal: `.down.sql` (development/staging only; production is forward-fix, as for ADR-064).

## E. Tests run (actual results)
| Command | Result |
|---|---|
| `pnpm --filter @nuzm/db exec vitest run --config vitest.integration.config.mts` | 4 files, 66 tests passed (includes the new `knowledge-rls.int.spec.ts`: 23 tests) |
| `pnpm --filter @nuzm/db exec vitest run` | 5 files, 55 tests passed |
| `pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts src/modules/knowledge/knowledge.int.spec.ts` | 34 tests passed |
| `pnpm --filter @nuzm/api test` | 71 files, 1054 tests passed (includes 40 new unit tests) |
| `pnpm --filter @nuzm/admin test` | 19 files, 295 tests passed (new: `lib/sha256.spec.ts` 5, `lib/knowledge-upload.spec.ts` 22, `components/KnowledgePanels.spec.tsx` 18, `lib/nav.spec.ts` +1) |
| `pnpm --filter @nuzm/admin typecheck`, `pnpm --filter @nuzm/admin build` | passed; both new routes compile |
| `pnpm --filter @nuzm/ui test`, `pnpm --filter @nuzm/i18n test` | 24 and 9 tests passed |
| Browser check of the screens (real components, mocked data, Chrome pane; ar and en) | list cards, resource page, edit form, upload panel rendered and reviewed; two layout defects found and fixed |
| `e2e/tests/14-ai-knowledge.spec.ts` (Playwright, ar + en, axe, screenshots) | **PASS 8/8 on 2026-11-21** in an isolated stack (section J). The earlier "NOT RUN" is superseded |
| `pnpm lint` | passed (eslint + prettier) |
| `pnpm spec:lint`, `spec:drift` (468 routes), `sdk:check`, `scan:secrets`, `compliance:claims-guard` | passed |
| `pnpm compliance:classification-coverage`, `compliance:ropa-coverage`, `compliance:residency-hooks` (migrated throwaway DB) | passed |
| `pnpm --filter @nuzm/api test:integration` (whole API suite) | 1931 passed, 3 failed, 2 skipped. None is caused by this slice: `builder.int.spec.ts` (preview origin) and `mobile.int.spec.ts` (signing refs) passed when re-run alone (50/50) and are load-related flakes in the full run; `programs.int.spec.ts` (delegated-header sweep) failed on the untouched baseline too because AI Studio's signature-authenticated `/v1/webhooks/github` answers 401 to anonymous callers. That sweep now skips `/v1/webhooks/*` and passes (18/18) |

## F. Security, tenant isolation, billing, residency verification
- **Isolation (PASS, evidence: `knowledge-rls.int.spec.ts`)**: a tenant session reads only its own rows from every base table; no policy exposes platform rows; B cannot see A; writes of platform rows or other orgs' rows are refused;
  the worker and reporting roles cannot write; the published view lists only ACTIVE + published + licence-ALLOWED + reuse-permitted versions, never exposes archive/snapshot/object keys, file paths, manifests or source excerpts,
  and drops a template when it is disabled, its licence changes or reuse is switched off.
- **Integrity (PASS)**: versions immutable, resources keep identity/owner/type/region, files/manifests/analysis/quality/usage/evaluations append-only (grants and triggers), ACTIVE requires an ALLOWED licence, one ACTIVE version per resource,
  a quality score exists only with its evidence, money requires a currency.
- **Upload safety (PASS for what exists)**: allow-listed names, size cap, per-part and whole-object checksums, no execution or extraction. **Not covered here**: archive-content safety (zip bombs, traversal inside archives,
  symlinks, secret and licence scan) is S-K2 and is **NOT VERIFIED / NOT IMPLEMENTED**.
- **Billing/metering**: no billable action exists in this slice. **Residency**: hook registered, not enforced (NOT VERIFIED).

## G. Human gates and live checks still needed
D-42 (object-store provider; production refuses the dev adapter), D-43 counsel review before any commercial theme, D-44 (malware scanning engine; none claimed), D-46 (model tool-use SCR), D-47, D-18 / HG-09-01, D-21, HG-AS-01.

## H. Acceptance checklist (this slice)
| Row | Status |
|---|---|
| Admin can upload and manage real source projects | PASS: API integration tests, component tests and the browser E2E against the live API (section J) |
| Uploaded resources securely validated | PARTIAL: upload-level checks PASS; archive-level validation NOT STARTED (S-K2) |
| Projects analysed / theme DNA / retrieval / recommendation / generation | NOT STARTED |
| Customers isolated from the platform library at database level | PASS (database tests); customer endpoints NOT STARTED |
| Existing AI Builder functionality remains operational | PASS: API unit suite and the whole API integration suite (see section E for the three non-slice failures) |

## I. Next
S-K2, planned in `docs/ai-intelligence/S-K2-PLAN.md` (ingestion state machine, safe extraction, scans, job monitor). Open: D-46, the settings storage decision for S-K5.

## J. Final verification (2026-11-21)

### J.1 Git state (inspected, nothing overwritten or reverted)
Branch `claude/run-it-dc3d6a`, not merged to `main`. History: `614d408` WIP commit (saved every uncommitted file of this worktree: the S-K1 work **and** unrelated earlier builder/web edits, 65 files) → `fad50af` merge of `main`
(brought `2c1cbe4` and `1f91fd2`, 16 web-builder files plus `messages.ts` and `console-css.ts`; **no conflict and no change to any S-K1 file**, re-verified: spec lint, drift 468 routes, SDK, secrets and typechecks green after the merge) →
`1c64c9d`, `7c9071b`, `a12f746` (other sessions' builder and DNet-registrar commits landed on this branch while this verification ran). Uncommitted work of other sessions
(`StudioPanels.tsx`, a `.bws-panel-body` block of `console-css.ts`) was left alone and has since been committed by them; `docs/reports/evidence/M12-tenant-sweep.json` was regenerated by the integration run and only adds the other session's DNet route, so it is **not** included in the S-K1 commit.

### J.2 Isolated test server (no process of another workspace was touched)
Playwright was parametrized: `e2e/tests/env.ts` reads `E2E_WEB_PORT`, `E2E_ADMIN_PORT`, `E2E_API_PORT`, `E2E_IDP_PORT`, `E2E_DB`, `E2E_STORE_DIR` (defaults are the old fixed values, so `pnpm test:e2e` is unchanged); the config passes the matching origins to the API and both consoles.
Run: a separate clean `git worktree` at `HEAD` plus this change set, ports **3300/3301/4300/4310**, database **`nuzm_e2e_k1`** (created and migrated once, because Playwright starts servers before global setup recreates the database), object store in its own temp directory.
Port 3000 (the main checkout's `next-server`) and the API on 4000 were never stopped; only processes whose working directory was the isolated worktree were stopped, each after checking its owner.

### J.3 Browser E2E — `e2e/tests/14-ai-knowledge.spec.ts`, **8 passed (4 scenarios × ar RTL and en LTR), 5.9 min**
| # | Scenario | Evidence |
|---|---|---|
| 1 | Library UI: flag off → empty → upload (executable refused, name required) → list → resource page → edit (only changed fields, "nothing changed") → new version → disable (reason required) → read-only staff → forbidden staff → archive | audited with axe (WCAG 2.1 A/AA incl. contrast) at 10 states; DB rows checked after each step; audit events present |
| 2 | **Real upload of three safe sample projects** (Next.js theme, Flutter starter, Next.js + NestJS full-stack; generated ZIPs of static text, no scripts, no binaries, no secrets) | per sample: part checksum header = real SHA-256; stored object (`archives/<sha>`) is byte-identical to the file; DB: type, platform, frameworks, languages, category, tags, licence SPDX, region `sa-central`, status/state `QUARANTINED`, visibility private, version 1, licence verdict `UNKNOWN`, AI processing off, reuse `NONE`, provenance filename; **0 ACTIVE versions, 0 files unpacked, 0 rows in the customer view**; filters by framework/platform/type/text/status find exactly the right resources |
| 3 | **Upload engine on a 17.8 MB package (3 parts)** | progress: meter and "part 2 of 3" while part 2 is held, every part's SHA-256 header equals the real one; **retry**: part 1 connection reset once and part 2 answered 503 once → attempts {1:2, 2:2, 3:1}, upload succeeds; **resume**: part 2 never gets through → "choose the same file again" error, server shows 1 part and an OPEN session, session id remembered in the browser; after a **page reload** the same file continues: only parts 2 and 3 are sent, no new session, the same session id finishes, memory cleared; **cancel** mid-part: DELETE sent, session `CANCELLED`, parts directory removed from the store, no resource created, memory cleared; the large archive is stored once (content addressed) however many resources use it |
| 4 | Permissions and isolation at the API | `support`: list/get/versions 200; upload, patch, disable, archive, cancel **403**; `finance`: 403 on read; refused calls changed nothing; signed-out caller **401**; a **customer** session is refused on both the web and admin origins (401/403/404); tenant isolation on the live tables: two customer organizations and a no-org session see **0 rows** in 7 tables and 0 in `v_published_templates`; staff scope sees the library; even staff scope puts nothing in the customer view while versions are quarantined |

Screenshots: **34 files** (17 per language) in `docs/reports/screenshots/{ar,en}/ai-knowledge-*.png`: flag-off, empty, upload-form, upload-done, list, three-samples, filtered-empty, resource, versions, disable-confirm, upload-progress, upload-interrupted, upload-resumed, upload-cancelled, readonly, forbidden, permissions-done.

### J.4 Production object-store adapter (D-42)
There is **no production adapter**. `createKnowledgeObjectStore()` returns the filesystem adapter outside production and the **unconfigured adapter in production**, which answers 404 to every call (tested: even with `KNOWLEDGE_STORE_DIR` set, nothing is written to disk; the filesystem adapter also refuses to be constructed under `NODE_ENV=production`).
`knowledgeObjectStoreStatus()` reports `{ adapter, production: 'none', blockedBy: 'D-42' }`. **Remaining dependency on D-42:** choose the ADR-052 provider and region, write the provider adapter behind `KnowledgeObjectStore`, extend the conformance tests, then flip the selection by configuration. Until then the library cannot be used in production and `knowledge.library` must stay off there.

### J.5 Defects found by this verification and fixed
| Finding | Fix | Evidence |
|---|---|---|
| **The API process crashed when an idle database connection was ended** (`Pool` had no `error` listener: a database restart, failover or `DROP DATABASE … FORCE` killed the whole API) | listener logs a warning and the pool replaces the client (`packages/platform/src/db.ts`) | `db-pool.spec.ts`; the E2E stack no longer dies at global setup |
| E2E `signIn` helper was stale since the password sign-in forms (it looked for a "Sign in" link) — **every E2E spec was blocked** | helper uses the identity-provider link (`login.sso`) | E2E runs |
| Avatar button failed axe `label-content-name-mismatch` on every console page (WCAG 2.5.3) | accessible name now starts with the visible initials (`packages/ui/src/client.tsx`); web spec updated | axe clean on all audited states; `ConsoleShell.spec` 11/11 |
| Link inside the warning banner not distinguishable from text (axe `link-in-text-block`) | underlined | axe |
| Two landmarks named "Versions" on the resource page | the table region is the only one | E2E |
| E2E consoles read `ADMIN_ORIGIN`/`WEB_ORIGIN`/`API_ORIGIN` at run time | passed explicitly by the config | E2E |
| Axe contrast reading was flaky mid-transition | audit helper settles the page (pointer away, transitions off) and reports measured colours | 8/8 stable |

### J.6 Checks re-run on 2026-11-21 (actual results)
| Check | Result |
|---|---|
| `pnpm lint` (eslint + prettier) | PASS |
| `pnpm typecheck` | PASS (50 tasks) |
| Unit suites (`pnpm turbo run test --filter='!@nuzm/e2e'`) | PASS: domain 21 files, api 72, admin 21, ui 5, db 5, worker 3, platform 1, i18n 1, sdk 1 and all adapters; **web 66 files / 809 tests PASS after the avatar spec update**. (`pnpm test` itself also launches the Playwright package through turbo and fails on a busy machine; it is not a unit suite) |
| `pnpm --filter @nuzm/db exec vitest run --config vitest.integration.config.mts` | PASS (66 tests incl. 23 knowledge isolation) |
| `pnpm --filter @nuzm/api test:integration` (whole suite, run three times) | 1932 passed, 2 failed, 2 skipped on the final run. **Neither failure touches S-K1:** `email.int.spec.ts` (usage reconciliation) **fails identically on the pre-S-K1 baseline `a5d373b`**; `domains-search.int.spec.ts` (registrar list) fails because another session's commit `a12f746` adds a `dnet` registrar the test does not expect (it passes on the baseline). Earlier runs showed load-related flakes in builder preview and mobile signing that pass alone |
| `pnpm build` (27 tasks) | PASS |
| `spec:lint`, `spec:drift` (468 routes; 469 after the DNet commit), `sdk:check`, `compliance:claims-guard`, `compliance:classification-coverage`, `compliance:ropa-coverage`, `compliance:residency-hooks` (migrated DB) | PASS |
| `pnpm scan:secrets` | PASS on this work's files (0 hits before commit `a12f746`); **now reports one finding in another session's file** `apps/api/src/modules/domains/internal/registrar-dnet-settings.spec.ts:9` ("hardcoded password assignment"), which is not part of S-K1 |

### J.7 Acceptance status of S-K1
| Row | Status |
|---|---|
| Spec first: SCR-K-01 and ADR-065 approved, contracts merged only with their implementation | PASS |
| Migration, RLS forced on all 20 tables, guards, view, rollback note | PASS |
| Upload API: resumable, verified (per part and whole object), cancellable, quarantined; progress, retry, resume, cancel proven in a browser against the live API | PASS |
| SHA-256, stored object, resource metadata, quarantine state for Next.js, Flutter and full-stack samples | PASS |
| Resource editing (`If-Match`), versions, disable, archive (soft delete) | PASS |
| Admin permissions (read / manage / publish) and refused calls leave data unchanged | PASS |
| Tenant isolation of library tables and of the customer view | PASS (database and live-stack tests) |
| Nothing activated, nothing opened or executed | PASS: 0 ACTIVE versions, 0 unpacked files, no `child_process` in the module |
| UI states (loading/empty/filtered-empty/error/forbidden/flag-off/not-found), Arabic RTL + English, axe, screenshots | PASS (loading is the shared skeleton; verified by build and component tests) |
| Production object store | **BLOCKED (D-42)**: no adapter; production refuses (tested) |
| Residency enforcement of the new hook | NOT VERIFIED: hook registered as `listed`; enforced when ingestion (S-K2) calls the residency service |
| Malware scanning | NOT CLAIMED (D-44) |

### J.8 Unresolved issues
1. **D-42** (above) — blocks production use.
2. **`scan:secrets` finding in `registrar-dnet-settings.spec.ts`** (another session's commit `a12f746`) and **two API integration failures outside S-K1**: the email usage-reconciliation test (pre-existing at the baseline) and the registrar-list test (needs the new `dnet` entry from commit `a12f746`); both belong to their owners.
3. **Rest of the E2E suite not re-run** (`01`…`13`): only the specs this work needs were run. The shared sign-in helper and the avatar label were fixed for all of them, but their other expectations were not checked. `02-admin` needs `01-customer` to have created its organization first.
4. Cosmetic: the "Upload resource" button sits flush under the notice banner (spacing only; screenshots show it).
5. Playwright requires a new `E2E_DB` to exist and be migrated once (documented in `e2e/tests/env.ts`).
