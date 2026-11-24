# Phase 2 E2E specs written by other sessions: strength review (Session 07, read-only; none was run by me)

Reviewed on `integration/ai-engine` (a423e75a merge): `19-ai-benchmarks.spec.ts` (S03), `19-builder-agent.spec.ts` (S05), `10-ai-provider-insights.spec.ts` (S02). All three say "written, NOT RUN"; until the Master's isolated E2E has passed they are **NOT VERIFIED**. No browser was started by me.

## Strengths (real assertions, keep)
- Every state has `audit()` (axe WCAG A/AA + direction/language + screenshot) in ar and en.
- Benchmarks: flag off → no record button; flag on → five stages all BLOCKED, rate marked unconfirmed, exact integer maximum (`83.60 USD`); recording is OFFLINE_REFERENCE_ORACLE only; seven-dimension scorecard; support is read-only; finance is forbidden with no nav entry; roles and flag restored in `finally`.
- Builder agent: flags off → the start says "not enabled" AND `ai.runs` count stays 0; parked/failed/finished states; failure shown in words (`repair_exhausted` never in the DOM); SIMULATED label on every result.
- Insights: exact integers beyond 2^53, mixed currencies not summed, rate-card history, discovery refused (no live call), support has no discovery section, finance gets the forbidden state.

## Weak assertions and missing negative cases (to add; none blocks the run)
| # | Spec | Finding | Suggested change |
|---|---|---|---|
| E-1 | benchmarks | `card.getByText('100').first()` passes for any "100" in the card (a threshold, a header) | assert the cell of the functional-dimension row by role/name |
| E-2 | benchmarks | the OFFLINE label is asserted present but nothing asserts that no "live"/"verified" wording appears for an offline run | add `expect(runs).not.toContainText(/LIVE-VERIFIED/)` (language-neutral id) |
| E-3 | benchmarks | read-only is asserted only by the missing button; the API refusal for the same role is not exercised | one `fetch` as the support session: record endpoint answers 403 (the API test exists; add it to the UI session) |
| E-4 | benchmarks, insights | the unauthenticated case (no session → redirect to login) is not covered | `page.context().clearCookies()` then goto: expect the login page |
| E-5 | builder agent | all run states are written with SQL, so only RENDERING is proved; the real flow is proved by `builder-lifecycle.int.spec.ts` and my `qa-agent-loop-http.int.spec.ts`, not by the browser | acceptable if stated in the report (it is) |
| E-6 | builder agent | no role negative: a viewer must see no start form/cancel button, an owner/admin only gets the approve link, a developer/billing admin cannot decide | add a viewer visit of the same `?run=` URL |
| E-7 | builder agent | no cross-tenant case: org B opening `?run=<org A run>` must show not-found/forbidden and no step names | add a second context signed in as another organization |
| E-8 | builder agent | no malformed id: `?run=not-a-uuid` and a non-existent run must show the error state, not a blank or a stack trace | add both URLs |
| E-9 | builder agent | fixture inconsistency: `lifecycle_started {steps: 18}` but progress `total: 14` and 13 listed steps | align the fixture to the runner's real events (cosmetic) |
| E-10 | builder agent | no check that the event stream/screen shows no project text, prompt or model output | add a run whose step summary contains a marker string and assert the marker is not in the DOM unless it is a declared summary field |
| E-11 | insights | health/registry are asserted as "loaded" (`data-state="ok"`), which an empty state also satisfies | acceptable; the content depends on process history (stated) |
| E-12 | insights | "support cannot ask the provider" is proved by the missing section only | same API-level check as E-3 for discovery |
| E-13 | all | each spec rewrites the staff user's platform roles; a crash between `setRoles` calls and `finally` leaves that user restricted for the next spec | the `finally` blocks restore it; keep them |
I did not add E2E specs for E-3 to E-12 because I may not run browsers during the regression; I will write them once the Master releases the heavy slot, as a separate file so the three reviewed specs stay untouched.
