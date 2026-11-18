# S18 report — Alibaba ECS adapter I: authentication, shared adapter plumbing, region/catalog/pricing foundations (M05 sprint 18)

Status: foundations implemented and tested **offline only**. **Everything is NOT VERIFIED; all live rows are BLOCKED (HG-05-01 PENDING).** No Alibaba account, RAM user or credential exists and none was created; no call to any vendor endpoint was made by the agent (documentation was read with WebFetch/WebSearch only, 2026-11-18). Owner-directed start (see S16 report §A).

## A. Repository findings and assumptions
- Base: `claude/m05-provider-core-05b775` at S16 (`3a11e91`). The core session has since committed S17 (`4f80238`, local); this worktree does not contain it. Migration range 0650–0699 reserved for this stream; **S18–S22 need no migration**.
- Scope split: S18 = auth (V3 signing, vault-ref credentials), the shared HTTP/evidence/egress plumbing, the verified-region-report generator, live-verification runner, and the region/catalog/pricing logic. Because the adapter is one class, **its code (auth, `probe`, `listRegions`, `listPlans`, `listImages`, `catalog`, `quote`, and the S19 lifecycle/billing methods) is committed together in the S19 commit** (`feat(cloud): M05 S19 …`); the S18 commit holds the foundations listed in §B.
- Documentation research: three read-only research subagents (one per vendor) produced cited notes in the shared notes folder (`research-alibaba-ecs.md`, …). Their fetcher summarised pages (JSON samples are faithful extractions, not byte-exact); every adapter README lists the pages and read dates and marks NOT DOCUMENTED items instead of guessing.
- Decisions: separate packages `@nuzm/adapter-http` (transport + egress + evidence + recorder + loopback server) and `@nuzm/adapter-live-verify`; nothing in S16 packages was edited (the core session is editing `mock-compute`/`runtime/clock`); egress hosts for Alibaba and Contabo were filled in `spec/providers/providers.yaml` (the only shared spec file touched; Huawei follows in S20).
- Evidence-kind rule: a transport reports `live` only for a non-loopback host reached through the real network; replays and loopback servers are `fixture`. So a fixture run can never produce `live` evidence, and the adapter sets a region's `verifiedAt` only from live evidence.

## B. Plan and changed files
`packages/adapters/http/**` (transport with allow-list/SSRF guard and `redirect: 'error'`, ambiguity → `TransportAmbiguousError`, evidence helper, result helpers, `RecordingTransport`/`ReplayTransport` (redacted fixture recorder, never run live by the agent), loopback `startLocalServer`, `ProbeCache`); `packages/adapters/live-verify/**` (`buildRegionReport`, `runLiveVerification`); `packages/adapters/alibaba-ecs/src/signer.ts` + spec; `spec/providers/providers.yaml` (egress); `pnpm-lock.yaml`; `docs/reports/evidence/M05/verified-region-report-alibaba-none-2026-11-18.{json,md}`.

## C. Implemented features
- **V3 request signing (ACS3-HMAC-SHA256)** implemented with `node:crypto`; the test reproduces the vendor's own worked example byte for byte (hashed canonical request `7ea06492…e259`, signature `06563a9e…83c0`). The vendor recommends its SDK and asks to contact support before hand-writing a signer: acceptance by the real endpoint is NOT VERIFIED.
- **Verified-region report generator**: `LIVE-VERIFIED` needs an owner-recorded gate evidence id AND ≥ 1 region with only live evidence; otherwise `NOT VERIFIED`, no verified region, Saudi `NOT VERIFIED`. The Alibaba report for today is therefore `NOT VERIFIED` (HG-05-01 PENDING, no account).
- **Live-verification runner** (LV-1..6): does nothing without an owner trigger (`NOT RUN`), enforces the spend cap, tags resources, runs probe → create → inspect → stop/start/reboot → (resize, snapshot if supported) → metrics → delete → teardown verifier (reconciles via `findByToken`; residue ⇒ `FAIL` + page owner) → billing record; a run over mock/fixture evidence is labelled `NOT VERIFIED`. The three job definitions (`live-verify-alibaba|huawei|contabo`) arrive with the CLI in S23.
- No API or UI in S18.

## D. Migrations and rollback
None.

## E. Tests run, with actual results (this worktree, 2026-11-18)
| Command | Result |
|---|---|
| `pnpm --filter @nuzm/adapter-alibaba-ecs exec vitest run src/signer.spec.ts` | 2 passed (documented worked example reproduced exactly; RFC 3986 encoding/sorting) |
| `pnpm --filter @nuzm/adapter-live-verify test` | 7 passed (no trigger ⇒ NOT RUN; spend cap; mock run ⇒ NOT VERIFIED with zero residue; failing delete ⇒ FAIL + page owner; region report: no gate ⇒ NOT VERIFIED, fixture never verifies, live+gate verifies — logic test only) |
| `eslint` over the four new packages, `prettier --write`, `tsc` (typecheck + build) | clean |

## F. Security, tenant isolation, billing, residency verification
Credentials by vault reference only (fields `accessKeyId`, `accessKeySecret` resolved at call time and registered with the redactor); egress allow-list `*.aliyuncs.com`, https only, redirects refused. No tenant data, billing or residency code in S18.

## G. Human gates and live checks still needed
HG-05-01 (Alibaba account, RAM user, Saudi eligibility), HG-05-04 (quota/spend caps). LV job not run.

## H. Acceptance checklist
| Row | Status | Evidence |
|---|---|---|
| AC-M05-15 Alibaba verified-region report from a live account | **BLOCKED (HG-05-01)**; report generator PASS (logic), today's report `NOT VERIFIED` | `docs/reports/evidence/M05/verified-region-report-alibaba-none-2026-11-18.md` |
| AC-M05-16 Alibaba live lifecycle | **BLOCKED (HG-05-01, HG-05-04)** | — |

## I. Handoff
S19 completes the Alibaba lifecycle, billing and conformance run. Open: whether the real endpoint accepts a hand-written V3 signature (live), BSS endpoint for a Riyadh-region account (not on the BSS endpoint page).
