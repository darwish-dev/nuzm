# Provider onboarding (M05)

Status: S16 deliverable. Everything below works against the `mock` provider today; real vendor accounts need HG-05-01..03 (human-supplied sandbox/test credentials) and the vendor adapters of S18-S22. **Nothing here asserts what a vendor offers.**

## Rules
1. A provider account stores a **vault reference** (`vault://…`) only. The API refuses credential values with `422 credential_value_rejected`; the database refuses a non-`vault://` reference (CHECK); no table has a secret column.
2. Credentials are resolved by the adapter through the `VaultClient`. The non-production stub (`FileVaultClient`, file given by `NUZM_DEV_VAULT_FILE`) refuses to start in a production profile: **production vault use is BLOCKED on D-12 / HG-01-02.**
3. A capability is `supported` only if the account's probe said so (evidence stored); everything else, including never-probed, is `unknown` = unsupported.
4. A region is `verified` only if the account's own region listing contained it **and** evidence was recorded (`verified_at` + `evidence_ref` + `evidence_kind`, DB CHECK). Evidence of kind `mock`/`fixture` is never live verification: only `live` evidence can support a `LIVE-VERIFIED` label (CLAUDE.md §5).
5. Least privilege: create a dedicated provider user with the minimum permissions the adapter needs (listed in each adapter README with a citation of the vendor's official page and the date read — S18+ deliverable) and tag test resources `nuzm-live-verify`.

## Steps (admin console realm, MFA-verified platform session, permission `admin:provider:manage`)
1. `GET /v1/admin/providers` — confirm the provider exists and `adapterAvailable` is true. (`false` = no adapter implementation in this deployment; verification will fail with `adapter_not_available`.)
2. `POST /v1/admin/provider-accounts` `{providerId, name, credentialRef:"vault://<env>/<provider>/<account>", scopeNote, spendCap?}`. A human places the credential in the vault; the agent never creates or reads real credentials.
3. `POST …/{id}/verification` → `202 {operationId}`; poll `GET /v1/admin/provider-jobs/{id}`. The job resolves the vault reference, runs the capability probe, lists regions with evidence and plans, records health.
4. Read the results: `GET …/capabilities`, `…/regions`, `…/plans`. Anything not listed is not offered.
5. Re-run `POST …/catalog-syncs` on a schedule/when prices change. A region that disappears from the listing becomes `withdrawn` and its offers vanish immediately.
6. Health: `CLOUD_HEALTH_INTERVAL_SECONDS` (>= 5, default 0 = off) enables the scheduled health sweep; the circuit-breaker state is part of the account representation (`health.breaker`).

## Audit events
`provider.registry.created`, `provider.account.created|updated|verified|health_changed`, `provider.verification.requested`, `provider.catalog.requested|synced`, `provider.capability.changed`, `provider.job.failed`.

## Egress
`spec/providers/providers.yaml` holds the per-adapter egress allow-list. Real vendors have an **empty** list until their adapter is written from the official documentation; an empty list means no outbound call is possible (`assertEgressAllowed`, https only, no IP literals, no private/loopback hosts).

## Before offers can appear (S17)
Offers (`GET /v1/offers`) need **all** of: the feature flag `cloud.provisioning` on (global or per org; default OFF); a verified account (healthy, breaker closed, `compute.provision|inspect|delete` supported); a region with fresh verification evidence (`CLOUD_REGION_VERIFICATION_TTL_DAYS`, default 7); an available plan with a provider price; a **Nuzm price** in the effective price-book version for `compute.vcpu_hours`, `compute.memory_gb_hours` and `compute.disk_gb_months` (D-23 pricing/margin policy is OPEN: offers without a Nuzm price are hidden); the provider registered as a **processor in ROPA** (otherwise the M04 residency service denies every placement and every offer is hidden); a residency decision `allow` for the region; and an organization entitlement for the `compute` quota group (the free plan has limit 0) plus headroom under `compute_instances` / `compute_vcpu` (PROPOSAL defaults 10 / 40 via `NUZM_COMPUTE_DEFAULT_MAX_INSTANCES` / `NUZM_COMPUTE_DEFAULT_MAX_VCPU` when an org has no entitlement).
In production profiles only evidence of kind `live` makes a region count as verified, and providers with `environment_policy = non_production_only` (the `mock` simulator) are never offered.
