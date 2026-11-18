# S24 — CloudPanel validation spike + node inventory PoC (M06)

Owner-directed exception recorded: M06 started before M05 exists on this base (`docs/reports/M06-m05-interface-assumptions.md`).

## A. Repository findings and assumptions
Base = `integration/main-m04-s12d` (M04 compliance + M03 S12d). No M05 code: nodes reference compute instances by an opaque id through `ComputeProvisioningPort` (mock). Migration range 0800–0899 per `spec/db/ownership.yaml` (brief said 700–799). ADR-017 is taken → ADR-020.

## B. Plan and changed files
- Spike: `docs/reports/evidence/M06/cloudpanel-spike-findings.md` (26 cited rows), `docs/adr/ADR-020-cloudpanel-automation-path.md` (Proposed), `docs/runbooks/node-agent-threat-model.md`, `docs/runbooks/node-onboarding.md`.
- Migrations: `hosting/0800` (nodes, node_agents, node_enrolment_tokens, node_capacity, node_overcommit_changes, node_command_log), `hosting/0801` (plan_definitions, sites, site_allocations + commit-time capacity ledger trigger).
- Code (`apps/api/src/modules/hosting/`): agent envelope (Ed25519), allow-list + argv builder, agent runtime (replay ledger, audit chain), mock CloudPanel node, `CloudPanelHostingAdapter`, `NodesService`, admin controllers.
- Spec: 7 operations under `/v1/admin/hosting/{nodes,agents}` in `spec/openapi/openapi.yaml`; SDK regenerated; ownership manifest; residency hooks; classification (1150 columns).

## C. Implemented
Admin APIs: list/create/get/patch nodes, capacity, inventory run, enrolment tokens, command log, agent list. Node status machine; dual-approval overcommit; single-use enrolment; agent audit shipping with chain verification. UI for these screens is not built yet (see S27).

## D. Migrations and rollback
0800/0801 with `.down.sql` (dev/staging only; production forward-fix).

## E. Tests run (actual)
- `vitest` unit (`src/modules/hosting`): agent envelope/allow-list/injection (25), adapter conformance + reconcile (12 incl. 500 injected lost-reply runs), isolation suite (30 cases) = 67 passed.
- `vitest --config vitest.integration.config.mts src/modules/hosting`: nodes lifecycle, overcommit dual approval, DB invariants, audit shipping, tenant isolation = 16 passed.
- `pnpm db:migrate`, `pnpm db:test-rls`, `pnpm compliance:classification-coverage|ropa-coverage|residency-hooks`, `pnpm spec:lint`, `pnpm spec:drift`, `pnpm sdk:generate`: OK (see M06 report for the final run).

## F. Security / isolation / residency
Allow-list closed schemas; no shell; tokens hashed; node tables reachable only in admin scope (verified: org scope reads 0 rows). Mock isolation results are NOT VERIFIED for a real node.

## G. Human gates / live checks
HG-06-01 (licence review is a hard input: see findings row 24), HG-05-0x, D-20 acceptance, HG-12-01.

## H. Acceptance
| Row | Status |
|---|---|
| AC-M06-01 ADR with ≥ 8 cited rows + recommendation | PASS (26 rows, `ADR-020` + findings; docs analysis only) |
| AC-M06-14 envelope rejection ≥ 10 cases, allow-list | PASS on the mock agent (`agent.spec.ts`: 13 envelope cases + allow-list + injection); NOT VERIFIED on a real agent |
| AC-M06-15 RLS cross-tenant `hosting.*` | partial (nodes/allocations tables verified; org tables in S25) |
| AC-M06-17 D-20 decided | BLOCKED (owner decision + node evidence) |

## I. Handoff
S25 scheduler/lifecycle builds on `site_allocations` + `node_capacity`.
