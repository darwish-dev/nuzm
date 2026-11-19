# M10A gate review — PREPARED, NOT SIGNED

Gate (M10 prompt): Reference CRM passes the INDEPENDENT E2E suite; export, deploy and rollback work; isolation validated by the escape-attempt suite. **The gate cannot pass today** (human items). Branch `claude/m10a-finish-c51b35`; evidence and results: `M10-report.md` (§E, §H), `S42-report.md` … `S47-report.md`, `M10-m09-interface-assumptions.md`.

| Gate condition | Status | Evidence / reason |
|---|---|---|
| Reference CRM passes the independent suite | **BLOCKED (PROPOSED-HG-10-03)** | the owner has not frozen `spec/reference/crm-spec.md`; no independent suite author; the agent does not self-certify. The CRM spec in the repository is a development fixture and its tests are not the independent suite |
| Export works | **PASS on the dev release store; NOT VERIFIED live** | export of a real builder project: refused without a lockfile (422 `export_blocked`), 202 with one; archive/SBOM/secret scan tested (`builder-s47`, `m09-real`). Release/export storage is in memory (A-07 OPEN); dependency install from a real lockfile NOT VERIFIED |
| Deploy and rollback work | **PASS on the in-memory fake publisher; live hosting NOT VERIFIED** | `/v1/deployments` for a web-app project: staging → live, health-gate failure restores the previous release, rollback idempotent, production needs hash-bound approvals (`m09-real.int.spec.ts`). Only the static front end is published; the back end and migrations have no compute path |
| Isolation validated by the escape-attempt suite | **BLOCKED (D-21, HG-10-02)** | the sandbox runtime is a dev mock / local-dev runner labelled `simulated` (non-isolated): never isolation evidence; 0 control-plane escapes (policy checks), isolating attempts need a real runner; the security review pack is prepared, UNREVIEWED |
| Integration with the real M09 (runs, projects/versions, artifacts, gateway, credits, deployments) | **PASS** | `m09-real.int.spec.ts` (19 tests on the real services) + unchanged cross-tenant suites; stand-ins remain a dev fallback behind `app_builder.m09_stubs`, never honoured in production |
| Model quality | **NOT VERIFIED** | only M09's deterministic mock provider exists (D-18/HG-09-01 open) |
| UI: screens, 4 states, ar + en, axe, screenshots, browser E2E | **NOT VERIFIED** | screens implemented; web unit tests PASS; `e2e/tests/10-app-builder.spec.ts` written, **NOT RUN** (the owner's app occupies the E2E ports); axe and screenshots NOT RUN |

Open owner decisions: D-21 (sandbox technology), HG-10-02 (review), HG-09-01/D-18 (providers), PROPOSED-HG-10-03 (CRM spec owner + independent author), SCR-M10-01 (Git paths), PA-M10-01 (terminal), PA-M10-02 (approvals inbox routes), HG-05-04 (node-pool quota), D-34 (retention), HG-04-01 (generated-code licensing text), A-07 (release storage on M08), compute-instance publish path (M05/M06), migration numbering for populated databases (1450/1451).

Sections A–I of CLAUDE.md §10 are in `M10-report.md`. Owner signature: ______  Date: ______ (M10B may not be integrated before this is signed).
