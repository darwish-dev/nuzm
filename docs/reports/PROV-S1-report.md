# PROV-S1: Dynadot, provider credentials in the admin console, hosting controls (2026-11-24)

Owner request: integrate Dynadot as a domain reseller; finish the Contabo (Germany), Huawei Cloud and Alibaba Cloud (Saudi Arabia) configuration, with every key and detail entered in the admin console; give the customer console control of a shared-hosting website.

## A. Findings and assumptions
- Contabo, Huawei and Alibaba adapters, the CloudPanel node-agent contract and the registrar framework already existed (M05-M07). What was missing: a Dynadot adapter, any way to type a credential (only `vault://` references were accepted), per-region network details (only the `CLOUD_VENDOR_CONFIG` environment variable), and mutation controls on the customer's website screens (read-only since M06).
- Dynadot has two APIs. The RESTful API's per-command reference could not be read (its page is client-rendered; only two example paths were in the text), so no REST command is used. The Legacy API (`api3.json`) is fully documented per command and is what the adapter speaks; Dynadot marks it "scheduled for retirement" ([D-51](../07-open-decisions-and-blockers.md), `docs/adapters/dynadot.md`, open item DYN-1).
- Typed credentials need somewhere to go: a `SealedVault` over the existing sealed secret store. It works in non-production profiles. **Production stays blocked on D-12** (the vault decision): there, typed credentials answer 422 `unsupported_capability` and only vault references work.
- Contabo's "EU" region has no documented country (SI-M05-7): the platform keeps recording it as "EU" until the owner confirms Germany. Saudi regions (Alibaba `me-central-1`, Huawei `me-east-1`) are offered only if the account's own probe lists them (unchanged rule).

## B. Changed files (main)
API: `common/sealed-vault.ts`; `modules/cloud/internal/{credential-schema,account.service}.ts` + controller (`POST /v1/admin/provider-accounts/connect`, `PUT …/{id}/credentials`); `modules/cloud-vendors/{network-settings.service,admin-provider-network.controller}.ts` + `vendor-adapters.ts`; `modules/domains/internal/{registrar-admin.service,factories}.ts` + controller (`PUT /v1/admin/registrars/dynadot`). New package `packages/adapters/dynadot`. Admin UI: Dynadot settings page, connect / replace-credentials forms, network panel, "verify and enable" on the registrars list. Customer UI: `HostingControls` on the domains, SSL, backups and overview screens. Spec: `openapi.yaml` (+5 paths), `ownership.yaml`, SDK and public API docs regenerated.

## D. Migrations and rollback
`cloud/1940__provider_network_settings` (table, RLS platform scope, no secret column) and `domains/1960__dynadot_registrar` (a disabled registrar row). Down scripts are dev-only; production is forward-fix.

## E. Tests run (this session)
`@nuzm/adapter-dynadot` 5 (conformance kit R01-R14, R18 against the mock; R15-R17 skipped as unsupported); `@nuzm/api` unit 1129 passed; integration: `provider-credentials.int.spec.ts` 5, `domains-dynadot.int.spec.ts` 4; `@nuzm/admin` 365 passed; `@nuzm/i18n` 9; `HostingControls.spec.tsx` 6; `spec:lint`, `spec:drift` (514 routes), `sdk:check`, `scan:secrets`, `compliance:claims-guard`, `compliance:classification-coverage` (3381 columns) OK; eslint clean on every changed file. **Not run:** the whole web unit suite, `pnpm test:e2e`/browser E2E for the new screens, `pnpm lint` as a whole (it fails on the untouched `design/` scripts: 27 `no-undef` errors, pre-existing).

## F. Security
Credentials are write-only end to end: validated per provider, sealed, only the reference stored; tests assert a canary secret is absent from the response, the database rows and the audit events, and that a failed create leaves no orphan secret. Routes need `admin:provider:manage` / `admin:domains:manage` and a recent MFA check. Network settings are identifiers, never credentials. Dynadot's documented transport puts the key in the query string over https: evidence stores the command name only.

## G. Human gates and live checks still needed
- Owner supplies a **Dynadot sandbox key** and runs "Test and enable"; everything stays NOT VERIFIED until a live probe (`LIVE-VERIFIED` needs evidence). DYN-1 (REST API) needs Dynadot's REST command reference.
- Contabo / Huawei / Alibaba: HG-05-01/02/03 (sandbox accounts and keys) and HG-05-04; the owner types the keys and the network ids, then runs Verify.
- D-12 (production vault) before any typed credential can exist in production.
- CloudPanel: the node agent app (`apps/node-agent`) and its outbound mTLS channel are **not built** (HG-06-01, plus the CloudPanel licence review in ADR-020). Until then a running API refuses node commands: the new website controls call the real hosting API, which queues work and answers `unsupported_capability` where no node/sink exists. Files, cron, PHP settings, logs, SSH/FTP access and security remain "soon" cards (no agent commands exist for them).
- Managed databases for a site are M08 (`POST …/databases` answers `unsupported_capability`); no control was added.

## H. Acceptance
| Item | Status |
|---|---|
| Dynadot adapter passes the registrar conformance kit (mock) | PASS (mock evidence only) |
| Dynadot against the real vendor | NOT VERIFIED (no key) |
| Type keys for Contabo / Huawei / Alibaba in the admin console | PASS (dev profile, integration-tested); production BLOCKED (D-12) |
| Network ids per region in the admin console | PASS (integration-tested); live use NOT VERIFIED |
| Customer controls: add domain, certificate, backup, restore, download link, delete | PASS in unit tests and a manual dev check (backup queued); against a real node NOT VERIFIED / BLOCKED (HG-06-01) |
| Admin screens in a browser | NOT VERIFIED: the dev staff identity is not a platform user in the recovered database and no admin credentials were used; the forms are covered by component tests |

## I. Handoff
Next: (1) owner enters sandbox keys and runs the tests above; (2) decide D-12; (3) CloudPanel node agent + licence review (HG-06-01) as its own sprint; (4) Dynadot REST transport when its reference is available.
