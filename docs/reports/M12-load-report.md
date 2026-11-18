# M12 load report

Status: **NOT RUN at declared scale. BLOCKED: no staging environment (M12 §2: "extrapolation not accepted as evidence").** Written 2026-11-18.

| Scenario (M12 §11) | Declared target | Result | Status |
|---|---|---|---|
| Control-plane mixed workload | 500 rps, 30 min, read p95 < 300 ms, write p95 < 800 ms, errors < 0.5 % | no run | BLOCKED (staging) |
| 2,000 concurrent sessions | as above | no run | BLOCKED (staging) |
| Ledger posting | ≥ 200 tx/s, imbalance 0 | no run (correctness covered by `billing/ledger.int.spec.ts`, not throughput) | BLOCKED |
| Metering ingest | 5,000 events/s, 0 loss, 0 duplicates | no run | BLOCKED |
| Workflows | 100 executions/s | M11 not on this branch | BLOCKED (M11) |
| AI runs | 200 concurrent, caps respected | M09 not on this branch | BLOCKED (M09) |
| Reconcilers under load | within window | no run | BLOCKED |
| Soak | 4 h, memory growth ≤ 20 % | no run | BLOCKED |

What exists: the harness (`apps/api/src/ops/load/`), its arithmetic tests against a local fake server (not a performance result), and `memoryGrowthPct`. How to run when staging exists: `BASE_URL=… SESSION_COOKIE=… CSRF=… ORG_ID=… pnpm --filter @nuzm/api exec tsx src/ops/load/cli.ts control-plane-mixed --declared`; results are written to `docs/reports/load/` and a smoke run is labelled and never counts as the declared scale. **No number in this file is a measurement of the platform.**
