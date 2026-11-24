# CONTRACT-S03-2 — database ownership, migration range and classification for the benchmark tables

- **Requester:** Session 03 · **Status:** REQUESTED
- **Contract:** `spec/db/ownership.yaml` (`schemas.ai`, `migration_ranges`, `classification`)
- **Current text:** `migration_ranges` ends at `K: "1860-1899"`; `schemas.ai.extended_by` lists M10, M10-INT, K. The migration runner REFUSES my files today: `Invalid migrations: ai/1920__ai__benchmark_runs.sql: ordinal 1920 outside ranges allowed for ai` (verified by running `pnpm db:migrate` on my own cluster :54343; with the lines below applied locally it migrates, and 1920/1921 down then up work).
- **Why:** parallel-phase migration ids 1920-1939 were allocated to Session 03 in `MIGRATION-REGISTRY.md`, but no range exists in the manifest.
- **Additive?** Yes. **Sessions affected:** 01 (applies; also allocates the equivalent ranges for 02, 04-06 if not yet done).

## Patch
```yaml
# migration_ranges
  AG-S03: "1920-1939"   # Session 03 (S-AG5 benchmarks), parallel AI-engine phase

# schemas.ai
    extended_by:
      - AG-S03
    tables:   # add (alphabetical)
      - benchmark_records
      - benchmark_runs
```
Both tables are platform-scoped (no `org_id`, no customer data: every task is synthetic, data class `public`), append-only (runtime role has SELECT and INSERT only), RLS enabled and forced with the `app.platform_scope = 'admin'` policy, same shape as `ai.model_capability_evidence` (1870). They carry no `data_region` (platform data, no personal data, no vendor call).

## Classification (`classification:` section; every column)
```yaml
    ai.benchmark_runs:
      id: internal
      label: internal
      dataset_version: public
      dataset_hash: public
      evidence_label: public
      origins: public
      adapters: internal
      report: internal      # aggregate metrics of synthetic tasks; no customer content
      scores: internal
      report_fingerprint: public
      request_id: internal
      created_by: internal
      created_at: internal
    ai.benchmark_records:
      id: internal
      kind: internal
      subject: internal
      payload: internal     # names of reviewers, references of approvals, numbers; never a credential
      request_id: internal
      recorded_by: internal
      recorded_at: internal
```
(Match the exact key layout the file already uses for other `ai.*` tables; `payload` and `created_by`/`recorded_by`/`reviewer names` may be `personal` if the Master prefers: reviewer names are personal data of staff. Recommended: classify `ai.benchmark_records.payload` as `personal` to be safe, then `compliance:classification-coverage` and the ROPA coverage check decide.) After applying run `pnpm db:migrate`, `pnpm compliance:classification-coverage`, `pnpm compliance:ropa-coverage`.

## Migrations (already written; Session 03 does not edit `packages/db/migrations` beyond its range)
- `packages/db/migrations/ai/1920__ai__benchmark_runs.sql` + `.down.sql`
- `packages/db/migrations/ai/1921__ai__benchmark_records.sql` + `.down.sql`
Reversal notes are in the `.down.sql` headers (dev/staging only; production is forward-fix; dropping withdraws evidence and every gate then fails closed).
Ids 1922-1939 remain free.

## Applied (Session 03, on the Master's temporary authorization, after merging integration/ai-engine)
Applied on feature/ai-benchmarks; sdk was NOT regenerated (Master does that once). See REPORT-03 "Integration batch 2" for the checks seen.
