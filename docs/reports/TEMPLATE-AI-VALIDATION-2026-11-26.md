# Template Library and AI Builder: real end-to-end validation (2026-11-26)

Local only. Nothing was pushed or deployed. One real, owner-approved Claude request was sent; no other billed call was made.

**Result in one line:** the template workflow (upload → worker analysis → two-person review → activation → publication → customer selection → copy → generation plan) works through the real APIs and permissions. Claude returned a **valid structured change set** (not prose) that passed every check and changed layout, colours, text and one reusable component. The run itself **failed at the save step** because of a platform defect (a version label longer than the database allows). The defect is fixed in `b9755b99`. Claude's checkpointed change set was then applied by the run engine's own code, with no new model call. An uninterrupted run on the fixed code needs one more billed request, which has not been sent.

Evidence: [`evidence/template-ai-validation-2026-11-26/`](evidence/template-ai-validation-2026-11-26/) (`record.json`: every step and status; `before-after.diff`; `path-safety.json`).

## 1. Environment and safety
| Item | Value |
|---|---|
| Code | local `main`. Run on `eb251bb9`; label fix `b9755b99`; development-flag fix `4b4246cb`; this report and the test/cache fix follow |
| Database | `nuzm_tpl_e2e`, a disposable copy of `nuzm_local` on the platform's own PostgreSQL (:54390). `nuzm_local` (your data) was **not changed** |
| Stores | own object store and Git version store under `.dev-data/template-validation/` |
| Accounts | dev sign-in accounts on the local identity provider (127.0.0.1:4310): uploader `staff@example.test`, approvers `approver1@`/`approver2@example.test`, customer `owner@example.test`, second organization `viewer@example.test`. Each enrolled two-factor sign-in through the API first (admin calls returned 403 before, 200 after). No password of yours was used or changed |
| Live AI | Claude only, `AI_ATTEMPTS_PER_CANDIDATE=1`, `AI_MAX_REPAIR_ATTEMPTS=0`, `AI_FALLBACK_POLICY=none`, output ceiling 8,000 tokens, run budget **75 credits / 14,000 tokens**; a marker file made a second send impossible from the script. After the run the stack was stopped and the platform restarted with live calls **off** |

**Passwordless reviewer cannot reach production.** The dev identity provider (`TestIdp`) is constructed only in `apps/api/src/dev-stack.ts`, which throws when `NODE_ENV=production`; the production entry point never imports it. Sessions it issues carry the issuer `http://127.0.0.1:4310`, which no production OIDC configuration accepts. The local reviewer (`reviewer@example.test`) exists only in the local database and the local sign-in list.

## 2. Template upload and approval
Synthetic multi-file Next.js template "Synthetic Cafe": 14 files (`package.json`, `tsconfig.json`, `next.config.mjs`, `README.md`, `LICENSE`, `app/{layout,page}.tsx`, `app/globals.css`, `components/{Button,Header,Hero,FeatureCard,Footer}.tsx`, `lib/content.ts`), ZIP 8,104 bytes, SHA-256 `ddb49185…d291ea`. No third-party content.

| Step | Result |
|---|---|
| Upload session → part with SHA-256 → complete | 201 / 200 / 202, resource `01a214b1-1fea-72fa-b7be-4783a6e4eb3b`, type STARTER_KIT, provenance THIRD_PARTY |
| Worker: VALIDATE, EXTRACT, DETECT, COMPONENTS, DESIGN, INDEX | all SUCCEEDED in 4 s → `AWAITING_REVIEW` |
| Analysis | 14 files, 7 components (RootLayout, HomePage, Button, FeatureCard, Footer, Header, Hero), 0 findings |
| Uploader approves own upload | **refused** 403 ("the uploader cannot review a third-party resource they uploaded") |
| Activate with 0 approvals / 1 approval | **refused** 409 `knowledge_approval_required` both times |
| Approval 1 (security) / approval 2 (platform admin) | 201 / 201 |
| Activate | 200 |
| Publish (`PLATFORM_PUBLISHED`, starter-eligible, reuse FULL_STARTER, AI processing allowed; `If-Match`) | 200 |

**PASS.** No approval or sign-in was bypassed.

## 3. Customer template selection
| Step | Result |
|---|---|
| Customer gallery `GET /v1/builder/templates` | 200, lists the template |
| Copy into a project `POST /v1/builder/projects/from-template` | 201, project `01a214b2-1848-75e2-b089-13941dd647eb` ("Cafe site (template validation 2)"), first version `01a214b2-1857-…` |
| Generation plan | 201, plan `01a214b2-1b5f-70c4-8d7b-4b1fc560f12e`, mode ADAPTIVE |
| Context preview (nothing sent) | 2,817 of 12,000 tokens, 17 blocks, all 14 files, AI processing allowed |

