# S28 report — registrar contract, Openprovider, search, quote

Branch `claude/m07-domains-8dbe12` (base: main's M04 + M03 S12d). Owner-directed exception: M07 started before M05 exists on this base ([assumptions](M07-m05-interface-assumptions.md)). All vendor results are **NOT VERIFIED** (HG-07-01: no credentials, no sandbox account).

## A. Findings and assumptions
* M05 is not on the base; its S16 code was read **read-only** to align names; the contract is mirrored in `packages/adapters/registrar-contracts` (details in the assumptions file).
* Migration range follows `spec/db/ownership.yaml`: **0900–0999** (the task text said 800–899, which the manifest gives to M06).
* The vendor documentation could only be read through a summarising fetch for Openprovider (730 KB Swagger) and, for ResellerClub, through a white-label copy of the same LogicBoxes knowledge base (the vendor's own site returned 403): see `docs/adapters/*.md` §Gaps. Every operation marked NOT DOCUMENTED there is `unsupported`.
* Prices: provider cost converted with exact decimals (`DOMAINS_FX_JSON`, no rate ⇒ no price) plus `DOMAINS_MARKUP_BPS` (**D-23 open ⇒ default 0**), rounded up.

## B. Plan and changed files
Contract + kit: `packages/adapters/{registrar-contracts,registrar-conformance}`; adapter `packages/adapters/openprovider` (+ `docs/adapters/openprovider.md`); migration `0900__domains__registrars_domains_orders`; module `apps/api/src/modules/domains` (search, TLD policy `spec/providers/tld-policy.yaml`, eligibility, domain pricer, registrar admin); commerce additive edits (pricer result/ctx, DTO `eligibility`); OpenAPI + SDK; errors registry.

## C. Implemented
`GET /v1/domains/search` (60 s availability cache, 15 min catalogue, per-org rate limit, IDN→punycode, blocked TLDs listed with reason and no vendor call), `POST /v1/quotes kind=domain` (per item `{name, years, action}`, exact pricing, tax estimate via M03, `eligibility[]`, residency decision, 15 min expiry, immutable), `GET/POST /v1/admin/registrars`, `POST …/{id}/verification` (probe → capability matrix + TLD support + evidence kind; enabling needs live evidence or an explicit non-production allowance).

## D. Migrations and rollback
`0900` creates `domains.{registrars,registrar_accounts,domains,domain_orders,eligibility_checks}` (+ permissions `domain:*`, `dns:*`, `admin:domains:*`, `domains.resolve_domain()` SECURITY DEFINER lookup). Down script is dev-only; production = forward fix. `eligibility_checks` is append-only (trigger); orders are term-frozen (trigger).

## E. Tests run (actual)
| Command | Result |
|---|---|
| `pnpm --filter @nuzm/adapter-openprovider test` | conformance R01–R18 **18/18 pass** on the **mock** (+3 adapter specifics) |
| `pnpm --filter @nuzm/domain test` (dns-validate) | 120 pass (≥40 valid + ≥40 invalid fixtures) |
| `apps/api … tld-policy.spec` | 6 pass (every Saudi suffix absent ⇒ blocked) |
| `test:integration` `domains-search.int.spec` | 12 pass |
| `test:integration` `domains-quote.int.spec` | 8 pass incl. **100 blocked-TLD attempts ⇒ 422, 0 orders/authorizations/ledger rows** (AC-M07-04, DB assertion) |

## F. Security / tenancy / billing / residency
Vault refs only (a credential value ⇒ `422 credential_value_rejected`); registrar tables are read-all/admin-write by RLS; quotes refuse a registrar the organization's residency policy does not allow (default: **denied** until the ROPA lists the processor, HG-04-01); cross-tenant: quotes are org-scoped; audit `domain.eligibility.blocked`, `domain.search.quota_exceeded`, `registrar.account.created|verified` (the prompt's `registrar.verified` is 2-segment; the audit table needs ≥3).

## G. Human gates / live checks
HG-07-01 PENDING (all adapter evidence is mock/fixture). HG-07-02 PENDING (Saudi TLDs absent from the policy file ⇒ blocked at quote time). D-19, D-23, D-31 OPEN.

## H. Acceptance (S28 slice)
| Row | Status |
|---|---|
| AC-M07-01 (both adapters pass the kit 100% on fixtures/mock) | **PASS on mock evidence only** — vendor evidence **NOT VERIFIED**; recorded fixtures do not exist (no account), so "recorded sandbox fixtures" are replaced by documentation-shaped mock responses |
| AC-M07-04 | PASS (test log + DB assertion) |
| AC-M07-09 (search load p95) | NOT RUN (no load test written; proposal values only) |

## I. Handoff
S29 builds orders on the pricer/eligibility/registry; ResellerClub follows the same kit.
