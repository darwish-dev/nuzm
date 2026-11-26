# AI Builder: fixes from customer manual testing (2026-11-26)

Local only. Nothing was pushed or deployed. **No billed AI request was made** for this work (live calls stayed off everywhere; every model call in tests used the mock model).

Commits on local `main`: `0dd98537` (limits, errors, library, preview), `da8cff7a` (library relevance), `fbfd3d8e` (failure texts in the web-app and mobile workspaces), and the commit that adds this report.

## 1. Root cause of the failed customer run
| Item | Finding |
|---|---|
| Run | `01a214f2-b62d-730c-8e3e-f9ebb584060b`, organization **nuzm**, kind `website`, 2026-11-26 02:03 (+03:00), failed after 0.2 s at step `requirements` |
| Recorded error | `service_unavailable`: "the model providers are unavailable (unavailable: live calls to this model provider are not approved in this environment)" |
| **Root cause** | The local platform runs with live model calls **off** (`NUZM_PLATFORM_LIVE_PROVIDERS` unset → `AI_LIVE_PROVIDERS` empty), the agreed default. The Claude adapter refused the call before reading the key or sending anything (`anthropic.ts` live gate); the gateway reported that refusal as a generic provider outage and counted it toward the provider's circuit breaker. |
| Checked and in order | Claude provider row: enabled, attested (2026-11-19), key reference stored; flags `ai.enabled` (platform), `app_builder.enabled`, `knowledge.customer_templates`, `knowledge.generation` (nuzm) on; wallet 497,914 credits; worker and API running; usage row: 0 tokens, 0 credits (nothing was charged) |
| Second finding | The run's stored `input.description` is **600 characters** and ends mid-sentence ("Create a"). The customer's text was cut in the browser by the start screen's `maxlength=600` before it was sent; the original text was never stored and cannot be recovered. |

## 2. What was fixed
### 2.1 Prompt limits (no truncation anywhere)
| Layer | Before | After |
|---|---|---|
| Shared constant | none | `PROMPT_LIMITS` (`packages/domain/src/builder/prompt-limits.ts`): project description **30,000**, follow-up message **20,000**; console mirror in `apps/web/lib/appbuilder.ts`, a test keeps them equal |
| Start screen (all types) | 600, HTML `maxLength` silently cut pasted text | 30,000, no `maxLength`; counter `n/30000`; over the limit is an error |
| Chat (website / mobile / web app) | 2,000 / 600 / 8,000 with `maxLength` | 20,000, no `maxLength`; a visible "too long" message, Send disabled |
| Mobile start, lifecycle, app progress, template plan and recommendation boxes | 600 / 4,000 / 8,000 / 2,000 (cut) | 30,000, refused not cut |
| API validators | website 600, mobile 600, web app 4,000, lifecycle 4,000, edit 2,000, recommendation/plan 2,000 (and a silent `slice(0, 2000)` of the stored plan requirement) | 30,000 for first descriptions and plans, 20,000 for edits; stored whole |
| AI engine | data block cut at 20,000 with no marker; template context cut the requirement at 4,000 within a 12,000-token pack and could drop it; params cut at 2,000 | data block bound 64,000 with an explicit "N more characters were not included" marker; the context pack always includes the whole requirement and grows its budget by the requirement's size (ceiling 60,000 tokens); a long param is a pointer to its data block, never a cut copy; model fit is decided by routing (context window) |
| Website generation | architecture and pages saw only the model's 600-character summary | they also receive the whole description as data |
| OpenAPI / SDK / docs | 2,000 / 20,000 / prose 600 and 4,000 | 30,000 / 30,000, prose updated; SDK and API docs regenerated |
| Database | no length constraint on prompts (only the 200-character session title) | unchanged; nothing needed |

### 2.2 Actionable errors instead of `service_unavailable`
- A live-gate refusal is now `LiveCallsNotApprovedError` (adapters for Claude, OpenAI, Gemini). The gateway does not count it toward provider health or the circuit, and answers **`ai_provider_not_enabled`** (503, registered in `spec/openapi/errors.yaml` and `errors.ts`): "no AI model provider is enabled for live calls in this environment; nothing was sent and nothing was charged".
- Arabic and English customer texts (`bld.err.ai_provider_not_enabled`), shown on the canvas, in the website run card, and in the web-app and mobile run cards (which showed the raw English server message before). Other known codes (credits, residency, content, secrets, kill switch) get their localized reason the same way.
- Security and billing controls are unchanged: the live gate still refuses; budgets and reservations behave as before (a reservation is taken and released, 0 charged).

### 2.3 Knowledge Library on the first prompt
Before: **no** free-text start (website, web app, mobile) consulted the library; only the explicit template gallery did.

Now, for a website or web-app description with no imported source and no built-in starter chosen:
1. The start screen asks `POST /v1/builder/template-recommendations` with the **whole** description and `minFunctionalCoverage: 0.4`.
2. The server's existing hard filters apply (only ACTIVE versions of `PLATFORM_PUBLISHED`, licence-`ALLOWED`, reuse-permitted platform templates; quarantined, unpublished or other organizations' resources are never candidates), then scoring and the AUTO_SELECT threshold. **New:** a pick whose functional (text) coverage is below the requested share is dropped (`GENERATE_FROM_SCRATCH`, note `below_functional_coverage`).
3. A selected template starts the project from its source (`from-template`: copy with integrity checks), a generation plan holds the whole description as its requirement, and one template-adaptation run sends the template's files (only when the template allows AI processing) and the requirement to the model.
4. No selection: the project is generated from scratch in the type the person chose, as before.
5. Recorded: every recommendation is audited (`knowledge.template.recommended`: strategy, reason codes, selected template, version, score, confidence and components, the scores of the top three considered, the number of eligible templates, the text length; never the text), plus the existing `RECOMMENDED` usage events, the plan (selection, score, considered), `knowledge.template.copied` and `knowledge.plan.run_started`.