**PASS** after a fix. The first copy attempt returned 404 "project not found": the development-flag script had switched `app_builder.m09_stubs` on platform-wide, which routes the app builder to in-memory stand-ins. It was overridden for the test organization in the disposable database only, and the script fixed in `4b4246cb`. The failed attempt left an empty project "Cafe site (template validation)" behind (defect D-4).

## 4. The real AI generation
Endpoint: `POST /v1/builder/generation-plans/{id}/runs` (the template adaptation run, **not chat**), budget `{maxTokens: 14000, maxCredits: 75}`.

Requirement sent (synthetic):
> 1. Layout: on desktop (min-width 1024px) show the hero on the left and the feature cards on the right in a two-column grid; keep a single column on phones. 2. Colours: background #f3f8f4, text #12261a, primary #1f6f43, card border #cfe3d6. 3. Text: "Green Leaf Cafe", tagline "Coffee and calm, every morning.", button "Book a table". 4. Component: give FeatureCard an optional `badge` prop shown as a small label above the title, and show "New" on the first feature.

| Measure | Value |
|---|---|
| Model | `claude/claude-opus-5-5`, task `edit`, one call (`ai.model_usage`: exactly 1 row) |
| Input tokens | **5,081** |
| Output tokens | **2,342** |
| Model latency | **17,427 ms**; run created 00:54:25.52, ended 00:54:43.17 (+03:00), about 17.65 s |
| Actual cost | platform record **USD 0.07** (`cost_minor` 7, rounded up to the cent); at list price about USD 0.067 |
| Credits charged | 26 (reservation 65 credits / 10,888 tokens, inside the 75 / 14,000 budget) |
| Retries, repairs, fallbacks | none |
| Output | valid JSON change set: summary + **4 `modify` patches**. Structured contract, parser and `proposalProblems` checks: **0 problems** |
| Run state | **failed**: `internal_error`, `project_versions_label_check` (defect D-1, fixed) |

Claude's answer was source-code modifications, not prose. The failure happened after the model call, when the platform saved the version: the label is `"Adapt template (ADAPTIVE): " + summary`, sliced to 120 characters, while the database allows 100. The change service now slices to 100 (`VERSION_LABEL_MAX`); a regression test (`apps/api/src/modules/appbuilder/change-label.int.spec.ts`, messages of 101, 120, 126 and 500 characters) failed 4/4 before the fix and passes 4/4 after.

**Applying the checkpointed answer.** The run had checkpointed Claude's proposal before the save failed. After the fix, a one-off script called the run engine's own `TemplateAdaptRunner.proposalProblems` (0 problems) and `applyProposal` in-process, with live providers empty (no model can be called). Result: version **`01a214c4-5fb7-7074-9f19-8ab2ddf39406`**, source `ai`, Git commit `75ea46a5` on branch `work/ai`, base = the template copy. The run record stays `failed`; it is not rewritten.

