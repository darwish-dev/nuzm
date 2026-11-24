# Phase 2, Session 06: inputs for owner decisions HG-05, HG-06, O-1, O-2

Author: Session 06 · 2026-11-24 · These are proposals. The agent recommends, the owner decides. Nothing here is accepted until it is recorded in `docs/parallel/OWNER-APPROVAL-PACK.md` (Master) with a date. Evidence labels: SIMULATED / NOT VERIFIED / LIVE-VERIFIED. Full context: `docs/parallel/STAGING-DEPLOYMENT-PLAN.md`.

---

## HG-05 — a non-production hosting node and the cloud account that provides it

| | |
|---|---|
| **Question** | May Session 06 (with the owner's help) run the staging deployment checklist against **one real, non-production, throw-away Linux node** at a provider the owner chooses, with a hard spend cap and a teardown date? |
| **Recommendation** | Yes, one smallest-size node for a bounded window (one working session plus a day of margin), provisioned **by the owner**, in the region the data-residency decision allows (D-52 names Alibaba SCCC Riyadh `me-central-1` and Contabo EU as candidates). Synthetic content only. The owner records an approval reference such as `HG-05:<date>` and gives it to the target; without it the target refuses to run. |
| **Alternatives** | (a) Stay SIMULATED: no cost, no real-world evidence, deployment stays `NOT VERIFIED` for ever. (b) A local virtual machine on the owner's own machine instead of a cloud node: free, proves transfer, switch and rollback, proves nothing about DNS, public TLS or provider isolation. A reasonable first rung before (the recommendation). (c) A longer-lived staging node: only after the first run is signed. |
| **Evidence** | The checklist of 12 recorded checks in the staging plan §11, each with date, approval reference and a redacted log excerpt; the provider invoice at the end. What exists today is SIMULATED only (22 + 14 + 5 integration tests, 7 + 22 + 9 unit tests, the browser E2E ar/en). |
| **Cost** | Not asserted: no price was researched or invented. Structure: one small node × the staging window, plus nothing else (no domain purchase is needed to start with a provider-assigned host name, see HG-06). The owner fills in `________ per month × ____ days`, cap `________`. The platform's own cost for the run is zero. |
| **Security and legal impact** | The node holds only synthetic files and a panel access key. The key is typed once into the admin console (write-only, sealed in the vault, never in chat, code, logs or screenshots). Provider terms and the account's billing contact are the owner's. Data residency: a node outside the approved region would violate the residency policy, so the region is part of the approval. No customer data is placed on the node. |
| **Blocks** | **Development: nothing.** All code is built and tested SIMULATED. **Activation: the whole real staging run** (rows 1-12 of the plan), and with it any claim that deployment works on a real node. Production publish is a further, separate decision (D-42). |

---

## HG-06 — panel access on that node (HestiaCP), and the artifact upload path

| | |
|---|---|
| **Question** | May the platform reach the node's hosting panel (HestiaCP, D-52, ADR-067 on the hosting line) with an allow-listed access key, and which code owns putting files on the node? |
| **Recommendation** | (1) Accept ADR-067 (hosting line) as the hosting-panel decision, so there is one documented panel. (2) Owner installs HestiaCP on the HG-05 node and records the panel FQDN, port and an access key limited to the allow-listed command profile. (3) **The hosting line owns the artifact upload path** (its planned SFTP file manager); the deploy module consumes it through the `ArtifactTransport` port that already exists and is tested SIMULATED. This avoids two copies of file-transfer code. (4) Preview domain: the owner supplies a domain **separate from the console and API domains** (ADR-060), wildcard DNS to the node, and DNS API access for a wildcard certificate. |
| **Alternatives** | (a) Deploy owns its own SFTP transport: faster to start, duplicates the hosting line's work and its credentials handling, and the two will diverge. (b) A node agent instead of the panel REST API: rejected on the hosting line (ADR-067 §Context; the bespoke agent was never built beyond a simulation). (c) Deploy static sites to an object-storage plus CDN target instead of a panel: possible, different cost and isolation story, not designed here. (d) Use the provider-assigned host name without a preview domain: enough for the first run, not for ADR-060 isolation evidence (row 7). |
| **Evidence** | ADR-067 (hosting line) cites Hestia's CLI reference and REST page, and says the **request format of the REST API is confirmed only by a live probe**. The hosting line's report HESTIA-S1 lists the adapter as NOT VERIFIED live, backups `unsupported`, SFTP and isolation tests on a real node **not built**. This session adds: the port design, the release layout, integrity read-back, rollback by switching, all SIMULATED. Open question for the probe: does a symlinked document root survive Hestia's rebuild commands (plan §3)? |
| **Cost** | Panel software is free to install; the cost is the node (HG-05), the preview domain (a registration if new, owner's choice), and engineering time for the SFTP path on the hosting line. A wildcard certificate from Let's Encrypt is free. |
| **Security and legal impact** | The access key can create and delete accounts on the node: allow-listed commands only, never UI scraping, never a shell string from a browser request, key sealed in the vault. HestiaCP is **shared hosting**: it is acceptable for static sites on a synthetic-only staging node. It is **not** an isolation boundary for arbitrary AI-generated server code (that is Session 04's isolated runtime) and isolation between two customers on one shared node is NOT VERIFIED. No customer site should be placed on a shared node before the isolation checks (plan §11 row 11) pass and a named reviewer signs. Hestia's licence and the provider's terms are the owner's to read. |
| **Blocks** | **Development: the real `ArtifactTransport`** (needs the owner's decision on which line owns it) and the Hestia `HostingSiteOps` mapping; everything else is done. **Activation: staging rows 1-12.** |

---

## O-1 — who may confirm a PRODUCTION publish (`deploy.production_publish_roles`)

| | |
|---|---|
| **Question** | Today any member with `deploy:write` (owner, admin, **developer**) can request **and** confirm a production publish of a website alone (the confirmation is a signed-in person, never an API key). The app builder's own policy (M10) lists owner/admin for `production_deploy`. Should the website path follow the stricter rule? |
| **Recommendation** | Make `[owner, admin]` the default **for new organizations only** after the owner decides; keep the current default for existing ones until they opt in. The switch exists now and defaults to today's behaviour, so the decision costs nothing to defer. A developer may still request the approval; an owner/admin confirms it, which also gives a second pair of eyes. |
| **Alternatives** | (a) Keep as is (documented): fastest for small teams, one person can publish alone. (b) Owner-only. (c) Require that the confirmer differ from the requester regardless of role ("second person"): needs a requester field on the approval, not built. (d) Per-site rather than per-organization setting. |
| **Evidence** | Implemented as `deploy.org_policies.production_publish_roles` (migration `2180`, CHECK: 1-3 distinct roles from owner/admin/developer), `GET/PUT /v1/deployments/policy`. 14 integration tests: defaults equal today (developer self-publish and rollback unchanged); only owner/admin may change it; strict validation; owner can never be removed; audit `deploy.policy.updated` with before and after; with `[owner, admin]` a developer's confirmation is refused 403 naming the policy and the allowed roles, the approval stays `pending`, an admin can confirm the developer's request, staging is unaffected; with `[owner]` an admin is refused; another organization is unaffected. SIMULATED (in-memory publisher). |
| **Cost** | None. |
| **Security and legal impact** | Closes self-approval of production publish for organizations that choose it (privilege and separation-of-duties finding O-1 from QA, MEDIUM-LOW). No new data. The setting itself is a security control: only an owner/admin signed in as a person can change it, an API key cannot, and every change is audited. |
| **Blocks** | **Development: nothing.** **Activation: nothing** (the default is unchanged). The *proposed* default becoming the default for everyone is the owner decision, plus the OpenAPI/SDK patch (CONTRACT-5) that the Master applies. |

---

## O-2 — does a rollback need its OWN approval (`deploy.rollback_requires_own_approval`)

| | |
|---|---|
| **Question** | Today a rollback creates a new deployment that **reuses the approval of the release being restored**; nobody confirms the rollback itself. The app builder's policy has `production_rollback`. Should a production rollback of a website need its own human approval? |
| **Recommendation** | Default `false` now (unchanged). Recommend the owner turn it on for production in organizations with more than one deployer, but **keep rollback fast in an emergency**: the approval is confirmed by an owner/admin in the console in one click, so the cost is a short delay, not a blocker. If the owner prefers speed, leave it off: a rollback only ever serves an artifact that was already approved. |
| **Alternatives** | (a) Keep reuse (today): fastest incident response; the restored artifact was approved once. (b) Own approval always, including staging: more friction, little extra safety (the switch is for production only, like M10's `production_rollback`). (c) Own approval only when the artifact being restored is older than N days (not built). |
| **Evidence** | Implemented as `deploy.org_policies.rollback_requires_own_approval`. Integration tests: default → a developer rolls back with no new approval and the new deployment carries the earlier release's `approval_id`; switch on → `403 approval_required` naming the policy, nothing rolls back by the request, the approval is bound to that exact rollback (deployment, target release, environment), single use (a spent id is refused), an API key and a viewer cannot confirm, the rollback row carries its **own** approval id; combined with O-1 `[owner, admin]` a developer's confirmation is refused; a staging rollback is unaffected. SIMULATED. |
| **Cost** | None. |
| **Security and legal impact** | Removes "rollback without fresh consent" for organizations that opt in. Risk of the stricter setting: a slower emergency rollback if no owner/admin is reachable; mitigated by leaving the setting off or keeping two owners/admins. |
| **Blocks** | **Development: nothing. Activation: nothing** (default unchanged). |

---

## Summary for the approval pack

| Decision | Default today | Proposed | Needs the owner | Code status |
|---|---|---|---|---|
| HG-05 | none (SIMULATED only) | one throw-away node, capped, teardown date | account, node, region, cap, approval reference | gates built; refuses without the reference |
| HG-06 | none | accept ADR-067, panel key typed once, hosting line owns the upload path, separate preview domain | panel, key, domain/DNS, line decision | port and mapping built; real transport not built |
| O-1 | `owner, admin, developer` | `owner, admin` for new organizations | yes | switch built and tested |
| O-2 | rollback reuses approval | own approval for production | yes | switch built and tested |

What is not decided by any of these: production publish for customers (D-42), isolation of two customers' sites on one shared node (a named reviewer), and server applications (Session 04's runtime).
