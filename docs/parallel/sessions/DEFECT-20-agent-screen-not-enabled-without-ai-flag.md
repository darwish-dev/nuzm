# DEFECT-20 — the builder agent screen (E2E `19-builder-agent`) showed "The app builder is not enabled" instead of its form

Reporter: Master (Phase 2 isolated E2E on the merged head, 8 failures = 4 specs × ar/en) · Owner: Session 05 · Severity: **LOW**. Status: **FIXED (fixture) and RE-TESTED; two real but cosmetic product findings fixed or listed**.

## What the page did before
`GET {web}/{locale}/builder/projects/{id}/agent` rendered only the "not enabled" state (`m10.notEnabled.title`, "The app builder is not enabled"): no project title, no heading `bt.lc.title`, no start form. Not blank, not a redirect, not an error page: a 200 page with that one state.

## Root cause (exact)
- The web page reads the project with `GET /v1/builder/projects/{id}`.
- That controller is guarded by `@UseGuards(AiEnabledGuard)` (`apps/api/src/modules/builder/projects.controller.ts:31`); with the organization's `ai.enabled` flag off the guard throws `not_found` (`apps/api/src/modules/ai/internal/ai-enabled.guard.ts:14`), so the API answers **404**.
- `bview` (`apps/web/lib/builder-gate.tsx`) turns every 404 from a builder call into `NotEnabledState`, which is what the page showed.
- The E2E fixture (`19-builder-agent.spec.ts`, and S07's `qa-negatives.spec.ts`) switched on only `app_builder.enabled`, `builder_tools.enabled`/`builder_lifecycle.enabled` and never `ai.enabled`. Every other builder E2E (`10`, `16`, `17`, `18`) sets `ai.enabled`.
- So the route, the workspace tab, the i18n keys and the org context were all fine. The screen did exactly what the flags said: fail closed. It is a FIXTURE defect, not a rendering defect; I said earlier "the page now renders" meaning "the fixture now reaches it".

## Fix
- `e2e/tests/19-builder-agent.spec.ts` and `e2e/tests/qa-negatives.spec.ts`: set `ai.enabled` (the 19 spec clears it at the end).
- Regression test BELOW the browser: `apps/api/src/modules/appbuilder/builder-lifecycle.int.spec.ts` › "DEFECT-20 …": for a web-app project `GET /v1/builder/projects/{id}` and the project list answer 404 while `ai.enabled` is off for the organization and 200 once it is on. (It pins the gating the E2E depends on; it fails if the guard or its default changes. There is no product code change for it to fail without.)

## Product findings the real run exposed (not the cause of the failure above)
1. **Duplicate heading (fixed).** With a run open, the page's `h2` `bt.lc.title` and the run panel's own `h2` carried the same text: two equal headings (confusing for a screen reader, ambiguous for locators). The panel now uses the new key `bt.lc.run.heading` ("Current run" / "التشغيل الحالي"). Unit test: `BuilderLifecycle.spec.tsx` › "the run panel's own heading is not the page's heading".
2. **Misleading wording for an unknown run id (NOT changed).** A run id that does not exist shows the offline state ("Could not connect. Check your network…" with a retry button) because the stream reports the failed read as a reconnect. Safe (nothing leaks, no steps shown) but it blames the network. Follow-up: distinguish 404 from a network failure in `useRunStream`/`BuilderLifecycleScreen`.
3. **The gate names the wrong flag (NOT changed).** `bgate` checks `app_builder.enabled` only; when `ai.enabled` is off the message still says "app builder". Every builder screen that reads `/v1/builder/*` through `bview` behaves the same way: an organization with only `app_builder.enabled` gets the same empty "not enabled" page. No other screen was found to render something worse (all show the same explicit state); a combined gate (`app_builder.enabled && ai.enabled`) in `bgate` would make the message accurate and save an API call.

## Spec-only corrections made while getting the E2E green (assertions kept, not weakened)
- the status label appears twice (run summary and step badge): locate the `<strong>` summary;
- `Build` matched `Rebuild`: steps are located by exact label inside `li[data-status]`;
- two `role=alert` (Next's route announcer is one): scoped to `main`;
- a "no internal text" pattern ran against `page.content()` (which has `undefined` in inline scripts, and `select {` in the stylesheet matched a case-insensitive `SELECT `): it now checks what a person sees / a case-sensitive SQL marker with `FROM`;
- S07's `qa-negatives`: the "another tenant" user `registrant-<L>@example.test` is not a dev identity-provider user (`USERS` in `playwright.config.ts`); `approver1-<L>` is used. The owner's own project name is legitimately on the page for a malformed/unknown run id (`ownProject` flag in `noLeak`); the marker and error-text checks still apply.

## Evidence
`scripts/e2e-stack.sh run tests/19-builder-agent.spec.ts tests/qa-negatives.spec.ts -g "builder agent screen"` on an isolated stack (own Postgres :54345): 4 passed (ar and en, both specs), axe included. The admin-consoles test of `qa-negatives` (S07's, needs the staff MFA enrolment of `02-admin`) was not run in this reduced set.

## DEFECT-20c — an unknown or malformed run id said "Could not connect. Check your network…" with a retry button (FIXED)
- Was: `useRunStream` (`apps/web/lib/builder-client.ts`) treated every non-2xx of the events stream as a network failure (`reconnecting`), so the screen showed the offline state and retried forever.
- Now: `useRunStream(runId, { terminalNotFound: true })` (opt-in, so the other screens that share the hook are unchanged) ends on a 404 (`not_found`) or 403 (`forbidden`); a 5xx or a dropped connection is still a reconnect. `BuilderLifecycleScreen` maps them to the panel states `missing` (new, `role=alert`, no retry button, text `bt.lc.state.missing` ar/en: "not found, or you do not have access", the same words for both so it is no existence oracle) and `forbidden` (existing).
- Tests below the browser: `apps/web/lib/builder-client.stream.spec.tsx` (404 → `not_found` and no further requests; 403 → `forbidden`; without the option a 404 is still `reconnecting`; a 503 is still `reconnecting`); `BuilderLifecycle.spec.tsx` › "DEFECT-20c" (ar and en: the missing text, never the offline text, no button).

## DEFECT-20d — the builder gate blamed the wrong flag (FIXED)
- Was: `bgate` looked only at `app_builder.enabled`; with `ai.enabled` off the API's 404 turned into "The app builder is not enabled" although the app builder was on.
- Now: `bgate` (in `apps/web/lib/builder-gate.tsx`, the file S05 has a recorded exception for) asks the new pure `missingBuilderCapability(flags)` (`apps/web/lib/appbuilder.ts`): `'app_builder'` first, then `'ai'`, else `null`; `NotEnabledState` takes `capability` and, for `'ai'`, says "AI features are not enabled for your organization yet, so the app builder cannot be used" (`bt.gate.ai.title/body`, ar+en). No flag key is shown. `bview`'s 404 (an item that does not exist, or a server-side switch) keeps the generic message.
- Edit outside S05's paths, as recorded: `apps/web/lib/builder-gate.tsx` (gate), `apps/web/components/BuilderParts.tsx` (`NotEnabledState` gains an optional prop, default unchanged), `apps/web/lib/appbuilder.ts` (the pure helper and the `AI_FLAG` constant, next to `APP_BUILDER_FLAG`), `packages/i18n/src/messages.ts` (three keys in S05's block).
- Tests: `apps/web/lib/appbuilder.spec.ts` › "DEFECT-20d" (all four combinations of the two flags, null/undefined, the two stored shapes), `apps/web/components/BuilderGateState.spec.tsx` (ar and en: the default message, the AI message, no flag key shown, keys present in both languages).