## 5. Modified files and diff
4 files, 26 insertions, 12 deletions (`before-after.diff`, from the version store's Git history):

| File | Change |
|---|---|
| `app/globals.css` | the four requested colours; new `.main-grid` (one column, two columns from 1024 px), hero text left-aligned on desktop, badge style |
| `app/page.tsx` | `<main className="main-grid">`; first `FeatureCard` gets `badge="New"` |
| `components/FeatureCard.tsx` | **reusable component:** optional `badge?: string` prop, rendered above the title |
| `lib/content.ts` | "Green Leaf Cafe", "Coffee and calm, every morning.", "Book a table" |

| Requirement | Result |
|---|---|
| Colours | PASS (all four) |
| Text | PASS (all three; `Hero` already reads `site.cta`) |
| Reusable component | PASS (optional prop, used once) |
| Layout: hero left, cards right from 1024 px, one column on phones | PASS |
| Layout: cards in a **two-column** grid on the right | **FAIL (partial):** on desktop the cards are one column inside the right-hand column (`.features { grid-template-columns: 1fr }`). Between 640 and 1023 px they stay two columns. |
| Quality | minor: `.card .badge + h3` never matches (the badge is wrapped in a `div`). TypeScript types are consistent by reading; the project was **not** compiled (no code is built or run on the host; that is the next milestone) |

## 6. Verification
| Check | Result |
|---|---|
| Versioning: AI version is the new head, source `ai`; template copy version kept and unchanged (old colours) | PASS |
| Platform diff API `GET …/version-diff` | PASS: exactly the 4 files |
| Tenant isolation: another user in another organization gets 404 on project, versions, file content, diff, plan, context, template workspace and run (8 endpoints) | PASS |
| That user naming this organization in `x-nuzm-org` | PASS: 404 |
| Rollback to the template copy (`POST …/rollbacks`) | PASS: new head, 0 differences from the copy, history kept |
| Roll forward to Claude's version | PASS: new head, 0 differences from version `01a214c4` |
| Template preserved: 15 stored objects (SHA-256 before/after identical), 14 file hashes unchanged, still ACTIVE + PLATFORM_PUBLISHED | PASS |
| Usage: one `ai.model_usage` row, tokens, cost, credits, residency evidence `rd_617967b5…` | PASS |
| Audit: upload, approvals, activation, publication, project creation, run and version events present | PASS |
| No generated code executed on the host: all 89 `host_exec.process.allowed` audit entries are the version store's own `git`; nothing was installed, built or run | PASS |
| Path safety (`path-safety.json`, the runner's own checks on crafted proposals): `..`, absolute path, `.git/…`, backslash, a secret pattern in content, adding an existing file, modifying a missing file | all **refused** |
| Adding `.env` with harmless content | **accepted** (defect D-2) |
| A `postinstall` script in `package.json` | accepted as text; never executed (install scripts are disabled by the dependency policy and nothing installs) |

## 7. Test and build results
| Command | Result |
|---|---|
| App builder, builder and knowledge integration suites (isolated test database) | 370/370 after the fix |
| `pnpm --filter @nuzm/db test` | 61/61 |
| `TURBO_FORCE=true pnpm verify` (no cache replay; on these changes before the report was added) | **PASS**, exit 0: lint/typecheck 57/57 tasks, 6,356 unit tests 0 failed, build, spec lint and drift, SDK check, docs, secret scan, ZATCA guard, claims guard, testenv 31/31 |

**Cache finding (D-6).** The `pnpm verify` PASS recorded on 2026-11-25 for `ac186dc6` (main integration report) included a **cached replay** of the database unit tests. Those tests read `spec/` files, which were not Turbo inputs, so a spec change did not invalidate them. A real run fails one test: the integration added an enforced residency hook (`m10-version-store`, called in `object-version-store.ts`) without adding it to the test's list of enforced hooks. Fixed: the test task's inputs now include `spec/**` (`turbo.json`), and the list includes the hook.

## 8. Defects and blockers
| ID | Defect | State |
|---|---|---|
| D-1 | Version label sliced to 120 characters; database allows 100. Every change message of 101+ characters failed with an internal error (including every real template adaptation with a long summary) | **FIXED** `b9755b99` + regression test |
| D-2 | Path policy accepts `.env` / dotenv files from the model | OPEN (backlog DL-042) |
| D-3 | The development flag script switched `app_builder.m09_stubs` on platform-wide, sending real projects to in-memory stand-ins | **FIXED in code** `4b4246cb`. The platform-wide row in `nuzm_local` (set 2026-11-23) was **turned off on 2026-11-26 at the owner's request**: row kept as `{"enabled": false}`, audited, previous row backed up; the platform's flag check now resolves the stand-ins off for `nuzm` and `codgoo org` |
| D-4 | A failed copy-from-template leaves an empty project behind | OPEN (DL-043) |
| D-5 | Plan and run responses do not return the run id; clients must poll the plan | OPEN (DL-044) |
| D-6 | Turbo cache did not see `spec/` changes; stale residency-hook test | **FIXED** in this commit |
| D-7 | A failed run's error exposes the raw database message (constraint name) to the customer API | OPEN (DL-045) |
| Q-1 | Layout followed partly (cards one column on desktop) and one selector never matches | model quality; observe in the next run |
| B-1 | Build, sandbox and live preview of the modified project | **BLOCKED** (D-21, HG-10-02, ADR-069): next milestone |
| B-2 | An uninterrupted real adaptation run on the fixed code | **NOT VERIFIED**: one more billed request, needs your approval (estimate: about 5,100 input tokens, 8,000 output ceiling, same 75-credit / 14,000-token budget, worst case about USD 0.19, typical about USD 0.07) |

## 9. Local URLs and state
| What | Where |
|---|---|
| Customer console | http://127.0.0.1:3300/login |
| Admin console | http://127.0.0.1:3301/login |
| API health | http://127.0.0.1:4300/healthz |
| Platform | `pnpm platform:status`, live AI **off**, your `nuzm_local` data |
| Test evidence database | `nuzm_tpl_e2e` (disposable; keep or drop at will) |

Final commit: the commit that adds this report on local `main` (see the session's final message).
