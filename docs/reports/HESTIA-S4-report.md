# HESTIA-S4: a VPS that installs HestiaCP automatically (Alibaba SCCC Riyadh, Contabo EU), 2026-11-24

Source: sprint S04 of `Nuzm_HestiaCP_Hosting_Master_Prompt.md`. Builds on [HESTIA-S1](HESTIA-S1-report.md) and [ADR-067](../adr/ADR-067-hestiacp-hosting-panel.md) (addendum S04). Runbook: [hestia-vps-install](../runbooks/hestia-vps-install.md). Everything below is **NOT VERIFIED live**: no provider account, no paid server and no real Hestia was used (CLAUDE.md §5).

## A. Findings and assumptions
- The compute module already had the provider side (quote → order → durable `compute.instance.create` → inspect → persist; `ClientToken`/displayName reconcile; start/stop/reboot through `act`). S04 adds the panel as an **order choice and a staged install after the server exists**; it never creates, replaces or deletes a server itself.
- Documentation read (2026-11-24), cited in the code, READMEs and ADR: Hestia getting-started (OS list Debian 12/13, Ubuntu 22.04/24.04/26.04; minimum 1 core / 1 GB / 10 GB; non-interactive flags; installer URL is the `release` branch, **no checksum or signature is published**) and REST API page (custom command profiles, `v-add-access-key`, IP allow-list); Alibaba `RunInstances` (`UserData` Base64 ≤ 32 KB before encoding; `ClientToken`), user-data guide (cloud-init, first start only, public images in a VPC), `DescribeImages.IsSupportCloudinit`, regions page (`me-central-1` "SAU (Riyadh - Partner Region)"); SCCC page (does **not** mention the region, so SCCC-account access to it stays a live fact); Contabo API reference (cloud-init "at least on default / standard images", `x-request-id` is for support, no idempotency).
- **Decision (integrity).** Hestia publishes no checksum, so "pinned version + integrity check" = the administrator pins the Hestia version and the SHA-256 of each per-OS installer script (D-54). The bootstrap downloads the per-OS script directly (not the wrapper, which would fetch another unverified script) and checks the digest before running it.
- **Decision (registration secret).** Single use, bound to one order and one server, window starts when the provider created the server; sealed in the vault (only a SHA-256 in the database) and read back to build byte-identical user data on every retry, because Alibaba rejects a replayed `ClientToken` with changed parameters.
- **Decision (capacity hold).** Applied to panel orders; a plain compute order keeps its existing behaviour (retry, then compensate) because an existing test and contract rely on it.
- **Open, found while building (not invented around):** (1) Alibaba signer puts parameters in the query string, so `UserData` rides in the URL: a local ceiling of 8 KB before encoding applies (the bootstrap is ~4 KB) until the body form of the V3 signature is read and tested live. (2) The API has no `trustProxy`: behind a load balancer the source-address check fails closed. (3) `v-add-access-key` JSON field names and the `API_ALLOWED_IP` setting name come from Hestia's sources, not the cited pages; the script reports `key_failed` instead of guessing.

## B. Plan and changed files
- **Contracts/adapters:** `ProvisionRequest.userData`, `ProviderImage.cloudInit` (`packages/adapters/contracts`); Alibaba `UserData` Base64 + size rule + `IsSupportCloudinit`; Contabo `userData` verbatim + standard images as cloud-init; mock-compute records user data and has a cloud-init Ubuntu 24.04 image; Alibaba simulator models `UserData` validation and the replay mismatch.
- **Migrations (forward-only, dev-only down):** `compute/1990__compute__hestia_vps` (`panel_image_approvals`, `panel_installs`, instance `held`/`panel_kind`, `images.cloud_init`), `hosting/1991__hosting__customer_vps_nodes` (`network_class`, `owner_org_id`, checks). `spec/db/ownership.yaml` (tables, classification, protection).
- **API (`apps/api/src/modules/cloud/internal/hestia-vps/`):** `policy.ts` (OS matrix, config, explicit template), `bootstrap.ts` (cloud-init builder, registration secret), `panel-install.service.ts` (ordering snapshot, stage machine, callbacks, resume, link checks), `panel-images.service.ts`, `ports.ts`; controllers `panel-bootstrap`, `admin-panel`, panel status/retry on compute instances, `hestia` flag per image on the offers list; provisioning hooks (user data, TOCTOU re-check, server created, hold/cancel, delete); hosting `NodesService.registerCustomerVps/retireCustomerVps/checkCustomerVps`, placement queries read `shared` nodes only; adapter `verifyReadOnlyKey`.
- **Spec/SDK:** 8 new operations + schemas + `held` status + `networkClass`; `pnpm sdk:generate`.
- **Web:** control-panel choice and explicit mail answer in the purchase wizard; `VpsPanelCard` on the server page (stages, link, held, attention, retry); ar/en strings.
- **Docs:** ADR-067 addendum, D-53, D-54, HG-05-05, HG-05-06, runbook, adapter READMEs.

