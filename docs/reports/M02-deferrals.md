# M02 deferrals (change-log entries)

Approved by the owner in chat on 2026-11-17 ("Sign, defer the open rows"). Each row below was not fully done at the M02 gate and is now `DEFERRED (approved change-log entry)` per CLAUDE.md §6. Nothing here is hidden: the implemented behavior is described in [M02-report.md](M02-report.md).

| ID | Deferred item | Why it is safe to defer | Picked up in |
|---|---|---|---|
| DEF-M02-01 | AC-M02-06 at the 10,000-random-operation scale (wallet projection = Σ2100) | Drift and consumer tests pass; the projection is rebuildable from the ledger | M03 (RC-06 reconciliation library check) |
| DEF-M02-02 | AC-M02-11 ingest/aggregation SLO on 1M events; 10M-event aggregation fixture | SLO targets are proposals (D-30); no real producers exist yet | M05 (first real producer) / M12 hardening |
| DEF-M02-03 | UI-M02-14 platform-wide raw usage events; UI-M02-16 provider-cost import | docs/04 defines no endpoint for either | When the owner approves the endpoints (open decision) |
| DEF-M02-04 | UI-M02-11 price-book diff view; UI-M02-12 plan editor; UI-M02-15 adjustment request list and manual-lines form | Reads, publish, meter create, reversal request/decision work; the rest needs endpoints docs/04 does not define or a draft workflow | M03 admin UI work / on endpoint approval |
| DEF-M02-05 | Quota sweeper for usage that arrives only via the worker outbox; spend alert-threshold notifications; `committed spend`/credits fields on `GET /v1/billing/balance` | No in-platform producer exists before M05; alerts and balance fields are additive | M03 (balance), M05 (producers, sweeper) |
| DEF-M02-06 | `credit` authorizations (wallet holds); orders counted in the month's spend; project attribution of usage | Need payment and resource models from M03/M05 | M03 / M05 |
| DEF-M02-07 | Keyboard-only and screen-reader walkthroughs; header-scan; load smoke | Record-only or hardening items (axe is automated in the E2E) | M12 |

## Still OPEN (not covered by this sign-off)
Recorded for the owner; the implemented behavior stays as built until decided.
1. HG-02-01 (approved pricing, margin policy, price book v1) BLOCKED; D-23, D-25, D-30, D-31 OPEN.
2. Money response shape (`…Minor` + `currency` vs docs/04 `{amount, currency}`); `plan` quote semantics (needs a price source from M03).
3. Endpoints not in docs/04: provider-cost import, platform-wide usage events, adjustment list/approval sub-resources, rating trigger, per-organization entitlement overrides.
4. `quota_meters` mapping per group; viewer access to quotes; `admin` as spend approver; counting orders in spend; 72 h late-event grace.
5. Carried from M01: additive contract changes, PA-12/17/18, `POST /v1/admin/organizations`, impersonation approval model, per-console OIDC clients, HG-01-01/-02, D-12, D-13, D-08.
