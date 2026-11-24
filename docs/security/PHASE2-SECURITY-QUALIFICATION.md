# AI Agent Engine: Phase 2 security qualification summary

Author: Session 07 (QA, security, compliance) · 2026-11-24 · Scope: everything built by Sessions 01–06 on `integration/ai-engine` for the AI Agent Engine (providers, benchmarks, sandbox / Execution Gateway, builder tools and agent loop, deployment, QA gates).

**Read this first.** Nothing in this repository has run against a real model provider, a real isolating runtime, a real hosting node or a real deployment. Every green result below is **SIMULATED** (a scripted model, a mock execution port, an in-memory publisher) or **OFFLINE** (pure code). A simulated result proves the control logic, the data model, the authorization and the accounting; it proves nothing about isolation strength, model behaviour, vendor pricing or network reality. No row in the right-hand column of section 2 is `LIVE-VERIFIED`, and none may be turned into one by a mock (CLAUDE.md §6). This document is a QA statement, not an external audit and not a certification.

Evidence vocabulary: `SIMULATED` = produced against a stand-in, `NOT VERIFIED` = implemented, live validation missing, `LIVE-VERIFIED` = only after a recorded live check with evidence (none exists), `BLOCKED (HG/D-xx)` = cannot start without an owner action.

## 1. Method
- Independent review of the existing code (gateway, budgets, secret scan, SSRF/egress, sandbox policy and local runtime, deploy, mobile signing, access guard), then a threat model of the new ports (`docs/security/AI-ENGINE-THREAT-MODEL.md`).
- Adversarial and dynamic tests in `apps/api/src/qa/**` (own paths only), each run alone against its own PostgreSQL, real RLS and the real hash-chained audit sink where relevant. 15 defects were found; 15 are fixed and re-tested by flipping the `it.fails` marker; DEFECT-16 and 17 (coverage gaps of the O-9 content-access switch) are fixed too (`docs/security/DEFECT-REGISTER.md`).
- Browser E2E specs written by other sessions were reviewed read-only (`PHASE2-E2E-REVIEW.md`); a negatives spec was added (`e2e/tests/qa-negatives.spec.ts`). **No browser run has passed yet: UI evidence is NOT VERIFIED until the Master's isolated E2E has run.**

