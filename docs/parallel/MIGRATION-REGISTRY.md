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
