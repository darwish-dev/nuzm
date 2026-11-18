# S19 report — Alibaba ECS adapter II: provision, inspect, actions, delete, metrics, bill reconciliation input, conformance (M05 sprint 19)

Status: implemented and tested **offline against a local simulator shaped from the official documentation. NOT VERIFIED. Live rows BLOCKED (HG-05-01, HG-05-04).** No Alibaba call, account or credential exists. Citations (page + read date 2026-11-18) are in [packages/adapters/alibaba-ecs/README.md](../../packages/adapters/alibaba-ecs/README.md).

## A. Repository findings and assumptions
- The whole `AlibabaEcsAdapter` (S18 auth/regions/catalog/pricing + S19 lifecycle/billing) is committed here (see S18 §A). Packages: `@nuzm/adapter-alibaba-ecs`.
- Documentation facts that shaped the design: `RunInstances` has `ClientToken` (≤ 64 ASCII; replay returns the first response) but it is **not queryable** → `findByToken` uses a `nuzm-token` instance tag; `DryRun` exists on RunInstances/Start/Stop/Reboot/ModifyInstanceSpec/DeleteInstance → the probe proves permission with DryRun only; `CreateSnapshot` has no documented DryRun → `unknown`; resize needs the instance **Stopped**; a snapshot is a **disk** snapshot; billing amounts are major-unit numbers (minor units NOT DOCUMENTED).
- Assumptions recorded: 2 minor digits for CNY/USD (ISO 4217), hourly price rounded up, billing rounded to 2 decimals; VPC networking is configuration (the creating APIs were not read); one SSH key per instance (`KeyPairName`); `DescribeInstanceTypes` filtered to ≤ 8 vCPU, ≤ 32 GiB and `maxPlansPerRegion` 20 (catalog scope is configuration, not vendor truth).
- Not documented (adapter does not guess): HTTP status of `DryRunOperation`, error-body schema, ClientToken validity window, describe-after-write lag, `StopInstance` valid prior states, BSS endpoint for a Riyadh-region account.

## B. Plan and changed files
`packages/adapters/alibaba-ecs/src/{adapter,sim,test-subject,index}.ts`, `adapter.spec.ts`, `conformance.spec.ts`, `README.md`; `docs/reports/evidence/M05/alibaba-ecs-conformance.json`.

## C. Implemented features
`probe` (reads + DryRun), `health`, `listRegions` (account listing; only regions with a documented country; `soldOut` regions skipped; `verifiedAt` from live evidence only), `listPlans` (stock → availability, DescribePrice → integer minor units), `listImages`, `catalog`, `quote` (DescribePrice), `provision` (ImportKeyPair + RunInstances with ClientToken, tags, network config), `inspect`, `findByToken` (tag search across listed regions; unsearchable region ⇒ `failed`, never `null`), `act` start/stop/reboot/resize/snapshot, `delete` (Force=true; NotFound ⇒ succeeded), `metrics` (DescribeInstanceMonitorData, documented units and 400-point rule), `fetchBilling` (DescribeInstanceBill paging, array or `Items.Item[]`). Error normalization keys on the documented code names first. A timeout/connection error/HTTP 500/503 on a mutating call ⇒ `uncertain`. `AlibabaSim` verifies the V3 signature and answers documented shapes.

## D. Migrations and rollback
None.

## E. Tests run, with actual results
| Command | Result |
|---|---|
| `pnpm --filter @nuzm/adapter-alibaba-ecs test` | 3 files, **24 passed**: signer (2), conformance kit (15 cases C01–C15 via `runComputeConformance`, **15/15**, `evidenceKind: fixture`, `liveStatus: NOT VERIFIED`), adapter specs (21 incl. DryRun probe truthfulness, no-instance ⇒ unknown, no-network ⇒ unknown, Forbidden.RAM ⇒ unsupported, region/plan/price rounding, live-kind logic test, ClientToken/tag wiring, local validation, capacity/rate-limit/503, resize conflict then success, snapshot, idempotent delete, restart-case findByToken, unsearchable region, metrics, billing paging, auth failure + canary, error table) |
| conformance report | `docs/reports/evidence/M05/alibaba-ecs-conformance.json` |
| `eslint`, `tsc` typecheck/build of the package | clean |
Caveat recorded in the README: the kit resizes a **running** instance (ECS refuses), so the kit run uses a simulated RAM user that may not call `ModifyInstanceSpec` (⇒ `resize` unsupported); resize has its own spec (stop first).

## F. Security, tenant isolation, billing, residency verification
Canary: the access-key secret never appears in probe/health/provision output or evidence (value redaction + key redaction). Egress `*.aliyuncs.com`, https only, no redirects. Provider tags carry only the opaque org hash. Billing capture produces `ProviderCostRecord`s only; ledger/metering postings are S23/M02. Residency: the adapter returns regions only from the account listing; `ResidencyPolicyService` calls are the orchestrator's (S17).

## G. Human gates and live checks still needed
HG-05-01 (account, least-privilege RAM user incl. the RunInstances dependent actions, Saudi eligibility), HG-05-04. Live job `live-verify-alibaba` (definition in S23) is human-triggered.

## H. Acceptance checklist
| Row | Status | Evidence |
|---|---|---|
| Conformance kit on fixtures (S19 task 16) | **PASS (fixture; NOT VERIFIED live)** | `alibaba-ecs-conformance.json` 15/15 |
| AC-M05-16 Alibaba provision/inspect/actions/delete live | **BLOCKED (HG-05-01, HG-05-04)** | — |
| AC-M05-20 RC-04 on real bills | **BLOCKED (HG-05-01..03)**; fetch/parse logic PASS on fixtures | `adapter.spec.ts` billing test |

## I. Handoff
Core wiring: `new AlibabaEcsAdapter({ vault, redactor, transport: createFetchTransport({ policy }), network })` returned by an `AdapterEntry` (see S23 for the registry entry). Open: live acceptance of the hand-written signer; live behaviour of ClientToken replay, tag-lookup consistency, DryRun semantics; per-region VPC provisioning.
