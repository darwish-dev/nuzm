# CONTRACT-2 — migration 1900 `ai.model_rate_card_versions`: ownership manifest, range key, classification

- **Requester:** Session 02 · **Contract:** `spec/db/ownership.yaml` (Master-owned) · **Additive:** yes (one new platform-scoped, append-only table; no existing table is altered)
- **Why:** the migration runner validates every migration against the manifest (`ordinal 1900 outside ranges allowed for ai`), so migration 1900 cannot be applied without the range, and `compliance:classification-coverage` needs a class per column.
- **Status on the branch:** to be able to run its tests, Session 02 applied exactly the patch below **in its own commit `d35363f9`** (`chore(spec): ownership manifest rows for migration 1900…`), separate from the code. The Master may keep it, re-apply it with different keys, or revert it; the migration and `provider.service.ts` need the equivalent rows to be accepted. Verified on my own cluster (:54342): `pnpm db:migrate` applies 1900; `pnpm compliance:classification-coverage` → "3376 columns in 269 tables, all classified"; `compliance:residency-hooks` OK; `compliance:ropa-coverage` OK.

## Patch (all in `spec/db/ownership.yaml`)
1. `migration_ranges`: `PROV: "1900-1919"` (key name is the Master's to choose).
2. `schemas.ai.extended_by`: add `PROV`.
3. `schemas.ai.tables`: add `model_rate_card_versions` (alphabetical, after `model_providers`).
4. The list of platform-scoped tables (no `org_id`, next to `ai.model_capability_evidence`): add `ai.model_rate_card_versions`.
5. `classification.columns` (all `internal`): `ai.model_rate_card_versions.{id, provider_id, version, models, content_sha256, basis, recorded_by, recorded_at}`.

## Rollback
`packages/db/migrations/ai/1900__ai__model_rate_card_versions.down.sql` drops the table (audit trail: back it up first; nothing else depends on it). Forward-only in production per `docs/05`; the application tolerates the table's absence NOT: `ModelProviderService.configure` writes to it, so a rollback of the migration needs the matching code revert.
Expand/contract: nothing to contract.

## Security notes
Platform-scoped RLS (`app.platform_scope='admin'` for all, worker read-only), `FORCE ROW LEVEL SECURITY`, grants SELECT+INSERT only, UPDATE/DELETE/TRUNCATE refused by trigger (tested). Contains prices as integer strings, no secrets, no personal data.
