# S21 report — Huawei ECS adapter II: lifecycle, metrics, bill capture, conformance (M05 sprint 21)

Status: implemented and tested **offline against a local simulator shaped from the official documentation. NOT VERIFIED. Live rows BLOCKED (HG-05-02, HG-05-04).** No Huawei call, account or credential exists. Citations (page + read date 2026-11-18): [packages/adapters/huawei-ecs/README.md](../../packages/adapters/huawei-ecs/README.md).

## A. Repository findings and assumptions
- Whole `HuaweiEcsAdapter` committed here (see S20 §A). Package `@nuzm/adapter-huawei-ecs`.
- Design decisions from the documentation: create is idempotent through `X-Client-Token` (UUID, **8 h**) but servers cannot be found by it and the `tags=` filter syntax is NOT DOCUMENTED ⇒ the token is also embedded in the server **name** (`nz-<token>-…`, documented fuzzy `name` filter) and `findByToken` filters client-side; a replay after 8 h looks up first. ECS has **no snapshot API** ⇒ EVS boot-volume snapshot. All lifecycle calls are async jobs ⇒ `accepted`; `delete` is `succeeded` only if one job check already says `SUCCESS`. HTTP **202** is documented for `Common.0024` (flow limit) ⇒ a 2xx with an error body is a refusal.
- **Capability honesty:** there is no read-only/DryRun proof for provision/start/stop/reboot/resize/delete/snapshot, and the Create `dry_run` flag is deliberately not used by the probe (a mis-honoured flag would create a billable server). In the default `read-only` mode every mutating capability is therefore `unknown` (= unsupported) until a human-triggered live verification; `capabilityMode: 'documented'` (fixture runs only, refused against live endpoints) lets the conformance kit exercise them. **Consequence for the core:** Huawei offers cannot appear before live verification records capabilities — intended.
- VPC/subnet/security-group creation APIs were not read ⇒ networking is configuration; without it provisioning is rejected.

## B. Plan and changed files
`packages/adapters/huawei-ecs/src/{adapter,sim,test-subject,index}.ts`, `adapter.spec.ts`, `conformance.spec.ts`, `README.md`; `docs/reports/evidence/M05/huawei-ecs-conformance.json`.

## C. Implemented features
Auth in two modes (AK/SK; IAM token cached 23 h), `probe` (reads only), `health`, `listRegions` (IAM project list), `listPlans` (flavors + `os_extra_specs` availability + BSS price), `listImages` (IMS), `catalog`, `quote`, `provision` (V1.1 Create), `inspect`, `findByToken`, `act` start/stop/reboot (batch action API, SOFT), resize (V1.1, must be stopped), snapshot (EVS), `delete` (EIP + volumes released), `metrics` (CES `cpu_util`, ≤ 3000 points), `fetchBilling` (usage details). Option `disabledCapabilities` lets the owner switch capabilities off. Error normalization keys on the documented codes (`Ecs.*`, `Common.*`, `APIGW.*`, `CBC.*`); timeouts/5xx on mutations ⇒ `uncertain`.

## D. Migrations and rollback
None.

## E. Tests run, with actual results
| Command | Result |
|---|---|
| `pnpm --filter @nuzm/adapter-huawei-ecs test` | 3 files, **22 passed**: signer (2), conformance kit **15/15** (`evidenceKind: fixture`, `liveStatus: NOT VERIFIED`), adapter specs (19: read-only probe leaves mutations unknown and creates nothing; documented mode refused for a live endpoint; regions in both auth modes; live-kind logic test; plan availability + price rounding; client-token UUID / name / tags / user_data; replay after 8 h; local validation; capacity/429/HTTP-202/500 mapping; resize conflict then success; EVS snapshot; delete + idempotent second delete; restart-case lookup and unsearchable region; inspect mapping; metrics; billing paging; canary secrets in both auth modes; error table) |
| conformance report | `docs/reports/evidence/M05/huawei-ecs-conformance.json` |
| `eslint packages/adapters`, `prettier`, `tsc` typecheck/build | clean |
Caveat: the kit resizes a running server (forbidden by the docs), so the kit run disables `resize`; it has its own spec.

## F. Security, tenant isolation, billing, residency verification
Canary: AK/SK secret, IAM password and issued tokens never appear in probe/health/provision output or evidence (both auth modes). Egress `*.myhuaweicloud.com`, https only, no redirects. Tags carry only the opaque org hash. Billing capture yields `ProviderCostRecord`s only (ledger/metering are M02/S23). Residency: regions come only from the account's project list; policy calls are the orchestrator's.

## G. Human gates and live checks still needed
HG-05-02 (account; least-privilege IAM user incl. EIP/VPC dependencies; Saudi eligibility), HG-05-04. Live verification must also establish: client-token replay, name-filter consistency after create, delete-of-missing behaviour, the EVS snapshot action permission, job-query permission, gateway acceptance of the signer.

## H. Acceptance checklist
| Row | Status | Evidence |
|---|---|---|
| Conformance kit on fixtures | **PASS (fixture; NOT VERIFIED live)** | `huawei-ecs-conformance.json` 15/15 |
| AC-M05-18 Huawei lifecycle live | **BLOCKED (HG-05-02, HG-05-04)** | — |
| AC-M05-20 RC-04 on real bills | **BLOCKED (HG-05-01..03)**; fetch/parse logic PASS on fixtures | `adapter.spec.ts` billing test |

## I. Handoff
Wiring: `new HuaweiEcsAdapter({ vault, redactor, transport: createFetchTransport({ policy }), network, projectIds? })`. Open: live behaviours listed in §G; the job outcome of an async create is not surfaced by the contract (a failed create job looks like a server that never appears ⇒ the reconciler's `missing`/timeout path).