Assumption recorded: when a library template is selected for a *website* request, the project becomes a code (web-app) project built from that template, because the section-based website builder cannot use template source. This is reversible (the coverage threshold is a constant in the start screen; 1 disables automatic selection in practice).

### 2.4 Preview no longer shows the prompt as a generated site
Cause: creating a website commits a starter site model as version 1 whose brand, page title and hero heading are the project name, which the start screen takes from the first six words of the description. The workspace rendered that head version like any result.

Now:
- The project detail returns `versionSource` (`system`, `template`, `ai`, `user`, `restore`).
- While the site is still its starter, the canvas shows the generation state instead: *Generating your site* (with the stages in the chat), *Waiting for your approval*, *The site was not generated* with the localized reason and "your description and project are saved", or *No generated content yet*. The starter can be opened on request under a banner "This is the starter layout of the project, not AI-generated content".
- A generated site is named after the requirements' `businessName` (e.g. the agency's name), not after the project name taken from the description.
- The deferred sandbox and live preview are untouched (web-app live preview still says it is not enabled).

## 3. Test evidence
| Suite | Result |
|---|---|
| Unit: domain, web console, i18n, UI, model adapters, API | all pass (domain 1,889 + 6 new; console 1,060; API 2,168 after updating 1 test of the old 20,000 limit; adapters 298) |
| Integration (isolated test database): AI, builder, knowledge, app builder, mobile | 643 pass after fixes; the 5 failures of the first run were 3 tests encoding the old limits and 2 mistakes in the new tests, all fixed and re-run (76/76 in those files) |
| New tests | 30,000-character website description stored whole and reaching the requirements and architecture calls with its last words (mock model), 30,001 refused, edit 20,000/20,001, chat message 20,000/20,001, site named after `businessName`, `versionSource` starter → ai; live gate → `ai_provider_not_enabled`, repeated 7 times with the circuit staying closed, no upstream call, no charge; recommendation audit and the coverage rule; canvas states; console/API limit equality; data block and context pack keep a 30,000-character text whole |
| `TURBO_FORCE=true pnpm verify` | PASS (section 5) |

### Customer-facing check in the browser (local console, disposable database `nuzm_tpl_e2e`, live calls OFF)
| Step | Result |
|---|---|
| Paste a 14,247-character synthetic agency brief (ends with `FINAL-REQUIREMENT-ZX9`) | box keeps all of it, counter `14247/30000` |
| Start as Website (first build) | the library auto-selected the café template for the agency brief (functional coverage 0.075: 1 of 12 term groups) and the project became a café web app: **defect found and fixed** (`da8cff7a`, coverage rule) |
| Start again after the fix | project stays a **website**; recommendation audited as `GENERATE_FROM_SCRATCH` with reasons `auto_selected, below_functional_coverage`; run `01a2152b-9167-…` stored the description **whole (14,247 characters, marker included)**; run failed with **`ai_provider_not_enabled`**; usage row 0 tokens, 0 credits; canvas shows "The site was not generated" with the localized reason; the starter only on request, under its banner |
| Café brief (152 characters) | library selected "Synthetic Cafe Starter" (score 72.9, coverage 0.43: 5 of 10 term groups); project created from the template (14 files), plan with the requirement, one adaptation run → failed with `ai_provider_not_enabled`, 0 tokens, 0 credits |
| Web-app workspace failure text | was the raw English server message, and the timeline squeezed reasons into a 22 px column: **fixed** (`fbfd3d8e`) |
| After `fbfd3d8e` (rebuilt, rechecked) | web-app run card shows the localized reason; the timeline reason is readable (104 px, was 22 px); the website failure screen checked in Arabic (right-to-left) and English |

## 4. Remaining blockers and limits
| Item | State |
|---|---|
| A real generation with Claude through these paths | **NOT VERIFIED**: needs your approval of billed calls (live calls are off). Suggested bound for one website run (requirements, architecture, approval, pages): several calls, not one; an estimate must be prepared per path before any approval |
| Build, sandbox and live preview of generated code | **BLOCKED** (D-21, HG-10-02, ADR-069): next milestone |
| Semantic (embedding) template search | BLOCKED (D-47); matching is keyword/metadata based, so relevance depends on the template's words. The coverage threshold (0.4) is a first value to tune with real templates |
| Website requests matched to a library template become code projects | product decision to confirm (section 2.3) |
| Web-app timeline "failed" event still lists the server's English reason (now readable) | minor; localized in the run card |
| The customer's original description of run `01a214f2…` (longer than 600 characters; its length is unknown) | lost in the browser before it was sent; not recoverable |

## 5. Verification run
`TURBO_FORCE=true pnpm verify` on `fbfd3d8e` (no cache replay): **PASS**, exit 0. Lint and typecheck 57/57 tasks, **6,366 unit tests, 0 failed**, build, spec lint and drift (all routes declared), SDK check, API docs, secret scan, ZATCA guard, claims guard, testenv 31/31. Log: `.dev-data/verify-runs/20261126T001530-builder-fixes/`.

Platform after the checks: back on your `nuzm_local`, live calls **off**, all 8 health checks OK. The disposable `nuzm_tpl_e2e` keeps the test projects of section 3.
