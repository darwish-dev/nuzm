# REPORT — P3-S04 Website Generation and Live Preview

Branch `claude/p3-s04-website-1c5609` (from `integration/ai-engine` @ `ce16599d`), worktree `.claude/worktrees/p3-s04-website-1c5609`, Postgres :54354. Nothing pushed or merged. No provider was called, nothing was deployed, no customer data was used; every model-driven result below is **SIMULATED** (mock model) and labelled so.

Status vocabulary: `PASS` (evidenced here) · `SIMULATED` · `NOT VERIFIED` · `BLOCKED (…)`. Columns are never added together.

## A. Repository findings and assumptions
- The website pipeline already had: a pure deterministic renderer (`packages/domain/src/builder/render`) with Tailwind compiled server-side (ADR-062), strict CSP generation, validators (HTML, alt, links, physical-direction CSS, contrast palette), edit ops with diff/inverse, immutable versions with restoration, previews on an isolated origin (ADR-060) and a mature preview pane (viewport + site-language selectors, sandboxed iframe, per-version previews). S04 did not rebuild any of that; it added the missing automated judgment, the hash binding and the honesty layer on top.
- Eight shipped templates render clean (QA: 0 errors) after the gates were proven to catch defects (mutation corpus below). The first full pass being green is therefore a property of the existing renderer, not of lenient gates.
- Assumption: `packages/domain/src/builder/**` (renderer, templates) is shared with no other Phase 3 session; S04 changed nothing there (changing the `<title>` composition would alter Phase 2 snapshots). Recommendation R-1 below.
- Assumption: no DNS record, certificate or edge exists for a preview domain (B-DOMAIN pending): all such checks are `NOT VERIFIED` by construction.
- Live model generation (W1) depends on S01 (gateway) and S03 (loop), neither real yet. S04 delivered the harness, gates and evidence record so the same path judges a real model the day it exists.

