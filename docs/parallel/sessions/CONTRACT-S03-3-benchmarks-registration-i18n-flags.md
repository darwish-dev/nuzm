# CONTRACT-S03-3 — module registration, feature flag, environment, i18n keys and navigation

- **Requester:** Session 03 · **Status:** REQUESTED
- **Contract:** `apps/api/src/app.module.ts`, `packages/i18n/src/messages.ts`, `apps/admin` navigation, platform feature flag seed
- **Additive?** Yes. **Sessions affected:** 01 only.

## 1. Module registration (one line each)
```ts
import { BenchmarksModule } from './modules/benchmarks';   // add to the imports list and to @Module({ imports: [ ..., BenchmarksModule ] })
```
`BenchmarksModule` imports `IdentityModule` and `AccessModule` like `AiModule`, reads the `DB` token and `AuditSink`, registers `AdminBenchmarksController` (`/v1/admin/ai/benchmarks`). Until registered the module is inert.

## 2. Feature flag and environment (all default OFF)
- `platform.feature_flags` global row `ai.benchmarks` (value `true` or `{enabled:true}`): the whole API answers `kind_not_available` (422) and the overview answers `{ enabled:false }` while it is absent. No seed is added (default off).
- `BENCHMARK_LIVE_ENABLED` (env, default unset = off) and the existing `AI_LIVE_PROVIDERS` (D3) are read by the live-run PREFLIGHT only; even with both set, no capture source exists in this build, so a live run cannot start. `NUZM_ENV` names the environment for that preflight.

## 3. i18n
The dashboard keeps its Arabic/English texts in `apps/admin/lib/benchmarks-text.ts` (typed dictionary, same placeholders in both languages, tested). At integration, move them to `packages/i18n/src/messages.ts` under the prefix `bench.` (keys = the dictionary keys) for both `ar` and `en`, and replace `bt(locale, key)` by `t(locale, 'bench.<key>')`; the dictionary file and `benchmarks.spec.ts` then become a key-parity test.

## 4. Navigation
Add a tab `benchmarks` (`/{locale}/ai/benchmarks`) to `apps/admin/components/AiAdminTabs.tsx` (the page exists at `apps/admin/app/[locale]/(console)/ai/benchmarks/page.tsx`; it renders without the tab until then) and `aia.tab.benchmarks` in `messages.ts`.

## 5. E2E and screenshot (UI rule in CLAUDE.md §4) — for Session 07 / the heavy slot
An e2e spec for the admin page (Arabic and English): open `/ai/benchmarks` as a platform admin with the flag on; expect the "not a model" banner, the PROPOSED thresholds, the empty runs state; click "Record" with source `reference`; expect a run row labelled "Reference oracle (not a model)". Plus a viewer-without-permission case (forbidden state). Screenshot per locale. Not written by Session 03 (e2e files are not in its ownership; nothing may be run in the parallel phase).
