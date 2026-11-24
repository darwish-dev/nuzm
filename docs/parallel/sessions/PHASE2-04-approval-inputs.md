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
| **Recommendation** | **Accept after the offline hardening addendum**, as amended by Phase 2 (attestation-gated real-runtime port; qualification runner; conformance suite). Also decide the **number**: the hosting line already claims ADR-067 (HestiaCP); the Master's plan renumbers ours to ADR-069 when the lines join. Session 04 changed no existing ADR reference and added none to new code. |
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

## 5. D-AG-ROLLOUT — production rollout of execution (id conflict RESOLVED)
| Field | |
|---|---|
| **History** | This decision was first written "D-42" in the parallel plan and in the gate code, but `docs/07-open-decisions-and-blockers.md` defines D-42 as the platform object store (decided interim 2026-11-20). The Master resolved it on 2026-11-24: production rollout is **D-AG-ROLLOUT**. Session 04 renamed `ExecGateState.d42Decided` to `rolloutDecided` (fail-closed unchanged: `production && !rolloutDecided` keeps the gate closed; the refusal text names D-AG-ROLLOUT) and updated its documents. |
| **Question** | When, for whom and with what limits does execution go to production? |
| **Recommendation** | Not before: D-21 decided and a node LIVE-VERIFIED; HG-10-02 report; ADR accepted; LEGAL-EXEC; a **staging soak** (internal org only, `typecheck`/`unit-tests`, network `none`) with no incident for an owner-set period; durable stores built; alerts and the runbook exercised on a real runner. Rollout order: one allow-listed org → `build` → approval-gated network profiles; per-org concurrency and budget ceilings from day one; the kill switch and flag rehearsed. |
| **Alternatives** | Staging-only indefinitely; customer-run builds only. |
| **Evidence** | Soak report, runbook exercise record, on-call readiness, rollback rehearsal. |
| **Cost** | Node pool at `N_peak` plus spares, per-run cost recovery through the rate card (`ai.sandbox_cpu_seconds`, owner-set rate), operations. |
| **Security impact** | Production exposes the boundary to real adversaries; the recycling, alerting and incident procedures must be proven first. |
| **Legal impact** | Same as LEGAL-EXEC plus customer notices. |
| **Blocks development?** | No. |
| **Blocks activation?** | **Yes**: the gate stays closed in production until it is decided. |

## 6. A staging node when the owner has no Linux infrastructure: exact needs, rough cost, recommendation
Prices and capabilities below come from public web pages read on 2026-11-24; they are **third-party or vendor statements, not live-verified, not quotes**, and the sources say which. Check the provider's live configurator before any commitment. No account was created and nothing was purchased.