## C. Implemented features
Panel choice stored in the order snapshot (image, template, region, provider plan, Hestia version, installer URL + digest) · only verified images offered (cloud-init stated + Hestia-supported OS + admin approval for the configured version + sold placement + flag) · pinned/integrity-checked bootstrap with a read-only panel key · single-use registration with provider identity and address match · staged status create server → wait for boot → install panel → register link → readiness → ready / needs attention / held · idempotent and resumable (no second server on uncertainty; reconcile adopts) · capacity hold with no cross-region fallback and free cancel · customer VPS node outside the shared network with a link state separate from provider actions · start/stop/restart through the provider (blocked only while the installer runs).
**Not built:** admin console screens for image approval and the install monitor (API only; S05 owns the admin screens); a DNS implementation for panel names (D-53; port + double only); a provider-side reinstall (so no data-erasing step exists to confirm); live provider calls.

## D. Migrations and rollback
`compute/1990` and `hosting/1981` are additive (new tables, nullable/defaulted columns, one widened CHECK). Down scripts are dev-only; production is forward-fix (install records are evidence of what ran on a customer's server). The feature is off by default (`cloud.hestia_vps`, and no `HESTIA_VPS_CONFIG` = not offered).

## E. Tests run (actual results)
All run in this worktree on 2026-11-24 (shared dev Postgres :54329; migrations applied to a throwaway database `nuzm_s04_check`, dropped afterwards). Nothing below touched a real provider or a real Hestia.
| Command | Result |
|---|---|
| `pnpm --filter @nuzm/api exec tsc --noEmit` / `@nuzm/web` | clean |
| API unit (`vitest run`) | 83 files, **1111 passed** (incl. new `policy.spec` and `bootstrap.spec`: OS matrix, config, explicit template, secret format, byte-identical user data, YAML parse, `bash -n` of the generated script, digest-before-run order, 10 injection attempts refused) |
| API integration `src/modules/cloud src/modules/hosting src/modules/commerce src/modules/ops` | 16 files, **224 passed**, incl. `hestia-vps.int.spec.ts` (18) |
| `@nuzm/adapter-alibaba-ecs` / `contabo-vps` / `mock-compute` | 27 / 11 / 20 passed (new: Base64 `UserData`, replay with changed user data = vendor mismatch, 8 KB local ceiling, `IsSupportCloudinit`, Contabo verbatim `userData` and standard images) |
| `@nuzm/web` | 961 passed, 14 failed: all in `DocsPages.spec` / `SitePages.spec` (`window.matchMedia is not a function` in `FloatingDock.tsx`, a file this sprint does not touch); the new `VpsPanelCard.spec` (ar + en) and the wizard tests pass. Not investigated further |
| `@nuzm/admin` | 372 passed, 1 failed (`KnowledgeIngestion` Design DNA, untouched) |
| `@nuzm/db` / `@nuzm/i18n` | 55 / 9 passed |
| `pnpm spec:lint`, `spec:drift` (520 routes), `sdk:check` | OK |
| `pnpm db:migrate` (throwaway DB), `db:test-rls`, `compliance:classification-coverage` (3448 columns), `ropa-coverage`, `residency-hooks`, `claims-guard`, `scan:secrets` | OK |
| ESLint + Prettier on every changed file | clean. Repo-wide `pnpm lint` still fails on files this sprint did not touch (`PaymentsPanels.tsx` unused `locale`, `design/*.mjs` browser globals) |
**What `hestia-vps.int.spec.ts` covers:** verified-image-only offers and quotes (unverified image, unlisted placement, no digest for the OS, missing/inconsistent mail choice, count > 1, flag off); the order snapshot and the unique order/instance constraint; ONE create with identical user data on retry and a pinned installer digest; wrong credential / wrong address (secret survives) / wrong host, port, key; the whole install to `ready`; replay after a lost answer; concurrent registrations (exactly one wins); expired window → needs attention → resume on the same server; integrity failure not retried; boot timeout, missing DNS, readiness failure and a too-broad key; stop/restart refused only while the installer runs; lost panel link with stop/start still working; timeout after the side effect → reconcile adopts (one create); duplicate queue message; capacity hold in the same region, retried and completed, and cancelled with the authorization released; approval API and withdrawal; approval withdrawn between quote and execution; the customer VPS node (network class, owner, never active, retire).
**Not run:** browser E2E and screenshots of the new screens (CLAUDE.md §4 asks for both: NOT DONE, component tests only); the full `pnpm verify:full`; any live provider or Hestia call.

## F. Security, tenant isolation, billing, residency
- Secrets: registration secret sealed, hash only in the database, deleted on use; panel access key sealed on receipt (vault reference only; test asserts it is absent from every stored row, the audit sink, the node call and API responses); production has no secret store (D-12) so the product reports `unsupported` there instead of falling back.
- The callback is unauthenticated by design but credentialed by the secret; rate-limited; address- and identity-matched against the provider; wrong address never consumes the secret; replay after a lost answer is accepted only from the same server with the same key.
- Bootstrap injection tests: every value interpolated into the root script is validated against a strict pattern; `bash -n` parses the generated script; YAML parsed.
- Tenant isolation: another organization's panel/instance id answers 404; install rows are RLS-isolated; the customer DTO carries no registration, installer digest or provider reference.
- Billing/residency: the cost authorization is created with the order and kept while held; released on cancel, TOCTOU veto or definitive failure; residency is evaluated at quote and again at execution exactly as for any compute order; the held order never leaves its region.

## G. Human gates and live checks still needed
HG-05-05 (Alibaba SCCC `me-central-1` account/network/image ids, one paid test server), HG-05-06 (Contabo EU test VPS), D-53 (panel DNS zone/provider), D-54 (approved Hestia version and installer digests), D-12 (production secret store). Live checks listed in the runbook §4.

## H. Acceptance
| Item | Status |
|---|---|
| Panel choice on the purchase page, stored in the order snapshot (image, template, region, provider plan) | PASS (local: API + wizard tests) |
| Only images verified for Hestia are offered | PASS (local) |
| Alibaba `UserData` (Base64) and idempotent `ClientToken`; SCCC Riyadh `me-central-1` placement | PASS against the simulator; **NOT VERIFIED** live; SCCC account access to the region BLOCKED (HG-05-05) |
| Contabo `userData`, reconcile before any resend, EU placement | PASS against the simulator; **NOT VERIFIED** live (HG-05-06); `userData` length/encoding NOT DOCUMENTED |
| Pinned installer + integrity check before running | PASS (local); the Hestia version and digests are the owner's input (D-54) |
| Single-use registration bound to one order and server; identity + address match before registering | PASS (local) |
| Staged status, idempotent and resumable, no second server on uncertainty | PASS (local) |
| No automatic cross-region fallback; held order with a clear reason; free cancel | PASS (local) |
| Customer VPS outside the shared network; panel link lost while provider actions stay | PASS (local; node registry real, panel calls faked) |
| Start/stop/restart from the provider API with status | PASS (local; existing flow, tested with a lost link) |
| Panel DNS name for the server | BLOCKED (D-53): port + double only |
| Real Hestia install, `v-add-access-key` output shape, `API_ALLOWED_IP` | NOT VERIFIED (first live install) |
| E2E test and screenshots of the new screens | NOT DONE |
| Admin screens for approvals / install monitor | NOT BUILT (API only; S05) |

## I. Next-milestone handoff
S05 (admin screens for image approvals/install monitor, file manager, site tools, business email) can read `compute.panel_installs`, `hosting.nodes.network_class` and the panel status API. S06 (backups, acceptance tests) must treat `customer_vps` nodes as out of scope for shared-site isolation tests and use `held`/`needs_attention` fixtures from `hestia-vps.int.spec.ts`.
