# Phase 2 · Session 04 · approval inputs for the execution decisions

Author: Session 04 · 2026-11-24 · For the Master's `OWNER-APPROVAL-PACK`. Every row says what is decided, what the engineering recommendation is, and what each answer does to **development** (the offline work, which never stops) versus **activation** (anything real). No price is stated or invented; where a cost exists, the formula or the owner-supplied input is named. Evidence labels: `SIMULATED` / `NOT VERIFIED` / `LIVE-VERIFIED`. Today every isolation fact is `NOT VERIFIED`.

Background in one paragraph: the Execution Gateway, quota, queue, approvals, audit, kill switch, real-runtime port scaffold (fail-closed on an isolation attestation), conformance suite, synthetic fixtures and escape-suite qualification runner are built and tested offline against stand-ins ([RUNTIME-QUALIFICATION](../RUNTIME-QUALIFICATION.md)). The gate (`executionGate`) is closed; flag `ai.agent.exec_tools` is default off. The machine available (macOS 13, no Docker/KVM/Linux node) cannot qualify any runtime. **Development is not blocked by any item below; activation is blocked by all of them.**

---

## 1. D-21 — isolation technology (and the node pool)
| Field | |
|---|---|
| **Question** | Which technology isolates customer/model-generated code, on what dedicated Linux nodes, in which provider and region, with what budget? |
| **Recommendation** | Qualify **gVisor (`runsc`, systrap) on one dedicated Linux staging node first** (no KVM needed, provider-independent, fastest to a real result). Decide the **production target** after the results: a **Firecracker-class microVM per run** (or Kata+Firecracker) on a KVM-capable dedicated pool if the reviewer requires hardware isolation and the provider confirms KVM/bare metal. Never `runc`-class; never a shared node; never the developer machine. |
| **Alternatives** | (a) Firecracker/Kata first (strongest boundary; needs KVM capability confirmed with the provider before anything is bought; longest to first result). (b) Hardened rootless containers only (**not recommended**: not an isolation boundary against hostile code; would only be acceptable for a non-customer internal tool, which this is not). (c) A managed sandbox vendor service (not evaluated here; would need its own provider/ROPA/DPA review). (d) Do not execute code at all (the agent stays read/edit-only; builds happen in CI the customer controls). |
| **Evidence needed to decide** | [RUNTIME-EVALUATION](../../security/sandbox/RUNTIME-EVALUATION.md) and [RUNTIME-QUALIFICATION](../RUNTIME-QUALIFICATION.md) (technology comparison, node requirements, test plan); a provider answer on dedicated Linux VMs/bare metal and nested virtualization (HG-05-04); then, after provisioning, the T1–T12 results. All of this document set is `NOT VERIFIED` vendor/technology knowledge until a node exists. |
| **Cost** | Not stated. `Nodes ≈ ceil(max(N_peak·c/(C_node·u), N_peak·m/(M_node·u))) + spares`; compute `≈ Nodes · P_node · hours`; plus egress proxy/mirror, image/log storage, and operating effort (highest for microVMs). The owner supplies `N_peak`, `P_node`, margin, currency. **Qualification itself:** one dedicated node for a few days, a registry mirror, and reviewer time. The platform already refuses to admit work while the budget is 0 (`QuotaLedger`). |
| **Security impact** | The decisive control for hostile multi-tenant code. gVisor: smaller host-kernel exposure than a container, shared host kernel remains behind the user-space kernel. microVM: hardware boundary, VMM/KVM/CPU side channels remain. Both need the dedicated-node, no-secrets, egress-proxy and recycling controls. |
| **Legal impact** | Indirect: the chosen provider/region determines residency of the sandbox and logs (ROPA entry, `ResidencyPolicyService`); the provider agreement is its own approval (like D2 for models). |
| **Blocks development?** | **No.** The control plane talks to `ExecutionRuntime`/`WorkspaceRuntime` only; the choice changes the node agent. |
| **Blocks activation?** | **Yes**: no node, no attestation, no real run. |

## 2. HG-10-02 — sandbox isolation security review (a named human, a report)
| Field | |
|---|---|
| **Question** | Who is the named reviewer, with what independence, what pass bar, what cadence? |
| **Recommendation** | A named security reviewer **independent of the implementer**, using the plan in RUNTIME-QUALIFICATION §5 (T1–T12) and [VERIFICATION-PLAN](../../security/sandbox/VERIFICATION-PLAN.md). Pass bar: zero ESCAPED on the 65 isolating attempts and the 212 control-plane attempts, two runs on a rebuilt node, canary never read, T6–T10 recorded. The reviewer **signs the attestation with their own key** (the platform only verifies it); attestations expire (≤ 30 days proposed) and renew only by a fresh qualification; any kernel/runtime/image/config change re-triggers it. |
| **Alternatives** | Two reviewers (second as tie-break); an external penetration test firm in addition (a certification/pen test is a human gate, CLAUDE.md §5); internal-only review (weaker). |
| **Evidence** | The evidence set in RUNTIME-QUALIFICATION §6: inventory, runner report + sha256, conformance report, logs, timings, the signed attestation, the review report, the D-21 reference. |
| **Cost** | Reviewer time per qualification and per renewal; optionally an external firm (owner-priced). |
| **Security impact** | This is the only thing that turns a technology into an accepted boundary. A signed attestation is evidence of a review, not isolation: key custody and independence are the controls. |
| **Legal impact** | The report is part of the due-diligence record for LEGAL-EXEC and any customer security questionnaire. |
| **Blocks development?** | No (runner, draft attestation and verifier are ready). |
| **Blocks activation?** | **Yes**: no LIVE-VERIFIED attestation means the service refuses to start and `runtimeVerified`/`escapeSuitePassed` stay false. |

