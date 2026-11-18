# M07 — assumptions about M05 (provider framework), M06 (hosting) and sibling work

M07 was started by **owner direction** before M05 exists on this branch's base (the milestone prompt says "stop if M05 is missing"; the owner overrode that for M06, M07 and M08). This file lists every interface M07 assumes, where the assumption lives in the code, and what to change when the real M05/M06 code is merged. Source of the M05 shapes: a **read-only** look at `claude/m05-provider-core-05b775` (commit `3a11e91`, S16 contracts, plus its uncommitted working tree on 2026-11-18). Nothing was copied blindly, merged or pushed.

**Update (merge into main):** main has since gained M05 (ported onto main's M04). M07 was merged onto it with the conflicts resolved textually (errors, OpenAPI regenerated, i18n/ownership unions, residency-hooks spec, commerce pricer union) and the full suites re-run; the **semantic unification below is still NOT done** (contracts are still mirrored, no `cloud.provider_capabilities` rows are written, hold semantics are not unified, M05's bill source and M07's are both registered through `BillSourceRegistry`/`Sources`). Treat sections 1–9 as the integration backlog.

Status of everything below: **NOT VERIFIED against the real M05/M06**. The mock-based tests prove M07's own logic, not integration.

## 1. `@nuzm/adapter-contracts` (M05 S16) → `@nuzm/registrar-contracts`

| M07 file | What it mirrors | Integration step |
|---|---|---|
| `packages/adapters/registrar-contracts/src/mirror/{errors,redact,vault,token,egress}.ts` | Byte-for-byte copies of M05's files of the same name (contractVersion 1.0.0). A header names the source. | Delete the files; re-export from `@nuzm/adapter-contracts`. Import paths inside the package already use `./mirror/...` only through `src/index.ts`. |
| `…/mirror/base.ts` | The common types of M05 `types.ts` (`AccountContext`, `RawEvidence`, `OperationResult`, `NormalizedError`, `ProviderCostRecord`, `HealthReport`, `AdapterKind` incl. `'registrar'`). `AdapterBase` is **generic** in the report/catalog type because M05's `probe()` returns a compute-shaped `CapabilityReport` keyed by a compute-only `CapabilityId` union. | Make M05's `AdapterBase` generic the same way, or add the registrar ids to its `CapabilityId` union and drop the generics. |
| `…/capabilities.ts` | `registrar.*` capability ids (15). M05 owns `spec/providers/capabilities.schema.json` and a sync test (`capabilities.spec.ts`). | Add the 15 ids to that schema, extend `CAPABILITY_IDS`, delete this file's duplicate list. |
| `…/registrar.ts` | `RegistrarAdapter` per docs/09 §4. Additions beyond docs/09 text: `providerCode`, `inspect`, `setAutoRenew`, `authCode(ctx, name, store)` (never returns the code), `findByToken(ctx, token, {name})` (a name hint, because neither vendor has a client token), `dns.atomicChangeSet`, `parseWebhook(headers, rawBody, {secret, now, toleranceMs})`. | Move to `packages/adapters/contracts` unchanged. |
| `…/http.ts` | `FetchHttpClient` using M05's `assertEgressAllowed`. | Move next to the egress guard. |

Rules M07 applies itself because M05's `GuardedCompute` is compute-typed: `apps/api/src/modules/domains/internal/registrar-access.service.ts` (`AccountGuard` = token bucket + circuit breaker; `guarded()` converts refused calls to definitive `failed` results). **Integration:** replace with M05's generic guard when it is generalised.

## 2. Conformance kit

`packages/adapters/registrar-conformance` is a **separate package** (M07 S28 says "extend `packages/adapters/conformance`"; that package does not exist here and M05's is compute-typed). 18 cases R01–R18 (probe, capability honesty, TLDs, search, register, idempotency, `findByToken` present/absent, timeout after/before, error normalization, renew, transfer-in secret handling, nameserver/lock, webhook signature, DNS change-set honesty, billing minor units, no-float money). **Integration:** move the cases into `packages/adapters/conformance` as `REGISTRAR_CASES` next to `COMPUTE_CASES`; `MemoryVault` can replace M05's file vault in tests.

## 3. Registry tables and the capability matrix

| M07 | M05 | Integration |
|---|---|---|
| `domains.registrars`, `domains.registrar_accounts` (own tables, tenant-less, read-all/admin-write RLS) | `cloud.providers`, `cloud.provider_accounts` | `registrar_accounts.provider_account_id` (nullable, no FK) is the logical link. When M05 lands: create the `cloud.provider_accounts` row, store its id here, and have `RegistrarAdminService.verify` also write `cloud.provider_capabilities` (kind `registrar`). |
| `registrar_accounts.capabilities jsonb`, `tld_support jsonb`, `evidence_kind`, `probed_at` (last probe) | `cloud.provider_capabilities(account_id, capability_id, state, probed_at, evidence_ref)` | The jsonb columns stay as the cached read model; the M05 rows become the source of truth. |
| `vault_ref text` | `cloud.provider_accounts.vault_ref` | Same `vault://` rule (CHECK mirrors `VAULT_REF`). |

Migration range: the manifest (`spec/db/ownership.yaml`, precedence 2) gives M07 **0900–0999** and M06 0800–0899; the task text said "800–899". Followed the manifest: files are `0900`, `0910`, `0920`.

## 4. Vault

`VaultClient.resolve` is the M05 interface. M07 adds `put(secret, label) → vault:// ref` (needed to store a transfer auth code write-only) as `DomainsVaultClient`. Production wiring is `UnavailableVault` (every call refuses; D-12 open), so a production profile cannot read credentials or accept an auth code by accident. Tests/dev use `MemoryVault`. **Integration:** the real vault client needs a `put` (or a one-time-secret API); until then `POST /v1/domains/transfers` with a raw `authCode` answers 503 in production while `authCodeRef` still works.

## 5. Quotes, orders, authorization (M02/M03 on this base, M05 on its own)

* M05 extended `PricerResult` with `residency`/`preferences` and `PriceContext` with `actorUserId` and added error codes. M07 made the **same** additive edits (`commerce/internal/pricers.ts`, `quote.service.ts`) plus `PriceContext.quoteId` (the quote id is generated before pricing so eligibility evidence can reference it) and a customer-visible `eligibility[]` on the quote DTO (only for `kind=domain`). Expect trivial merge conflicts; keep the union.
* M05 added `commerce.authorizations kind='hold'` + `authorization_releases` (migration 0630). M07 **does not use them**: it reserves funds in the ledger (Dr 2100 → Cr 2200 org deferred revenue), recognises revenue only after the registrar confirms (Dr 2200 → Cr 4300 + 2300), and releases with a reversing entry. Both designs satisfy "authorize → record → reconcile"; unify when M05's hold semantics are final.
* `OrderService.setStatus` / `findByQuote` were added to commerce (orchestrators move order status through them; no cross-schema write).
* `ErrorCode` additions identical to M05's text where shared: `unsupported_capability`, `credential_value_rejected`, `quote_expired`. M07-only: `eligibility_blocked`, `domain_unavailable`, `quote_conflict`, `approval_required`, `payment_required`, `transfer_locked`, `etag_mismatch`, `record_invalid`, `consent_required`.

## 6. Residency (M04) — different export names

M05's branch exports `ResidencyPolicyService`; this base (main's M04) exports `ResidencyService` (an `ResidencyEvaluator`). M07 uses the base's API: `evaluate({orgId, dataClass:'personal', targetRegion, purpose:'domain_registration', processorId: providerCode, operation:'write'})`, ROPA processor name = registrar `provider_code`. The M04 default (empty `adapter:registrar` ROPA processors) means **every registrar is denied until the DPO lists the processor and the organization allows the region** — intended (HG-04-01).

## 7. M06 `HostingSiteReadPort`

`HostingSiteReadPort`/`HostingSiteView` are defined in `domains/internal/ports.ts` and exported from the module. Dev/CI wire `InMemoryHostingReadPort` (a **fake**; AC-M07-14 stays BLOCKED). Assumed shape: `{id, orgId, state, targets:{ipv4[], ipv6[], cname|null}, ssl:{state, challenge}}`. **Integration:** M06 implements the port over `hosting.sites`/`ssl_certificates`; M06's `POST /v1/hosting/sites/{id}/domains` calls `DnsLinkageService.applyLinkage(orgId, siteId, domainId, approvedBy)` and its SSL DNS-01 path calls `writeAcmeChallenge/clearAcmeChallenge`. Until then the UI uses the proposed `POST /v1/domains/{id}/hosting-links` (M07-ADD-2).

## 8. Resource inventory (docs/05 vs the M07 prompt)

The M07 prompt says domain events feed `platform.resources_index`. docs/05 (higher precedence) says **no inventory table in `platform`**; `cloud.resources` (M05) is the only inventory. M07 therefore only **emits** outbox events (`domain.registered|renewed`, `resource.state_changed` with `resourceKind` `domain`/`dns_zone`). **Integration:** M05's resource indexer consumes those events into `cloud.resources`.

## 9. finrec RC-04

M03's RC-04 already exists and has a `bills` source hook that returned `null`. M07 added `BillSourceRegistry` (finrec, additive) and registers the registrar statement there. **M05 should register its compute bill source in the same registry** instead of editing the `Sources` object.

## 10. Other shared files touched (append-only)

`packages/i18n/src/messages.ts` (keys `dom.*`, `nav.domains`, `notif.kind.domain.*` appended to both blocks), `spec/db/ownership.yaml` (domains tables, classification, two tenant-less tables), `spec/openapi/openapi.yaml` (a delimited `M07 paths`/`M07 schemas` block + tag `domains`), `spec/openapi/errors.yaml`, `spec/compliance/purposes.yaml` (+`domain_registrant_disclosure`), `spec/compliance/residency-hooks.yaml` (hook `m07-registrant-contacts` → enforced; two tables registered), `apps/api/src/app.module.ts`, `apps/api/src/platform-scope.spec.ts` (`modules/domains/` may use the admin scope), `apps/api/src/modules/identity/testing/app-harness.ts` (optional `override` hook), `pnpm-workspace.yaml` (`packages/adapters/*`, same line as M05), `e2e/playwright.config.ts` (env), `packages/sdk/src/schema.ts` (regenerated: **regenerate after merging**).
