# CONTRACT-5 — provider insights screen text (request to the Master)

From: Session 02 · Date: 2026-11-24 · Status: **REQUEST (not blocking: the screen works without it).**

## What
The provider insights screens (`apps/admin/components/AiProviderInsightsPanel.tsx`, shown under the providers list at `/ai/model-providers`) need about 110 short texts in Arabic and English. `packages/i18n/src/messages.ts` is outside this workstream's files, so the texts live in **`apps/admin/lib/ai-insights.ts`** (`INSIGHT_TEXT`, helper `ti(locale, key, params)`), with a unit test that every key exists and is non-empty in both languages with the same placeholders, and that no Latin words are left in the Arabic text.

## Ask
When convenient, move the table into the shared message table under a `aia.ins.` prefix (keys are `ins.*` today) and replace `ti(...)` by `t(...)`: a mechanical change in one file plus the table. Until then nothing else is needed. The E2E spec (`e2e/tests/10-ai-provider-insights.spec.ts`) deliberately finds elements by test id, id and role, so it does not depend on where the text lives.

## Also changed outside this workstream's folders (recorded)
`e2e/tests/10-ai-admin.spec.ts`: the four row selectors for the providers list are scoped to the providers table (`providersTable()`), because the insight tables list provider codes too (`mock-model`, `acme-e2e`) and an unscoped `getByRole('row').filter(...)` would match more than one. No assertion changed.

**Master answer:** DEFERRED, non-blocking (2026-11-24): the table stays in `apps/admin/lib/ai-insights.ts` with its parity test; moving it into `messages.ts` is a mechanical follow-up scheduled when the admin UI is finalized.