### 6.1 Exact list: what the staging node needs
Everything in [RUNTIME-QUALIFICATION §3](../RUNTIME-QUALIFICATION.md) applies; this is the shopping list.
| # | Need | Detail |
|---|---|---|
| 1 | **One dedicated machine, preferably bare metal** | not a shared VM; no other workload; bare metal gives `/dev/kvm` so both gVisor and Firecracker can be qualified on it in turn. Minimum sizing for qualification (my engineering estimate, V): 4+ physical cores / 8+ threads, 32 GB RAM, 2 × 500 GB NVMe, enough for several 1 CPU / 1-2 GB runs at once plus the guest images |
| 2 | **Linux** | a current vendor-supported LTS distribution with unattended security updates, a pinned recent LTS kernel (V: 6.1+), cgroup v2, no swap, SSH by keys only from one operator IP, host firewall default-deny |
| 3 | **Runtime(s), pinned by digest** | gVisor: `runsc` + `containerd-shim-runsc-v1` (platform `systrap`: no KVM needed per the gVisor docs). Firecracker: `firecracker` + `jailer`, `/dev/kvm` readable/writable, a signed guest kernel and read-only rootfs built in CI |
| 4 | **Disk quota mechanism** | XFS project quotas or per-workspace sized volumes, `tmpfs` scratch with a size cap |
| 5 | **Network** | per-sandbox network namespace or tap, default-deny; the node's only outward paths are the egress proxy and the control-plane channel; metadata/RFC1918/link-local blocked; IPv6 off or equally filtered |
| 6 | **A second small host (or the same node in a separate namespace, reviewer's call) for the egress proxy and npm registry mirror** | the `registry-only` class allows only this mirror; not needed for the first `typecheck`/`unit-tests`/network `none` runs |
| 7 | **Node agent** (to be built after D-21) and a short-lived **mTLS** credential for the control plane to call it | the agent is the only management surface; it re-validates every spec |
| 8 | **Image supply chain** | private registry or digest-pinned artifacts, SBOM, vulnerability scan, signing |
| 9 | **Logging** | auditd or an eBPF sensor shipping to the platform log (content-free), time sync |
| 10 | **People** | an operator for provisioning and rebuilds; **a named reviewer independent of the implementer** (HG-10-02) with their own signing key; the owner's approval reference for each live run |
| 11 | **Rebuild path** | the ability to reinstall the node from the image between qualifications and after any incident (provider "rescue/reinstall" or an image pipeline) |
| 12 | **Evidence store** | where the inventory, reports and the signed attestation are kept (append-only) |
Not needed for the first staging qualification: customer data (fixtures are synthetic), production secrets, a database, a Kubernetes cluster, GPUs.

### 6.2 Rough cost range (indicative; owner supplies the final numbers)
| Option | What | Indicative figure | Source and caveat |
|---|---|---|---|
| **A. Bare-metal dedicated server, month to month** (qualifies gVisor, then Firecracker, on the same box) | e.g. Hetzner AX42-class (8-core, 64 GB DDR5, 2 × 512 GB NVMe, no minimum term, 30-day cancellation) | **about EUR 46 per month** at launch (Apr 2024) plus a EUR 39 setup fee; Hetzner's later price page lists AX42-1 variants at **EUR 77-97 per month** (setup EUR 39-49), so budget **EUR ~45-100 per month**, excluding VAT | [Hetzner AX42 announcement](https://www.hetzner.com/news/new-ax42), [Hetzner price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/); aggregators show EUR 45-46.5 (unofficial). Which row is the AX42 variant today is unclear from the page: confirm in the configurator. Servers are in the EU (not in-Kingdom) |
| **B. Hyperscaler bare metal, hourly** (Firecracker-capable, no commitment) | AWS `c5.metal` (96 vCPU, Linux) | **about USD 4.08 per hour** on demand in us-east-1, i.e. roughly **USD 100 per day**: a 3-5 day qualification is about **USD 300-500**; a month on demand is about USD 2,980; spot varies about USD 1.1-4.9 per hour and is unsuitable for a fixed plan | third-party price aggregators ([Holori](https://calculator.holori.com/aws/ec2/c5.metal/us-east-1), [Vantage](https://instances.vantage.sh/aws/ec2/c5.metal)), not AWS's own list: verify on the AWS pricing page. Oversized for this purpose; useful only if the owner already has AWS and wants hourly billing |
| **C. In-Kingdom options (for later production residency; staging with synthetic data does not need them)** | Oracle Cloud Jeddah and Riyadh regions; Microsoft Saudi Arabia East announced for November 2026; Zenlayer lists bare-metal capability in Riyadh | **not priced here** (no figure found that I can cite) | [Oracle Riyadh region](https://www.oracle.com/sa/cloud/cloud-regions/riyadh/), [Microsoft announcement](https://news.microsoft.com/source/emea/?p=267697), [Zenlayer Riyadh](https://cloud.zenlayer.com/datacenters/riyadh) (vendor pages; availability of bare metal or nested virtualization there is unverified). Ask each for bare-metal or KVM-capable shapes and a price |
| Egress proxy / registry mirror host | one small VM | not priced (a few EUR/USD per month on any provider; not sourced) | |
| Reviewer and operator time | | owner's own cost | usually the largest line |
**Summary range for the staging qualification: roughly EUR 50-150 for the first month on option A (server + setup fee + a small proxy host), or about USD 300-500 for a short hourly run on option B.** Production sizing is a different calculation (`N_peak`, spares, recycling) and is not estimated here.

### 6.3 Recommendation: gVisor on a dedicated node, or Firecracker?
Given that the owner has **no stated Linux infrastructure**:
1. **Rent one bare-metal dedicated server (option A) and qualify gVisor (`systrap`) on it first.** gVisor's `systrap` platform does not need hardware virtualization ([gVisor platform guide](https://gvisor.dev/docs/architecture_guide/platforms)), so the first result does not depend on any KVM or nested-virtualization question, and the server is cheap and month-to-month. This gets a real, reviewable security result fastest.
2. **Keep Firecracker as the production-target candidate and qualify it on the same bare-metal server afterwards** (after rebuilding the node; one runtime class per attestation). Firecracker needs `/dev/kvm` on a Linux host; on AWS only `.metal` instances provide it and nested virtualization is described as not well tested ([Firecracker getting-started](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)). A **virtual machine is therefore the wrong thing to rent** if Firecracker is ever wanted; bare metal avoids the question entirely.
3. **Decision rule for D-21 after both results:** choose Firecracker-class if the reviewer requires a hardware-virtualization boundary for hostile multi-tenant code and the in-Kingdom provider offers KVM-capable (bare-metal) shapes at an acceptable price; accept gVisor alone only if the reviewer records why its residual risk (a shared host kernel behind a user-space kernel) is acceptable for the planned profiles (`typecheck`, `unit-tests`, `build` first).
4. **Residency:** a staging node that processes only the synthetic fixtures has no personal data; confirm that reading with counsel. Production execution on customer files falls under D1 (in-Kingdom until a transfer assessment exists), which points to an in-Kingdom provider for production, not necessarily for staging.
5. **Do not** rent a shared VM, do not use a developer machine, and do not buy anything until D-21 and the budget are approved: this section is an input to that approval, not an instruction to purchase.

## Order and parallelism
1. Independent, can be decided now in any order: **ADR acceptance**, **LEGAL-EXEC review kick-off**, **D-21 + provider/budget**.
2. After D-21 and the provider: the node is provisioned (owner/ops), the node agent and node client are built (Session 04 follow-up), then the qualification run (needs an owner approval reference for staging).
3. After the run: **HG-10-02** review and attestation; then the gate inputs can be set; then staging execution for the internal org.
4. Last: LEGAL-EXEC sign-off and the production-rollout decision before any customer.

## What the owner is *not* asked to do
Run anything on a laptop, install tooling for this purpose, hand over a credential to the agents, or approve a spend by implication: every live step needs its own approval reference, which the qualification runner checks and records.
