# Migration registry

Migrations are numbered globally (`NNNN__<module>__<name>.sql` + `.down.sql`, forward-only, expand/contract). Highest existing id at baseline: **1870** (`ai.model_capability_evidence`).

| Range | Session | Used so far |
|---|---|---|
| 1900–1919 | 02 Providers | — |
| 1920–1939 | 03 Benchmarks | — |
| 1940–1959 | 04 Sandbox / execution | — |
| 1960–1979 | 05 Builder tools | — |
| 1980–1999 | 06 Deployment | — |
| 2000–2019 | 07 QA (reserve; Master-approved only) | — |
Rules: take the next unused id in your range and record it here in your own report (not in this file) as soon as you create the file; every new table appears in `spec/db/ownership.yaml` (Master applies your patch) with `org_id`, RLS, a data class for each column, and `data_region` where region-bearing; no cross-schema foreign keys; a reversal note. The Master verifies ordering and applies the whole set on a scratch database (up, down, up) at each integration batch.

## Hosting join (branch `p3-s07-hosting-join`, 2026-11-24)
The HestiaCP hosting line (local `main`) uses 1900-1999 (`domains` 1900/1960, `platform` 1920, `cloud` 1940/1985, `hosting` 1980/1991-1993, `compute` 1990). The four AI-engine migrations that collided were renumbered; the ranges above are therefore historical for the AI line:
| Old | New | File |
|---|---|---|
| 1900 | 2210 | `ai/2210__ai__model_rate_card_versions` |
| 1920 | 2211 | `ai/2211__ai__benchmark_runs` |
| 1921 | 2212 | `ai/2212__ai__benchmark_records` |
| 1980 | 2213 | `deploy/2213__deploy__deployment_cancelled` |
`spec/db/ownership.yaml`: key `AG-JOIN: "2210-2219"` replaces `PROV`, `AG-S03`, `AG-S04`, `AG-S05` and `S06-DEPLOY`; `S06-DEPLOY2` (2180-2199) stays. A database that already applied the old ordinals needs the fix-up described in `RECONCILIATION-HOSTING.md` section 2 step 2 (scratch databases: drop and re-create).
