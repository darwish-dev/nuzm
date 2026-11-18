# M05 report — Provider Framework & Compute: ADAPTER HALF (S18–S23)

Status: **IN PROGRESS / NOT DONE.** This is the adapter-stream half of the M05 report (sprints S18–S23: Alibaba ECS, Huawei ECS, Contabo VPS, compute and provider consoles, cost capture). The core half (S16–S17: contracts, framework, routing, quotes, provisioning, reconciler, compute API) is in `S16-report.md` / `S17-report.md` on branch `claude/m05-provider-core-05b775`; the two halves are merged into one M05 report when the branches are ported. M05 is **not DONE**: acceptance rows depending on HG-05-01..04 are BLOCKED, UI e2e/screenshots have never run, and the owner has not signed.

**Every adapter result is NOT VERIFIED.** No Alibaba, Huawei or Contabo account, API user or credential exists; the agent made no call to any vendor (documentation was read with WebFetch/WebSearch, 2026-11-18). Adapters were built only from the vendors' published documentation and pass the conformance kit against local simulators shaped from those pages. Saudi/region "verified" is unset until a real probe is evidenced.

## A. Repository findings and assumptions
- Stream base: S16 (`3a11e91`); the core stream's S17 (`f88b8ec`) was read read-only. Commits here: S18 `b6150de`, S19 `9172c4f`, S20 `b05d7df`, S21 `d347ff2`, S22 `35222dc`, S23 `0841a05` + follow-ups (see `git log`). Nothing pushed.
- Documentation sources (page + read date) are listed in each adapter README: `packages/adapters/{alibaba-ecs,huawei-ecs,contabo-vps}/README.md`. Research was done by read-only subagents whose fetcher summarised pages (JSON samples are faithful extractions, not byte-exact); gaps are written **NOT DOCUMENTED**, never guessed. Notes: `side-session-notes/…/research-*.md` (outside the repo).
- Design rule applied to every adapter: a capability is `supported` only when a read-only call or a documented DryRun proved it; otherwise `unknown` (= unsupported). Therefore **Huawei and Contabo mutating capabilities are `unknown` until a human-triggered live verification** (no documented dry-run exists for them), Alibaba proves them with `DryRun` against an existing instance. `capabilityMode: 'documented'` exists for fixture runs only and is refused against live endpoints.
- Vendor facts that shaped the adapters: Alibaba `ClientToken` (not queryable → tag lookup) and DryRun; Huawei `X-Client-Token` (UUID, 8 h) + name/tag marker, no ECS snapshot API (EVS), async jobs, HTTP 202 for `Common.0024`; Contabo has no idempotency, no price/availability/billing/metrics APIs, no DELETE (cancel).

## B. Plan and changed files
By sprint: S18 foundations (`@nuzm/adapter-http`, V3 signer, `@nuzm/adapter-live-verify` region report + runner) · S19 Alibaba adapter/sim/specs · S20 Huawei signer/egress/report · S21 Huawei adapter/sim/specs · S22 Contabo adapter/sim/specs · S23 costs, cloud-vendors module, migration 0650, OpenAPI (+3 operations), CLI, runbooks, consoles. Per-sprint file lists are in `S18`…`S23-report.md`.

## C. Implemented features, API and UI screens
Three `ComputeAdapter`s (contract 1.0.0) with probe/health/regions/plans/images/catalog/quote/provision/inspect/findByToken/actions/delete/metrics/billing where documented; egress-guarded HTTP transport with redirect refusal and evidence kind derived from the real URL (a fixture can never be `live`); redacted fixture recorder/replayer; verified-region report generator; human-triggered live-verification runner, owner CLI and job definitions; provider cost capture + manual import + RC-04 bill source; live-verification register; vendor adapters registered in the cloud registry; customer compute console (UI-M05-01..07, 16) and admin provider console (UI-M05-08..15). New endpoints: `GET /v1/admin/provider-costs`, `GET /v1/admin/live-verification`, `POST /v1/admin/live-verification/runs`.

## D. Migrations and rollback
`cloud/0650__cloud__live_verification_runs` (+ dev-only down; production forward-fix). S18–S22 need none.

## E. Tests run, with actual results
See S18–S23 reports. Totals (2026-11-18): conformance kit **15/15 for each of mock, alibaba-ecs, huawei-ecs, contabo-vps** (fixture/mock evidence, `liveStatus: NOT VERIFIED`); adapter unit/spec tests alibaba 24, huawei 22, contabo 10, costs 7, live-verify 9; `cloud-vendors.int.spec.ts` 10/10 and `cloud.int.spec.ts` 19/19 on Postgres :54335; `spec:lint`, `spec:drift` (189 routes), `sdk:check`, `db check`, classification coverage: clean. Filtered verify (all of `pnpm verify` but the browser package) exit 0; `pnpm test:integration`: db 43, platform 32, worker 8, api 720 — all passed (Postgres :54335). **Not run:** `pnpm test:e2e`, `pnpm verify:full`, Playwright specs 08/09, screenshots (ports held by other sessions; S17 API absent from this tree).