## 2. What was verified, and what could not be (by control area)
| Control area | Verified offline / simulated (evidence) | LIVE-VERIFIED | What cannot be verified until |
|---|---|---|---|
| Tenant isolation (RLS, org context from verified auth) | live authorization matrix over every organization route (401 without session, 404 for a non-member, 403 for a role lacking the permission, for five roles); cross-tenant tests on every new surface (AI, builder tools, deploy, policy routes, approvals, runs, budgets, usage, benchmarks) | none | real multi-tenant load and a production database role set |
| Authorization and approvals | owner/admin-only decisions for `production_deploy`; API keys refused (DEFECT-4, -6 fixed); developer self-confirm and rollback approval governed by both policy settings (O-1/O-2) for every role; billing-admin content access policy (O-9); scope-hash and run binding; one decision under race (DEFECT-13 fixed); approvals closed on cancel (DEFECT-14 fixed) | none | owner decision on the default of O-1/O-2/O-9 (switches default to today's behaviour) |
| Audit (append-only, hash chain) | contiguous and time-monotonic under 25 concurrent mutations; edit, deleted-middle, deleted-tail and actor-swap tampering each detected by `verify_chain`; runtime roles cannot update, delete, truncate, read or rewrite chain heads, or disable triggers; no secret, canary, key shape or prompt body in any audit row | none | retention/archival under legal hold, signed external anchoring (checkpoint key custody is a dev stub, D-12) |
| Money: ledger, wallet, reservations, metering | usage = ledger = wallet per call and in total; no charge without a usage record, including 60 calls over 6 runs in parallel (DEFECT-7 fixed); one provider call per call id (DEFECT-8 fixed); failed calls never charged; no double release; reservations never oversell; budgets and run caps never exceeded | none | real provider pricing and usage reporting (D6), real FX, tax determination for AI consumption |
| Credential custody | a console-typed provider key is sealed in the secret store and appears in no response, no process output and no row of any table of any schema (full-database scan); non-admins cannot set or clear one; connection test never called | none | a real vault, real keys, a real provider connection test (D2–D9) |
| Outbound secret scanning | 26 secret shapes caught, 8 false-positive controls (DEFECT-9 fixed); canaries exact-match | none | production prompt corpora; encoded-secret evasion is not covered (O-14, by design) |
| SSRF and egress | 36-address corpus incl. IPv6 spellings of private IPv4, SIIT, discard prefix (DEFECT-2, -3 fixed); URL attacks; `safeFetch` rebinding; sandbox egress policy | none | real DNS, real network paths, cloud metadata endpoints on a real node |
| Execution Gateway policy and orchestrator | closed profiles only; model cannot supply argv/env/cwd; kill switch; quota; approval spent once; concurrent submits idempotent (DEFECT-10 fixed); conflicting key refused; forged/altered/foreign decisions refused by the port; hostile artifact paths and kinds refused; output screening | none | a real runtime behind the port |
| **Sandbox runtime isolation** | the escape suite (suite 1.1.0, 277 attempts) runs against the mock and a simulated node: control-plane attempts pass, **isolating-runtime attempts are NOT VERIFIED**; local dev runtime is `isolation: none`, dev-only, symlink confinement fixed (DEFECT-5) | **none, and none is claimable** | **BLOCKED (D-21, HG-10-02, ADR-067 acceptance, a Linux non-production node)**. A mock cannot prove isolation. See section 5 |
| Provider integration (Claude) | adapter contract, capability evidence, retry/breaker/fallback, rate cards, versioned rate card history, live-verification suite with a mock twin; the smoke runner refuses to run without recorded owner decisions | none | **BLOCKED (D2, D3, D4, D5, D6, D9)**; real latency, errors, streaming, tool calls, usage accounting |
| Benchmarks | dataset 2.1.0 locked, deterministic scorers, staged qualification A–E with priced budget; the live runner is sealed behind gates and was never run; offline oracle replay only | none | verified provider + budget + accepted thresholds + named reviewers |
| Builder agent loop | exhaustive: cancel after every checkpoint and crash after every boundary resume to the same result (one change, one approval, no repeated step); repair/step/time limits hold for hostile inputs; closed execution profiles; token and credit stops; no permission = nothing applied; approval never self-granted; prompt injection in project files, build logs, an obedient model or repair strategy changes no permission, approval, limit, budget or membership; forbidden paths never applied | none | real model behaviour under injection, real build output, real execution |
| Deployment | publish and rollback approvals (both policy settings); target model (real target needs approval reference, preview domain, evidence); preview-origin isolation (ADR-060), 64-bit tags; simulated health probe; in-memory publisher | none | **BLOCKED (HG-05, HG-06)**: a real node, panel access, DNS, TLS issuance, rollback on a real release |
| Migrations | up/down/up for every migration from 1800 with a full schema fingerprint (tables, columns, constraints, indexes, triggers, RLS, policies, functions) | none | upgrade of a populated production database |
| Browser UI (ar/en, axe) | specs written (S02, S03, S05, S07 negatives) | **NOT VERIFIED: none has run** | the Master's isolated E2E |

## 3. What no offline test can establish (the honest list)
1. **Isolation strength of any runtime** (filesystem, process, network, resource, secret and cross-tenant isolation under hostile code). Mock results are never evidence (`MockExecutionPort.origin = 'MOCK'` is stamped in every audit record and job view).
2. **Behaviour of a real model**: prompt-injection resistance beyond scripted "obedient" models, tool-call quality, refusal behaviour, structured-output reliability, token accounting.
3. **Real prices, rates and usage numbers**: every rate in the repository is a placeholder or a labelled list price.
4. **Real network behaviour**: DNS rebinding in the wild, redirects, TLS, proxy behaviour, cloud metadata reachability.
5. **Real deployment and rollback** on a hosting node, SSL issuance, DNS takeover resistance of preview names.
6. **Performance and scale**: all concurrency tests use tens of requests; none says anything about throughput, lock contention at scale or queue fairness under production load. DEFECT-7's fix serialises on the organization's balance row: its throughput impact is untested.
7. **Operational controls**: alerting, on-call, backup and restore, key rotation, incident runbooks.
8. **Legal and regulatory**: residency opinion, data-processing terms with the provider (D1/D2), ZATCA, retention. No compliance claim is made here.

## 4. Residual risks (all 17 defects fixed)
| # | Risk | Likelihood / impact | Where it is controlled or tracked |
|---|---|---|---|
| R1 | A runtime that does not isolate is wired behind the port | Low (fail-closed gate, attestation required, REAL port refused while the gate is closed) / critical | gate `executionGate`, attestation verifier, HG-10-02; section 5 |
| R2 | A real model obeys injected instructions in ways the scripted models did not | Medium / medium: bounded by the closed tool set, the change checks (forbidden paths), human approval for deploy, and budgets | tools have no power beyond their permissions; re-test with the real model at Stage A–E |
| R3 | The approval reference of a real target is only format-checked (O-15): a made-up reference unlocks a NOT VERIFIED real target | Low / medium | owner-signed record stays in the approval pack; the registry of targets is a platform action |
| R4 | Encoded secrets (base64, hex, split) pass the output canary screen (O-14) | Low while the runtime holds no platform secret / medium | env guard; keep "no platform secret in the runtime" as a qualification criterion |
| R5 | The local dev runtime (`isolation: none`) is enabled outside development by a misconfigured environment (O-4) | Low / high | refuses to start when `NODE_ENV=production`; make it refuse unless an explicit dev marker is present in every non-local environment |
| R6a | The O-9 `deny` setting is only as complete as the audit: 25 content routes are covered and re-tested; a NEW route that returns customer content added later is readable to billing_admin until it carries the shared guard; approvals free text is redacted for non-financial types under deny (financial types stay whole by design) | Medium over time / medium | re-run `qa-o9-content-access.int.spec.ts` in CI (it enumerates the routes dynamically); the financial-approval exception is a product decision to keep |
| R6 | Policy switches O-1/O-2/O-9 keep today's permissive defaults until the owner decides | Certain until decided / medium (developer can self-confirm production publish; billing admin can read project content) | switches exist and are tested in both settings; default change needs a recorded owner decision |
| R7 | Concurrency fixes serialise per organization (DEFECT-7: the balance row; DEFECT-15: an advisory lock on run creation): possible latency under many parallel runs or creates of one organization | Medium at scale / low | load test needed before enabling for large tenants |
| R8 | Idempotency error for duplicate in-flight call ids is the generic `conflict` code (nit) | Low / low | registry code recommended |
| R9 | Supply chain: dependency installation runs with network only under an approved profile; the policy refuses git/URL/path dependencies and foreign registries, but no real registry mirror or advisory feed was exercised | Medium / high once a real runtime exists | dependency policy, SBOM and advisory gates before HG-10-02 |
| R10 | E2E evidence missing for the new screens | Certain until run / low | Master's isolated E2E; qa-negatives spec |
| R11 | Preview and custom-domain security (DNS takeover, wildcard TLS, cookie scope) is design-level only | Medium / medium once a real preview domain exists | ADR-060 checks in code; verify on the staging node |
| R12 | Audit checkpoint signing key is a dev stub (D-12) | Certain until a real key custody exists / medium | external anchoring, key custody decision |

## 5. HG-10-02 reviewer brief: what an external reviewer must test before any customer-code execution
Purpose: HG-10-02 is the human gate that says an isolating runtime was reviewed by someone other than the people who built the platform. Our offline work can narrow the question; it cannot answer it. The reviewer must produce evidence (command output, logs, configuration dumps with hashes), not an opinion.

**Inputs we provide (all in the repository):**
- the control plane: `packages/domain/src/ai/execution-gateway/**` (policy, orchestrator, attestation schema and verifier, real-runtime service and node contract `WorkspaceRuntime`, dependency policy), `apps/api/src/modules/appbuilder/internal/sandbox/**`;
- the escape-attempt suite 1.1.0 (277 attempts) with its runner CLI (`escape-runner.cli.ts`, endpoint adapter) and the conformance suite with 22 synthetic fixtures (`docs/security/sandbox/ESCAPE-SUITE-1.1.md`, `VERIFICATION-PLAN.md`);
- `docs/parallel/RUNTIME-QUALIFICATION.md`, `docs/security/sandbox/RUNTIME-EVALUATION.md`, `RECOMMENDED-ARCHITECTURE.md`, `RUNBOOK-EXECUTION.md`, the threat model and this document.

**What the reviewer must establish (each with recorded evidence):**
1. **The target is what the attestation says.** Kernel and hypervisor versions, the sandbox technology (a hostile multi-tenant target needs a microVM or a user-space kernel sandbox, not a plain container: `runc`, rootless Docker and a pod without a sandbox runtime class are not acceptable), host hardening, a dedicated non-production node with no owner secrets and no route to production data. The signed isolation attestation verifies and is not expired (the service must refuse to start otherwise: test that it does).
2. **Run the escape suite against the real endpoint** and review every `NOT_VERIFIED` isolating attempt (71 in the simulated run): each must become PASS with evidence or a recorded, accepted exception. A single FAIL blocks the gate. Add attempts the suite lacks (below).
3. **Filesystem:** no access outside the per-run workspace (symlink, hard link, `..`, `/proc`, `/sys`, device nodes, mount tricks, `/dev/shm`); read-only root; no residue after cleanup (a later run on the same node finds nothing of an earlier tenant, including `/tmp`, shared memory and page-cache-visible artifacts).
4. **Process and kernel surface:** syscall filtering, capabilities dropped, no privileged mode, no `ptrace`, no `keyctl`, `userfaultfd` and BPF restrictions as designed; resource kills (fork bomb, memory bomb, disk fill, inode exhaustion, output flood, long sleep) end within the declared limits and the node stays healthy for the next tenant.
5. **Network:** default-deny egress; no access to the node's metadata endpoint, link-local, loopback of the host, other tenants' sandboxes, the control plane or the database; DNS only through the controlled resolver; the dependency-install profile reaches only the approved registry; IPv6 and tunneling (DNS, ICMP) tested.
6. **Secrets:** the runtime environment holds no platform secret (the env guard and the canary check are only a second line); inspect the actual environment of a running sandbox from inside; confirm the node agent's own credentials are unreachable.
7. **Cross-tenant:** two tenants' jobs on the same node cannot observe each other (process list, timing, shared caches, `/proc`), and one tenant's termination or quota exhaustion does not affect another.
8. **Control-plane integrity:** the node agent accepts only decisions the gateway issued (forged or altered decision: refused), the approval for a network profile is bound to the exact decision, the kill switch and emergency stop end running work within the documented time, artifacts leave only through the extraction policy (kind, size, count, hash, path).
9. **Supply chain:** dependency policy against a real lockfile corpus with known-malicious patterns (typosquats, install scripts, git/URL dependencies), advisory handling, reproducibility.
10. **Observability and abuse:** audit events present for every execution step with no content, metering of execution minutes, alerts for kill-switch and quota events, the ability to stop all execution in one action.
11. **Residual side channels** the design accepts must be listed and signed (timing, cache, microarchitectural), with the decision that customer code of this class may run on that node.

**Pass criteria:** zero FAIL; every isolating attempt PASS with evidence or an explicitly accepted exception; the attestation verifies; the reviewer's report names the reviewer, date, target identity and the evidence hashes; the owner records HG-10-02 and D-21. Until then the platform must keep `ai.agent.exec_tools` off and the REAL port gate closed.

**What a green result does not mean:** it does not cover a different node image, a kernel upgrade, a different region or a new runtime version: any such change needs a re-attestation.

## 6. Recommended order to close the gaps
1. Run the Master's isolated E2E (ar+en, axe) with `qa-negatives.spec.ts`; record screenshots outside git.
2. Owner decisions: O-1/O-2/O-9 defaults, D2–D9 (provider), D-21/HG-10-02 (runtime), HG-05/HG-06 (deployment).
3. Live provider probe under the recorded budget; re-run the money suites against the real adapter's usage reports (SIMULATED → LIVE).
4. Qualify a runtime (section 5); only then enable `ai.agent.exec_tools` for a pilot organization with a build allowance.
5. Staging deployment rehearsal (preview isolation, rollback) before any production target.
6. Load test the gateway's per-organization serialisation (R7) and the approval inbox under concurrency.

## 7. Re-verification on the merged head
`DEFECT-REGISTER.md` section 3 lists every QA suite re-run one file at a time on the merged head with the counts seen (19 suites, 497 passed, 0 expected-fail).