## B. Plan and changed files (all under S04 ownership; no shared file edited)
New, `apps/api/src/modules/builder/internal/qa/` (library + CLIs):
`html.ts` (lenient reader) · `csp.ts` (CSP evaluator: strictness + "would the browser block this?") · `artifact.ts` (hash-bound manifest, dir load/write, `verifyServedArtifact`) · `context.ts` · `gates.ts` (structure, html, links, csp, size, rtl, contrast, seo, forms, assets, completeness) · `axe.ts` (axe-core on jsdom, WCAG 2.1 A/AA) · `browser-qa.ts` (Chrome: axe with layout, CSP as enforced, RTL, overflow) · `runner.ts` (`runWebsiteQa`, `repairFindings`/`repairText` for S03's loop) · `static-build.ts` (`buildWebsiteArtifact`) · `edit-diff.ts` (minimal-diff measure) · `evidence.ts` (evidence record + validator) · CLIs `website-qa.cli.ts`, `build-site.cli.ts`.
New, `internal/`: `artifact.service.ts` (`VersionArtifactService`: manifest/files/verify/qa/compare of a STORED version) · `preview-domain.ts` + `.cli.ts` (routing/TLS/validation workflow).
Changed: `internal/preview.service.ts` (defect fix, see F) · `internal/website.handler.ts` (QA report event + result field; reporting only) · `internal/page-guide.ts` (prompt rules for a11y/SEO/Arabic-first/5 pages/placeholder-only images) · `builder.module.ts`, `index.ts` (provider + public exports).
Tests: `qa/qa.spec.ts`, `qa/axe.spec.ts`, `qa/artifact.spec.ts`, `qa/evidence.spec.ts`, `qa/templates-qa.spec.ts`, `internal/preview-domain.spec.ts`, `preview-tamper.spec.ts`, `internal/page-guide.spec.ts` (extended), integration `p3-s04.int.spec.ts`, `p3-s04-t1.int.spec.ts`.
Docs: this report, `CONTRACT-P3-S04-1-qa-gates-deps-and-routes.md`, `NOTE-P3-S04-preview-comparison-ui.md`.

## C. Implemented
1. **Website QA gate runner** (library + CLI, any artifact directory). 12 gates; `qualified` is true only when every gate ran and none failed (a skipped gate, e.g. axe not installed, can never read as a pass). Findings are machine codes with a `hint`; `repairFindings`/`repairText` give P3-S03's repair loop a bounded, stably ordered list.
2. **Static build pipeline**: `buildWebsiteArtifact(model)` → files + manifest (`nuzm.site-artifact/1`, `rootHash` = SHA-256 over sorted `path\0sha256\0size`), deterministic; QA bound to the same hash. In-process (pure renderer + `compileSiteCss`); no server code, no network. When the qualified runtime (S02) exists a real build's output directory goes through the same `artifactManifest` and gates.
3. **Hand-off (W4)**: `VersionArtifactService.manifest()` of a stored version equals a fresh static build of its model; `verifyServedArtifact(manifest, fetch)` proves a target serves the same bytes (S07 injects an HTTP fetcher; here the preview service is the target).
4. **Preview isolation, deterministic (W2 part)**: seeded corpus against the real `PreviewService` over an in-memory store.
5. **Edit-by-prompt minimal diff + restore (W3)**: `measureEditDiff`/`assertMinimalEdit`; restore creates a new head whose artifact hash equals the original's.
6. **Preview domain routing/TLS/validation workflow**: `validatePreviewDomainConfig`, `renderEdgeConfig` (nginx, generated, refuses invalid input), `certCovers` (wildcard = one label), `runPreviewDomainValidation` with injectable probes; CLI is offline by default, `--live` refuses unless `PREVIEW_DOMAIN_LIVE_APPROVED=B-DOMAIN`.
7. **T1 evidence record** (`nuzm.evidence.website/1`): cannot be `LIVE-VERIFIED` with a simulated model, without an approval reference, or with any acceptance gate not green; validator refuses hand-edited over-claims and secret-looking content.
8. **Generation quality inputs**: `DESIGN_RULES` now states the QA gates up front.

No new API route, table, migration (2330–2339 unused), OpenAPI change or UI strings (those are Master-owned: CONTRACT-P3-S04-1).

## D. Migrations and rollback
None. Rollback = revert the commit(s); the only behavioural change to an existing path is the `preview.service.ts` fix (a malformed escape now 404s instead of throwing) and an extra `qa_report` run event/`result.qa` field.

## E. Tests run with actual results
(see section H for the table; every number below was read from the command's own output)

| # | Command (run in this worktree) | Result as printed |
|---|---|---|
| 1 | `pnpm exec turbo run build --filter='@nuzm/api^...' --concurrency=2` | 21 successful, exit 0 (cached) |
| 2 | `tsc -p apps/api/tsconfig.json --noEmit`; `tsc -p packages/domain/tsconfig.json --noEmit` | both exit 0 (run on the tree before the last two spec-only edits to `templates-qa.spec.ts`; that file was then executed by vitest) |
| 3 | `eslint apps/api/src/modules/builder packages/domain/src/builder/templates` | exit 0, no output (before the last two spec-only edits; prettier clean) |
| 4 | API unit: `vitest run src/modules/builder` (first full run, before the template/QA-evidence edits) | 11 files, 106 tests passed |
| 5 | API unit: `vitest run src/modules/builder src/common/site-css.spec.ts` (final tree, machine load average ~600) | 11 files passed; 2 files failed: `live-preview-route.spec.ts` (hook timed out at 10 s, load) and `templates-qa.spec.ts` (restaurant timed out at 120 s, load; landing: a REAL axe warning `image-redundant-alt`, see F). 113 tests passed, 4 skipped (the live-preview file) |
| 6 | Re-run of those two files with `--hookTimeout=120000` after fixing the landing template | 2 files, 12 tests passed |
| 7 | `P3_S04_AXE_ALL=1 vitest run …/templates-qa.spec.ts` (axe-core on jsdom, all 8 templates, ar+en, 0 errors AND 0 warnings required) | 15 of 16 passed; the 16th (landing) failed on a wrong assertion in my own spec (expected 10 pages, landing has 2); spec fixed, landing re-run: 2 passed. Net: all 8 templates QUALIFIED |
| 8 | DB-backed: `NUZM_TEST_ADMIN_URL=…:54354 vitest run --config vitest.integration.config.mts src/modules/builder` (own Postgres) | 3 files, 34 tests passed, exit 0 (all of Phase 2 `builder.int.spec.ts` + `p3-s04.int.spec.ts` + `p3-s04-t1.int.spec.ts`) |
| 9 | `packages/domain`: `vitest run src/builder` (after the template change) / `src/builder/templates` (after the landing fix) | 330 passed (9 files) / 67 passed |
| 10 | `apps/api` site-css + edit-schema; `apps/web` `lib/templates` | 12 passed; 11 passed |
| 11 | CLI `build-site.cli.ts retail <dir> --base-url … --forms-base …` then `website-qa.cli.ts <dir>/site --min-pages 5 --require-slugs home,contact` | `QUALIFIED (10 pages, 21 files, 108625 bytes)`, artifact `b556e9971b8c712159be9cce3671664a4ed9dec6450338cb7da85aadb9e8acf7`; every gate PASS incl. a11y-axe (10 pages checked); 3 SEO warnings, which the template fix then removed |
| 12 | `preview-domain.cli.ts` offline / with `--live` | exit 3: config PASS, dns/tls/isolation `NOT VERIFIED` / exit 2: refused (`PREVIEW_DOMAIN_LIVE_APPROVED=B-DOMAIN` not set) |

Mutation corpus (`qa.spec.ts`, 42 tests, all passed on the first run): 33 targeted defects (missing/mismatched lang, no viewport, zoom blocked, two h1, skipped heading, unlabelled input, nameless link, duplicate id, inline script/handler/style attr/style block, third-party script and stylesheet, `javascript:` URL, CSS `@import`, form posting elsewhere, broken link, `_blank` without noopener, oversized stylesheet, physical-direction CSS, Arabic page with `dir=ltr`, untranslated Arabic page, low-contrast tokens, no description, duplicate titles, noindex on a published page, broken JSON-LD, remote image, SVG with a script, fake PNG, missing locale page, no home) each make exactly their gate fail with the expected code, plus CSP-evaluator and weak-policy cases. axe: finds `aria-roles`/`select-name`/`button-name` in both languages and does not execute the page's own script (a script that would remove `lang` does not trigger `html-has-lang`).


## F. Security, tenant isolation, billing, residency
- **Defect found and fixed**: `PreviewService.serve` threw `URIError` (a 500, an oracle distinguishing it from the uniform 404) on a malformed percent-escape in the path (`%`, `%zz`, `%E0%A4%A`). Found by the new tamper corpus; fixed (`try/catch` → the same plain 404); regression covered in `preview-tamper.spec.ts`.
- Tamper corpus (all 404, byte-identical to the unknown-token 404): every single-character substitution of a token (32×31), malformed tokens (length, case, alphabet, NUL, SQL-ish) with **zero database calls**, 14 host/token/expiry/revoked/deleted/other-preview cases, 20 path tricks (`..`, encodings, double encoding, backslash, NUL, absolute, other project, overlong UTF-8). Cross-tenant: org A's preview reads only org A's project and the DB scope is the preview's own org.
- Tenant: `VersionArtifactService` reads under `withOrg` (RLS); another organization gets `not_found` for manifest/files/qa/compare (integration test).
- Billing/metering: unchanged (`builder.build_minutes` is emitted by `commitVersion` as before; QA reads only). QA is not a billable action. No model is called by anything S04 added.
- Residency: nothing S04 added moves data or calls a vendor.
- Honesty control: evidence label downgrade/validator (see C.7).
- **Template findings fixed by the gates** (`packages/domain/src/builder/templates`, 8 templates, version 1 → 2): inner-page SEO titles had no business name (`About us`, 4–9 characters), so 16 pages carried length/brand warnings and some had descriptions under 50 characters; `defineTemplate` now composes `<page> | <business>` (kept ≤ 70 characters; home headline untouched), four short Arabic descriptions were lengthened, and the landing template's Arabic gallery alt duplicated its visible caption (axe `image-redundant-alt`). Result: all 8 templates, ar+en, 0 errors and 0 warnings.
- Ownership note: `packages/domain/src/builder/templates/**` is not named in any session's row of the Phase 3 plan; S04 treated it as "website templates" (its scope). If the Master assigns it elsewhere, revert only that directory; nothing else depends on it.
- Honest limit of the axe gate: jsdom has no layout, so `color-contrast`/`target-size` are NOT evaluated by it; contrast is decided from the design tokens (`contrast` gate, all pairs ≥ 4.5:1) and the rendered check is the browser runner (NOT VERIFIED).

## G. Human gates and live checks still needed
- W1 live generation: needs S01 live gateway + S03 loop + the provider approvals (D2/D5…) in `OWNER-APPROVAL-PACK.md`. **NOT VERIFIED.**
- Real preview on a real domain (W2 in a browser, ar+en): needs B-DOMAIN (domain + wildcard certificate) and the E2E stack; the browser E2E belongs in `e2e/tests/p3-*.spec.ts` (S08). **NOT VERIFIED.**
- W4 against a real deploy target: S07. **NOT VERIFIED.**
- Browser-based QA (`--browser`: axe with layout/contrast, CSP as enforced, RTL, overflow): implemented; not run because the heavy lock is held by the Phase 2 regression. **NOT VERIFIED.**
- ADR-060 §8 network isolation of the preview process: infrastructure, unprovable from code (HG-12-01).

## H. Acceptance checklist
| Row | Status | Evidence / what is missing |
|---|---|---|
| W1 (T1 part 1): real model builds a ≥5-page ar+en business site passing axe 0, links, CSP, size | **NOT VERIFIED** (BLOCKED: S01 live gateway + S03 loop + provider approvals) | What exists and passes: the gates (PASS: 8 shipped templates are QUALIFIED with 10 pages/locale-pair, axe 0, 0 warnings), the harness (SIMULATED PASS: two synthetic briefs, ar and en, drive the real `website` run kind with the mock model to a stored version; the run result carries the QA summary; the evidence record is labelled SIMULATED and refuses to claim LIVE). No claim is made about what a real model produces. |
| W2: real preview on the isolated origin; tamper/other-host/expired/revoked → 404; cookies ignored; browser E2E ar+en | Deterministic decision table **PASS** (`preview-tamper.spec.ts`, 8 tests, plus Phase 2 `builder.int.spec.ts` preview tests passing on the DB). Real URL on a real domain and browser E2E ar+en: **NOT VERIFIED** (B-DOMAIN; E2E belongs to S08, heavy lock held) | One real defect found and fixed (F). |
| W3: edit-by-prompt is a minimal diff, new version, restore works | Measurement, versioning and restore **PASS** on the real DB (one-text edit → verdict `minimal`, other files byte-identical; restore → NEW head whose artifact hash equals the original; `rewrite` is refused with actionable text). Edit-by-prompt driven by a REAL model: **NOT VERIFIED** (S01/S03). The Phase 2 edit run kind with the mock still passes. | `p3-s04.int.spec.ts` |
| W4: artifact hash matches what the deploy target serves | Stored-version manifest equals a fresh static build **PASS**; the preview service as a (simulated) target serves byte-identical files, `verifyServedArtifact` PASS, and catches a tampered/missing file **PASS**. A real deploy target: **NOT VERIFIED** (S07). | `artifact.spec.ts`, `p3-s04.int.spec.ts` |
| W5: offline path unchanged, Phase 2 website/builder suites green | **PASS**: builder integration 34/34 incl. all Phase 2 builder tests; builder unit green after re-runs; domain builder 330/330. Only additive changes to existing paths (event + result field, template SEO text). | rows 5, 6, 8, 9 above |
| Browser QA (axe with layout/contrast, CSP as enforced, RTL, overflow) | Implemented; **NOT VERIFIED** (not run: heavy lock held, no browser run allowed) | `browser-qa.ts`, `website-qa.cli.ts --browser` |
| Preview domain / TLS / DNS | Workflow **PASS** offline (12 tests); live checks **NOT VERIFIED** (B-DOMAIN) | `preview-domain.spec.ts` |
| Preview AI-branch vs published UI | **NOT DONE** (deferred with reasons) | NOTE-P3-S04-preview-comparison-ui.md |

## I. Next-milestone handoff and open decisions
- Master: apply CONTRACT-P3-S04-1 (devDependencies `axe-core`/`jsdom`, three root scripts, three read-only routes + SDK, optional `html-scan` export, E2E hook-up).
- S03: call `buildWebsiteArtifact`/`runWebsiteQa` after each generation and feed `repairFindings`; the run already reports a QA summary.
- S07: use `verifyServedArtifact(manifest, httpFetch)` against the release URL; `manifest.rootHash` is the binding.
- S08: accept `nuzm.website-qa/1` and `nuzm.evidence.website/1` verbatim; own the browser E2E of previews.
- R-1 (renderer, shared): page `<title>` has no business-name suffix (e.g. `من نحن`, 9 characters; SEO best practice is `Page | Brand`); 3 template titles/descriptions fall under the QA length warnings. A renderer change alters Phase 2 snapshots, so it needs a Master decision.
- R-2: "AI branch vs published" side-by-side UI deferred (see NOTE-P3-S04-preview-comparison-ui.md).

## Addendum (after the first batch)
- DEFECT-18 (owner S04): the percent-escape fix has a regression test in the Phase 2 builder integration suite (`builder.int.spec.ts`, preview describe; passes on :54354) next to the unit corpus. Registered by the Master; re-verified by S08.
- Master assigned `packages/domain/src/builder/templates/**` to S04.
- Draft of the W2 browser/HTTP-edge negative cases for S08 (not run, needs the isolated E2E stack): `DRAFT-p3-s04-preview-isolation.spec.ts.txt`. The existing `10-builder-customer.spec.ts` already covers the framed preview, sandbox attribute and viewport widths in ar and en.
- Quiet window: S04's Postgres (:54354) is stopped; nothing heavy was run after the batch above.


## Addendum 2 (heavy window): final typecheck and the first real-browser QA run

- Branch merged with `integration/ai-engine` (clean). `pnpm typecheck` in `apps/api` through `heavy-slot.sh`: exit 0 (before the runner edit below; the runner edit is re-checked in the next slot).
- Browser QA runner, FIRST RUN (LIVE-VERIFIED locally: Chrome 158.0.8127.88, axe-core 4.14.0, loopback server, 10 pages x 2 viewports, services template): FAILED. One real finding, `label-content-name-mismatch` on the language-switch link (WCAG 2.5.3), 15 reported loads. Renderer file, so requested in `CONTRACT-P3-S04-2-language-link-accessible-name.md`. The jsdom gates had passed this artifact: the browser run adds real coverage.
- Runner defect found and fixed by this run: `nav_order` false positive (footer links included); failed responses now report their URL. One unexplained console 404 seen once, not reproduced.
- Only the `services` template was run in the browser; the other 7 templates and the W2 browser E2E are still NOT RUN.


## Addendum 3: DEFECT-21 (language link name) and DEFECT-22 (favicon 404), both owner S04, fixed

Ownership of `packages/domain/src/builder/render/**` was assigned to S04 by the Master with `templates/**`.

### DEFECT-21: language-switch link failed WCAG 2.5.3 Label in Name (found by the real-Chrome pass)
- Cause: `render/page.ts` gave the switch link `aria-label="تغيير اللغة"` / `"Change language"` while its visible text is the other language's name ("English" / "العربية"). jsdom axe and the Phase 2 E2E do not compute the rule.
- Fix: the `aria-label` is removed (the link's name is its visible text, and `lang`/`hreflang` state its purpose); the unused `switchLabel` string was removed from `render/ui.ts`. No other `aria-label` on a link/button exists in the renderer (the `<nav aria-label>` landmarks are not links).
- Regression test below the browser: `render/label-in-name.spec.ts` (every labelled link/button on every page of all 8 templates, ar + en, names its visible text; non-vacuity case proves the checker flags the old markup). No Phase 2 snapshot or golden test encoded the attribute (none changed).

### DEFECT-22: every generated site 404'd `/favicon.ico`
- What it was: no page declared an icon, so browsers request `/favicon.ico` and the host answers 404. Proven (not only inferred): with the icon removed from a built `services` and a built `clinic` artifact, the runner's server-side miss list names exactly `/favicon.ico` for both (`browser.favicon_missing`).
- Why `clinic` looked clean in the first all-template pass: it did not differ in content. Chrome logs the failed favicon request as a console error only when the request completes inside the page's observation window, which is a race; with the icon removed, `clinic` showed the console 404 again in one run and `services` did not. The runner now reports the missing path from the server's own request log, which is deterministic, and the console-error rule is unchanged (no filtering, no relaxation).
- Fix (generator): the renderer emits `assets/favicon.svg` (the first letter of the brand name in the default locale on the palette's primary colour; deterministic, text only) and every page, including the root redirect, declares `<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">`. First attempt, an inline `data:,` icon, was rejected by the renderer's own URL validator (it forbids `data:` URLs), so it was not used.
- Guards: (1) QA structure gate `structure.favicon_missing` (error) + a mutation case in `qa.spec.ts`; (2) render-level `render/references.spec.ts`: every page declares an icon, and every `href`/`src` a page references resolves to a file in the artifact (form actions must be the platform forms endpoint); its non-vacuity case removes the favicon file and strips an icon and requires both to be caught.

### Verification (printed results; real Chrome 158.0.8127.88 + axe-core 4.14.0, local loopback server, no network, no provider)
| Check | Result |
|---|---|
| Real-Chrome pass, all 8 templates, 375 + 1280 px, ar + en (restaurant, clinic, retail, portfolio, services, education, ngo, landing) | 8 of 8 `PASSED`: 0 errors, 0 warnings; page loads 20 each (landing 4), 164 in total |
| Same pass before the fixes | 7 of 8 failed with the console 404 (clinic passed by the race above); `services` also had 15 label-in-name findings |
| `packages/domain` `vitest run src/builder` | 347 passed, 8 failed (only my first draft of `references.spec.ts`: it treated the form action as an artifact file). Fixed; `src/builder/render` 228 passed; `references.spec.ts` 9 passed |
| `apps/api` qa specs (qa, artifact, evidence, templates-qa) | 69 passed (4 files) |
| `tsc --noEmit` `packages/domain`, `apps/api` | exit 0, exit 0 |

Caveats, stated plainly: the CLI runs used `--no-axe` for the jsdom pass only (the run says "PASSED WITH GATES SKIPPED" for that reason; real-Chrome axe ran in the browser pass); templates were run with the offline build only (no model), so this is evidence about the renderer and the shipped templates, not about model-generated sites (W1 is still NOT VERIFIED). The Phase 2 domain suites outside `src/builder` and the full `apps/api` suite were not re-run after the renderer change.