## F. Security, tenant isolation, billing, residency verification
Vault references only; canary secrets absent from adapter results/evidence (kit C14 per adapter) and from cost tables; per-adapter egress allow-lists equal `providers.yaml` (test); provider tags carry only the opaque org hash; provider costs platform-only; the live-verification register cannot be forged to LIVE-VERIFIED (API + DB CHECK) and has no start route. Residency: adapters list only regions present in the account's own listing; `verifiedAt` only from live evidence.

## G. Human gates and live checks still needed
HG-05-01 (Alibaba), HG-05-02 (Huawei), HG-05-03 (Contabo), HG-05-04, D-12, D-15, D-23. Per-provider `must_establish` lists are in `spec/providers/live-verify.yaml`; the owner procedure is `docs/runbooks/live-verification.md`.

## H. Acceptance checklist (adapter-half rows)
| Row | Status | Evidence |
|---|---|---|
| AC-M05-01 conformance (mock) | PASS (mock) — core S16 | `mock-compute-conformance.json` |
| (adapter kit, fixtures) alibaba/huawei/contabo 15/15 | **PASS on fixtures; NOT VERIFIED live** | `docs/reports/evidence/M05/*-conformance.json` |
| AC-M05-13 canary | PASS (adapter half) | specs; core half S16/S17 |
| AC-M05-14 UI e2e + axe | **NOT VERIFIED** (e2e NOT RUN) | S23 report |
| AC-M05-15 / 17 verified-region report from live accounts | **BLOCKED (HG-05-01 / HG-05-02)** | reports `NOT VERIFIED` |
| AC-M05-16 / 18 live lifecycle | **BLOCKED (HG-05-01|02, HG-05-04)** | — |
| AC-M05-19 Contabo probe + EU location | **BLOCKED (HG-05-03)** | — |
| AC-M05-20 RC-04 real bills | **BLOCKED (HG-05-01..03)**; fixture logic PASS | `cloud-vendors.int.spec.ts` |
| AC-M05-02..12, 21..24 | core stream (S16/S17) — not this half | — |

## I. Next-milestone handoff and open decisions
M06 consumes compute instances as CloudPanel nodes (needs S17 + a live-verified provider); M07/M08 consume the framework/routing/reconciler. Port checklist and re-checks: `S23-report.md §I`. Open: D-12, D-15, D-23, HG-05-01..04; SI-M05-7 (Contabo EU country), -8 (FX column), -9 (admin operations list), -10 (capability promotion after live runs); price/availability for Contabo (no API); account-settings API for VPC networking/project ids (today `CLOUD_VENDOR_CONFIG`); finrec owner PR to wire RC-04's bill source.

## J. Port to main's M04 base (done 2026-11-18, branch `claude/m05-adapters-on-main-m04`)
The stream was cherry-picked onto the core stream's already-ported branch `claude/m05-on-main-m04` (`cbb8e4d`, S16+S17 on main's M04 `74abc67`); the original branch `claude/m05-adapters-4e5fc6` is untouched. Nothing pushed, no history rewritten.
- **Conflicts resolved:** `spec/openapi/openapi.yaml`, `spec/db/ownership.yaml`, `docs/04` (took the target and re-applied this stream's additions), `packages/sdk/src/schema.ts` (regenerated), `packages/i18n/src/messages.ts` (took the target and re-appended the `m05.*` keys), console layouts (kept main's nav, added the M05 entries only).
- **Main's M04 differs from the M03+M04 integration branch** the stream started on: the UI had borrowed helpers that do not exist on main (`ComplianceBits`, `ComplianceLoading`, `lib/privacy.isUuid`, `PrivacyLoading`, compliance i18n keys). The consoles were made self-contained (`apps/admin/components/ProviderCommon.tsx`, `apps/web/components/ComputeLoading.tsx`, `isUuid` in `apps/web/lib/compute.ts`; the stray `ComplianceBits.tsx` was dropped; key `nav.admin.providers` added). Main's stricter classification check required `cloud.live_verification_runs.spend_cap_minor` to be `financial`.
- **Re-checks from §I, results:** AdapterRegistry `register`/`entry`/`ctx` semantics unchanged (vendor registration and cost capture work); `cloud.resources` exists, columns `(provider_account_id, provider_ref, org_id)` match the attribution query (covered only for the unattributed path in tests: no resource-backed cost line is tested); offer eligibility already rejects non-live region evidence in production (`region_evidence_not_live`); migration numbers 0600/0610/0620/0630/0650 apply cleanly on a fresh database.
- **Results on the new base (fresh Postgres :54335):** filtered verify (`lint, typecheck, turbo test --filter='!@nuzm/e2e', build, spec:lint, spec:drift (175 routes), sdk:check, scan:secrets, zatca:guard`) exit 0; `db:test-rls` OK; classification 1234 columns / 109 tables OK; `pnpm test:integration`: db 43, platform 32, worker 8, **api 864 (37 files)** passed. **Still NOT run:** `pnpm test:e2e`, `pnpm verify:full`, Playwright specs 08/09, screenshots.