## 3. The Execution Gateway ADR (numbered ADR-067 on this line) — acceptance
| Field | |
|---|---|
| **Question** | Accept the design (closed profile catalogue, fixed argv/env, approvals, quota, queue, audit, kill switch, fail-closed attested runtime) as binding? |
| **Recommendation** | **Accept after the offline hardening addendum**, as amended by Phase 2 (attestation-gated real-runtime port; qualification runner; conformance suite). Also decide the **number**: the hosting line already claims ADR-067 (HestiaCP); the Master's plan renumbers ours to ADR-068 when the lines join. Session 04 changed no existing ADR reference and added none to new code. |
| **Alternatives** | Amend first (e.g. require a microVM class, or forbid `registry-only` network entirely in the first rollout); reject (execution stays out of scope). |
| **Evidence** | The ADR and addendum; the passing offline suites (`execution-gateway/**` 309 domain tests, sandbox 104 API tests at this checkpoint); the escape-suite 1.1.0 simulated report; the Master's independent QA findings (DEFECT-1/2/3/5 fixed). |
| **Cost** | None. |
| **Security impact** | Makes the controls binding on future work (a regression to a free-form command, an inherited-profile lookup or a missing attestation becomes a violation of an accepted ADR). |
| **Legal impact** | None directly. |
| **Blocks development?** | No (status PROPOSED is respected; work continues against it). |
| **Blocks activation?** | **Yes**: `adrAccepted` is a gate input. |

## 4. LEGAL-EXEC — terms and liability for executing customer-supplied or model-generated code
| Field | |
|---|---|
| **Question** | Under what terms may Nuzm run a customer's code (and code generated for them) on its infrastructure, and who bears what liability? |
| **Recommendation** | Legal review **before any customer-visible use**, even in staging with real customers. Topics for counsel: acceptable-use and prohibited workloads (crypto-mining, scanning, attack tooling, resource abuse) and the platform's right to suspend; responsibility for the content of generated code and its outputs; no warranty of isolation beyond the documented controls; incident and breach notification if a sandbox is compromised; data protection roles for files and outputs processed in the sandbox (processor), residency and retention (D-34); export-control/sanctions screening if the program requires it; customer consent text for the approval dialog (network warning, install warning) in Arabic and English. Until sign-off: **disallow customer-facing execution** (the default). |
| **Alternatives** | Disallow permanently (agent never executes; the customer runs builds themselves); allow only for the customer's own organization in a private beta under a signed addendum. |
| **Evidence** | Counsel sign-off reference; the final Terms/AUP text; DPA/ROPA update for the sandbox processing; the approval-dialog copy reviewed. |
| **Cost** | Legal review effort (owner). |
| **Security impact** | Defines the abuse response (suspension, evidence retention) that the technical kill switch and audit support. |
| **Legal impact** | The decision itself. No claim of compliance (ZATCA, PDPL, certifications) is made by this work. |
| **Blocks development?** | No. |
| **Blocks activation?** | **Yes for customers** (production and any customer-visible staging). It does **not** block an internal staging qualification with synthetic fixtures only. |

## 5. "D-42" — production rollout of execution (naming conflict)
| Field | |
|---|---|
| **Conflict** | `docs/07-open-decisions-and-blockers.md` defines **D-42** as the platform object store (decided interim 2026-11-20: dev filesystem adapter now). `docs/parallel/OWNER-DECISIONS.md` and the gate code (`ExecGateState.d42Decided`, comment "production rollout") use "D-42" for the production go decision. Per CLAUDE.md §2 the higher source (docs/07) wins and the conflict is recorded; nothing was renamed. **Needed:** a distinct id for the production-rollout decision (suggested `D-PROD-EXEC`), applied by the Master. |
| **Question** | When, for whom and with what limits does execution go to production? |
| **Recommendation** | Not before: D-21 decided and a node LIVE-VERIFIED; HG-10-02 report; ADR accepted; LEGAL-EXEC; a **staging soak** (internal org only, `typecheck`/`unit-tests`, network `none`) with no incident for an owner-set period; durable stores built; alerts and the runbook exercised on a real runner. Rollout order: one allow-listed org → `build` → approval-gated network profiles; per-org concurrency and budget ceilings from day one; the kill switch and flag rehearsed. |
| **Alternatives** | Staging-only indefinitely; customer-run builds only. |
| **Evidence** | Soak report, runbook exercise record, on-call readiness, rollback rehearsal. |
| **Cost** | Node pool at `N_peak` plus spares, per-run cost recovery through the rate card (`ai.sandbox_cpu_seconds`, owner-set rate), operations. |
| **Security impact** | Production exposes the boundary to real adversaries; the recycling, alerting and incident procedures must be proven first. |
| **Legal impact** | Same as LEGAL-EXEC plus customer notices. |
| **Blocks development?** | No. |
| **Blocks activation?** | **Yes**: `production && !d42Decided` keeps the gate closed in production. |

---

## Order and parallelism
1. Independent, can be decided now in any order: **ADR acceptance**, the **D-42 id fix**, **LEGAL-EXEC review kick-off**, **D-21 + provider/budget**.
2. After D-21 and the provider: the node is provisioned (owner/ops), the node agent and node client are built (Session 04 follow-up), then the qualification run (needs an owner approval reference for staging).
3. After the run: **HG-10-02** review and attestation; then the gate inputs can be set; then staging execution for the internal org.
4. Last: LEGAL-EXEC sign-off and the production-rollout decision before any customer.

## What the owner is *not* asked to do
Run anything on a laptop, install tooling for this purpose, hand over a credential to the agents, or approve a spend by implication: every live step needs its own approval reference, which the qualification runner checks and records.
