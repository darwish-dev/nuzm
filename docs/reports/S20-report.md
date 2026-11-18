# S20 report — Huawei ECS adapter I: authentication, region and catalog verification foundations (M05 sprint 20)

Status: foundations implemented and tested **offline only**. **Everything is NOT VERIFIED; all live rows are BLOCKED (HG-05-02 PENDING).** No Huawei account, IAM user or credential exists and none was created; no call to any vendor endpoint was made (documentation was read with WebFetch/WebSearch only, 2026-11-18). Citations are in [packages/adapters/huawei-ecs/README.md](../../packages/adapters/huawei-ecs/README.md).

## A. Repository findings and assumptions
- Base is unchanged (S16 `3a11e91` + this stream's S18/S19 commits). As for Alibaba, the adapter is one class: its S20 parts (auth, `probe`, `listRegions`, `listPlans`, `listImages`, `catalog`, `quote`) are committed together with the S21 lifecycle/billing parts in the S21 commit; the S20 commit holds the signer, the package skeleton, the egress allow-list and the NOT VERIFIED verified-region report.
- Documentation facts that shaped the design: AK/SK signing (`SDK-HMAC-SHA256`) is the docs' recommended method; IAM token mode (24 h) is also documented; the project id per region is needed in every URI (IAM project list = account-side region proof); `me-east-1` = "ME-Riyadh" in the endpoint table (documentation, not account proof); flavor sold-out status lives in `os_extra_specs`; the price API needs the `.linux` flavor suffix and returns USD major units; flavors/images/prices are per region.
- Assumptions recorded: region→country is derived from the region *names* in the endpoint table for a short list (me-east-1 SA, ae-ad-1 AE, ap-southeast-1 HK, ap-southeast-3 SG, eu-west-0 FR, eu-west-101 IE, af-south-1 ZA, af-north-1 EG, tr-west-1 TR; everything else, including mainland China, is skipped = unknown = unsupported); 2 minor digits for USD, prices rounded up.
- Not documented (not guessed): whether IAM `GET /v3/projects` accepts an AK/SK signature (token mode avoids the question), an unmasked signing test vector, me-east-1-specific flavors/AZs/prices, the `availability-zone` path variant the brief guessed (the documented one is `GET /v1/{project_id}/availability-zones`, not needed).

## B. Plan and changed files
`packages/adapters/huawei-ecs/{package.json,tsconfig*.json,src/signer.ts,src/signer.spec.ts}`, `spec/providers/providers.yaml` (egress `*.myhuaweicloud.com`), `pnpm-lock.yaml`, `docs/reports/evidence/M05/verified-region-report-huawei-none-2026-11-18.{json,md}`.

## C. Implemented features
- **SDK-HMAC-SHA256 signer** (`node:crypto`). The test reproduces the **hashed canonical request** printed in the documentation's worked example (`b25362e603ee…cd7a`) and recomputes the remaining steps independently; the vendor's printed signature uses a masked secret and cannot be reproduced (NOT DOCUMENTED test vector). Acceptance by the real gateway is NOT VERIFIED.
- Region/catalog logic (committed in S21): regions from the account's own IAM project list, only enabled projects with a documented country; `verifiedAt` only from live evidence; plans with availability from `os_extra_specs` and a BSS pay-per-use price (flavor + system volume, rounded up to integer minor units).
- Verified-region report: `NOT VERIFIED`, no verified region, Saudi `NOT VERIFIED` (HG-05-02 PENDING).
- No API or UI in S20.

## D. Migrations and rollback
None.

## E. Tests run, with actual results
| Command | Result |
|---|---|
| `pnpm --filter @nuzm/adapter-huawei-ecs exec vitest run src/signer.spec.ts` | 2 passed (hashed canonical request equals the documented value; `X-Sdk-Date` format) |
| `eslint`, `prettier`, `tsc` | clean (whole package, run at S21) |

## F. Security, tenant isolation, billing, residency verification
Credentials by vault reference only (AK/SK, or IAM user/password/domain; tokens cached 23 h and registered with the redactor); egress `*.myhuaweicloud.com`, https only, redirects refused. No tenant data, billing or residency code in S20.

## G. Human gates and live checks still needed
HG-05-02 (Huawei account, least-privilege IAM user, Saudi eligibility), HG-05-04. LV job `live-verify-huawei` not run.

## H. Acceptance checklist
| Row | Status | Evidence |
|---|---|---|
| AC-M05-17 Huawei verified-region report from a live account | **BLOCKED (HG-05-02)**; today's report `NOT VERIFIED` | `docs/reports/evidence/M05/verified-region-report-huawei-none-2026-11-18.md` |
| AC-M05-18 Huawei lifecycle live | **BLOCKED (HG-05-02, HG-05-04)** | — |

## I. Handoff
S21 completes lifecycle, billing and conformance. Open: gateway acceptance of the hand-written signer; IAM project listing with AK/SK.
