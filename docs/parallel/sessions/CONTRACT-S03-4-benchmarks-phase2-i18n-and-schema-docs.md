# CONTRACT-S03-4 — Phase 2 benchmark texts and (optional) schema documentation

- **Requester:** Session 03 · **Status:** DEFERRED by the Master 2026-11-24 (non-blocking: texts stay in `apps/admin/lib/benchmarks-text.ts`; OpenAPI documentation of the already-travelling fields is a later, additive change)
- **Contract:** `packages/i18n/src/messages.ts` (new `bench.*` keys), `spec/openapi/openapi.yaml` (documentation only)
- **Additive?** Yes. **Sessions affected:** 01 (Master), 07 (the E2E may then assert the new texts by catalogue key).

## 1. i18n: fold the Phase 2 texts into the catalogue
The staged plan and the scorecard of `/ai/benchmarks` use 55 texts that live, for now, in `apps/admin/lib/benchmarks-text.ts` (`EXTRA_TEXTS`, Arabic and English, same placeholders, parity tested in `apps/admin/lib/benchmarks.spec.ts`). They are kept in an owned path because Phase 2 forbids editing `messages.ts` outside a recorded exception, and an app cannot be imported by the E2E (lint rule), so the new E2E spec asserts those sections by structure.

When convenient: append the keys under `// >>> Benchmarks (S03)` as `bench.<key>` in `ar` and `en` (the object `EXTRA_TEXTS` is the source; both languages are complete), then in `benchmarks-text.ts` delete `EXTRA_*` and the `isExtra` branch of `bt`. Key names (55): `stagesTitle stagesHelp rateReference rateApproved stage runCount estimated maximum duration durationValue stageStatus stageBlocked assumptionsNote prerequisites monthly stageName_A..E stagePurpose_A..E prereq_<13 ids> scorecardTitle scorecardHelp scorecardEmpty dimension value thresholdsJudging dim_<7> statusPass statusFail statusNotMeasured`.

## 2. OpenAPI: documentation of fields that already travel (no behaviour change, no SDK regeneration needed)
`AiBenchmarksOverview`, `AiBenchmarksAction` and the run detail are `additionalProperties: true`, so the following already validate. If the Master wants them documented (and typed in the SDK):

- `AiBenchmarksOverview.live`: add `stages` (object): `rateBasis {model|null, source, status}`, `prices {currency, input, output}`, `assumptions {usagePermille, inputSharePermille, meanTaskSeconds, maxTaskSeconds, status, basis}`, `plans[]` (stage A-E: `tasks runs models currency max{tokens,requests,costMinor} estimate{tokens,tokensIn,tokensOut,costMinor} duration{estimatedMinutes,maximumMinutes} minimumBudgetCaps problems`), `definitions[]` (`id title purpose selectionRule prerequisites exitCriteria`), `monthly {cadence, estimateCostMinor, maxCostMinor, maxTokens}`.
- `AiBenchmarksAction` for `set_budget`: optional `price {minorPerMillionInput, minorPerMillionOutput (positive integer strings), source (text)}`; for `attempt_live_run`: optional `stage` (`A`..`E`, default `A`). Response of `attempt_live_run`: `{started:false, stage, refusals[], entry{canStart, missing[]}, plan}`.
- Run detail `GET /v1/admin/ai/benchmarks/runs/{id}`: `scorecard[]` (`dimension value unit tasks detail thresholds[{id,status}]`).

## 3. Why it is safe
No route, path, method, status code, permission or table changed; `pnpm spec:drift` is unaffected. All amounts are integer minor-unit strings.
