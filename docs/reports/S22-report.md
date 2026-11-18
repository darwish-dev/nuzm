# S22 report — Contabo VPS adapter: capability detection, EU locations, lifecycle subset (M05 sprint 22)

Status: implemented and tested **offline against a local simulator shaped from the official API reference. NOT VERIFIED. Live rows BLOCKED (HG-05-03).** No Contabo account or credential exists; no call (not even the token endpoint) was made. Citations (page + read date 2026-11-18): [packages/adapters/contabo-vps/README.md](../../packages/adapters/contabo-vps/README.md).

## A. Repository findings and assumptions
- The Contabo API is the thinnest of the three; the adapter implements **only what the documentation supports** and marks everything else unsupported:

| Gap in the documentation | Consequence |
|---|---|
| No idempotency (`x-request-id` is for support correlation only) | `provision` looks the token up first (`displayName` marker `nuzm:<token>\|…`, `search` filter); `findByToken` uses the same lookup. Race window and list-after-create consistency are NOT DOCUMENTED ⇒ absence is not proof until live verification |
| No product list, prices or per-region availability | `listPlans` lists only products whose spec is **complete** in the docs (VDS S–XXL), `availability: unavailable`, **no price** ⇒ never offered. Cloud VPS/Plus/Storage specs are only ranges ⇒ not listed (still valid `productId`s) |
| `EU` region has no documented country | `countryCode: 'EU'` (ISO reservation) — **new open item SI-M05-7**: the data-centre country must be confirmed before any residency decision relies on it |
| No DELETE; `cancel` semantics after the call NOT DOCUMENTED | `delete` = `POST …/cancel` (today's date); `inspect` reports `deleting`/`deleted` from `cancelDate`; a monthly contract may stay billable until its end — **finance must not treat delete as an immediate cost stop** |
| No billing/usage API, no metrics API, no documented plan change | no `fetchBilling` (manual import path, S23), no `metrics`, `resize` = `unsupported` |
| Secrets API section unreadable (page truncated at ~205 k chars) | SSH keys injected via cloud-init `userData` (documented create field), NOT VERIFIED |
| Token lifetime/response shape undocumented | token reused ≤ 60 s, one refresh on 401 |
- **Capability detection (AC-M05-19 prerequisite):** `probe` uses reads only (`GET /v1/compute/instances`, the same with `search`, `GET /v1/data-centers`); `inspect`/`find-by-token` are `supported` when those answer 2xx; every capability that would need a mutation to prove (`provision`, `delete`, start/stop/reboot/snapshot) is `unknown` (= unsupported) until a human-triggered live verification (`capabilityMode: 'read-only'`, the default and only live mode). **Plan-specific:** snapshots are rejected for Storage VPS and VDS (docs.contabo.com: Cloud VPS 1–3, Cloud VPS Plus 5, others none). The conformance run found and fixed a real honesty bug: the probe claimed snapshots account-wide while the plan-specific rule rejected them for the fixture plan — the kit fixture plan was changed to a Cloud VPS and a dedicated spec covers the VDS rejection.
- Mutation outcome rule: timeout/connection error/5xx on a mutating call ⇒ `uncertain`.

## B. Plan and changed files
`packages/adapters/contabo-vps/**` (`adapter.ts`, `products.ts`, `sim.ts`, `test-subject.ts`, specs, README), `docs/reports/evidence/M05/contabo-vps-conformance.json`, `docs/reports/evidence/M05/verified-region-report-contabo-none-2026-11-18.{json,md}`. (Egress hosts `api.contabo.com`, `auth.contabo.com` were recorded in `spec/providers/providers.yaml` with S18.)

## C. Implemented features
OAuth2 password-grant token (vault fields `clientId`, `clientSecret`, `apiUser`, `apiPassword`), `probe`, `health`, `listRegions` (`GET /v1/data-centers`, only the documented region enum, VPS-capable data centres; `verifiedAt` from live evidence only), `listPlans`, `listImages`, `catalog`, `quote` (no price source ⇒ `null`), `provision`, `inspect` (status map from the documented enum), `findByToken`, `act` start/stop/reboot(`restart`)/snapshot, `delete` (cancel, never repeated). Error normalization: 401/403→auth, 402→quota, 404→not_found, 409→conflict, 429→rate_limit, 5xx→provider_outage, 400/415/422→validation.

## D. Migrations and rollback
None.

## E. Tests run, with actual results
| Command | Result |
|---|---|
| `pnpm --filter @nuzm/adapter-contabo-vps test` | 2 files, **10 passed**: conformance kit **15/15** (`evidenceKind: fixture`, `liveStatus: NOT VERIFIED`; report `contabo-vps-conformance.json`), adapter specs (9: read-only mode leaves mutations unknown and nothing is provisioned; plan-specific snapshots; unknown product/region ⇒ local validation, nothing sent; token marker in `displayName`, keys via cloud-init, no org name; cancel once, no DELETE; regions/plans (no verified region from a fixture, 5 VDS plans, unavailable, no price); replay of the documented sample object; canary secrets; auth failure) — run 3× for flakiness after raising the call deadline to 1 s |
| `eslint`, `prettier`, `tsc` | clean |

## F. Security, tenant isolation, billing, residency verification
Canary: client secret and API password never appear in probe/health/provision output. Egress `api.contabo.com`, `auth.contabo.com`, https only. `displayName` carries the idempotency token and an opaque org hash — never the org name (it is visible in Contabo's panel). Residency: EU region ⇒ `EU` placeholder, see SI-M05-7.

## G. Human gates and live checks still needed
HG-05-03 (account + API credentials; confirmed plan/location access). Live verification must establish: list-after-create consistency, behaviour after `cancel` (state, billing), cloud-init key injection, per-product action support, the data-centre country behind `EU`, the permission model of API users.

## H. Acceptance checklist
| Row | Status | Evidence |
|---|---|---|
| Conformance kit on fixtures | **PASS (fixture; NOT VERIFIED live)** | `contabo-vps-conformance.json` 15/15 |
| AC-M05-19 Contabo capability probe + EU location verified before any sale | **BLOCKED (HG-05-03)**; offers are also impossible until price and availability exist (no price/availability API) | `verified-region-report-contabo-none-2026-11-18.md` (`NOT VERIFIED`) |
| AC-M05-20 RC-04 on real bills | **BLOCKED**; Contabo has no billing API ⇒ manual import path (S23) | — |

## I. Handoff
Wiring: `new ContaboVpsAdapter({ vault, redactor, transport: createFetchTransport({ policy }) })`. Open: SI-M05-7 (EU country), price/availability source (D-23 price book + owner-provided availability), the cancel/billing semantics above.
