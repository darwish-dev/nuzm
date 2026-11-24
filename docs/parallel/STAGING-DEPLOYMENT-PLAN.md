# Staging deployment plan (Phase 2, Session 06)

Author: Session 06 (Preview, Hosting and Deployment) · Date: 2026-11-24 · Branch `feature/ai-deployment` · Status: **designed, built and tested SIMULATED. Nothing is verified on a real node. HG-05 and HG-06 are open.**

Evidence vocabulary (CLAUDE.md §6): `SIMULATED` = ran against an in-memory stand-in; `NOT VERIFIED` = implemented, never run against the real thing; `LIVE-VERIFIED` = a recorded live check with an evidence reference. This document never uses "verified" for anything in the first two classes.

## 1. What exists today

| Capability | Where | Evidence |
|---|---|---|
| Website publish pipeline: two-step human approval → `platform.operations` job → build → stage → smoke (staged) → switch → smoke (live) → automatic restore | `deploy/internal/deploy.service.ts` | SIMULATED (22 integration tests + the E2E `10-deploy-simulated.spec.ts`, ar and en) |
| Web-app publish (static export, sandbox build, supply-chain gate, health gate, rollback) | `appbuilder/internal/deploy` (Session 05), dispatched by `DeployService` | SIMULATED |
| Cancel (queued and running), orphan recovery, DEFECT-4 (an API key cannot confirm a publish) | `deploy.service.ts` | SIMULATED |
| **New:** project type → target mapping (14 product types, 3 builder types), staging target model with approval and evidence gates | `deploy/internal/targets.ts` | unit-tested (22) |
| **New:** release-layout hosting target composed from two narrow ports (`HostingSiteOps`, `ArtifactTransport`) | `deploy/internal/hosting-target.ts` | SIMULATED (9 unit + 5 integration tests) |
| **New:** temporary preview subdomains with ADR-060 isolation checks | `deploy/internal/preview-url.ts` | unit-tested |
| **New:** SSL configuration planner (temporary wildcard, custom domain, issue/renew/retry) | `deploy/internal/ssl-flow.ts` | unit-tested |
| **New:** environment variables as vault references only, log redaction | `deploy/internal/env-refs.ts` | unit-tested |
| **New:** policy switches O-1 and O-2 (per-organization, audited, defaults = today) | `deploy/internal/policy.service.ts`, migration `2180` | SIMULATED (14 integration tests) |
| **New:** synthetic-app staging rehearsal (script + test) | `deploy/internal/rehearsal.ts`, `rehearsal.cli.ts` | SIMULATED (7 unit tests); `real` mode ends BLOCKED |

## 2. Target options

| Option | What it is | Fits | Does not fit | State |
|---|---|---|---|---|
| **A. In-memory node** | the local reference publisher (`AI_LOCAL_REFERENCE=true`, URLs end in `.invalid`) | tests, demos, the rehearsal | anything real | exists |
| **B. Shared hosting node running HestiaCP** | one Hestia account per site (`s-<hex>` of the hosting contract), static or PHP document root, Let's Encrypt through the panel, REST API with an allow-listed command profile (ADR-067 on the hosting line, **Proposed**, NOT VERIFIED live) | static websites, landing pages, documentation, the static export of a web app, PHP sites | server code written by the AI, databases, queues, anything that needs its own process or its own isolation | adapter on the hosting line, not on this branch; **the file upload path does not exist yet** |
| **C. Isolated runtime** | a sandboxed execution environment with an isolation attestation (Session 04, Execution Gateway, ADR-067 on this branch) | arbitrary generated server applications | shared-hosting economics | Session 04 is preparing it; refuses to start without an attestation |
| **D. Managed database** | M08 data module | schema migrations | web publishing | M08 |
| **E. Store distribution** | signed device packages and store submissions | mobile apps | automation (owner action only, CLAUDE.md §5) | never automated |

**Recommendation:** stage on **B** with one throw-away node and a synthetic static app first. It is the smallest real thing that exercises the real risks (file transfer, atomic switch, TLS, DNS, isolation between sites). **C** is a separate, later staging effort owned by Session 04's qualification; deployments of server apps must not be routed to B under any circumstance.

### Per product type (the 14 types of the builder planner)

| Type | Target | Deployable now | Blockers |
|---|---|---|---|
| website | B static | SIMULATED only | HG-05, HG-06 |
| landing | B static | SIMULATED only | HG-05, HG-06 |
| docs | B static | SIMULATED only | HG-05, HG-06 |
| webapp (static export) | B static | SIMULATED only | HG-05, HG-06 |
| flutter | B static (web export only) | **not yet** | no build recipe for the web export; device packages are store distribution |
| ecommerce | C isolated runtime + managed database | **not yet** | Session 04 runtime, M08, HG-05/06 |
| saas | C + database | **not yet** | same |
| erp | C + database | **not yet** | same |
| crm | C + database | **not yet** | same |
| fullstack | C + database (only its static front end could use B) | **not yet** | same, plus a server build recipe |
| api | C | **not yet** | Session 04 runtime, a start command and health path |
| auth | C + database | **not yet** | secrets and a database: never shared hosting |
| database | D managed database | **not yet** | M08 |
| mobile | E store distribution | **not yet** | owner action (HG-10-01) |

`TARGET_BY_PRODUCT_TYPE` is a `Record` over the closed union and a unit test compares it with the planner's `PRODUCT_TYPES`, so a fifteenth type cannot be added without a decision here.

## 3. The deployment target port

```
DeployService ──► SitePublisherPort  (stage · smoke · activate · discard · restore · activeHash · simulated)
                        │
        ┌───────────────┼──────────────────────────────┐
 InMemorySitePublisher  HostingTargetPublisher         UnavailableSitePublisher (production today: 422)
   (A, SIMULATED)         │  composed from
                          ├── HostingSiteOps      ← a subset of the hosting provider abstraction
                          │                         (`HostingAdapter`: siteState = findByToken,
                          │                          issueManagedCertificate = issueCertificate)
                          └── ArtifactTransport   ← the one thing HostingAdapter lacks: putting files on the node
                                                    (SFTP into the site root: planned, not built)
```

Why this shape: `HostingAdapter` (docs/09 §3) manages sites, domains, certificates and backups; it has **no** way to place files. The Hestia line's report (HESTIA-S1 §G) lists the SFTP file manager as a later session. So the target port needs exactly two things from hosting: "does this site exist and is it serving" and "issue a managed certificate", both of which `HostingAdapter` already offers (`findByToken`, `issueCertificate`). A HestiaCP-backed adapter satisfies `HostingSiteOps` through a thin mapping written **in the hosting module** when HG-05 is granted. This module imports nothing from hosting and copies none of its code (the Hestia line was read with `git show` only).

**Release layout on the node** (same for any transport): `<siteRoot>/releases/<deploymentId>/…` for each deployment, `<siteRoot>/current` switched atomically. Steps: upload to a **new** release directory → read the hash back from the node and compare (a mismatch removes the upload and fails the deployment) → smoke the staged URL → switch `current` → smoke live. Rollback switches `current` back to a retained release (no re-upload); if the release was pruned it is uploaded again, verified and switched. The newest `keepReleases` (default 5) are kept; the live release is never pruned.

**Open question for the live probe (NOT VERIFIED):** HestiaCP serves a domain from `…/web/<domain>/public_html`. Making `public_html` a symlink to `current` is the plan, but whether Hestia's web templates, permission fixes or rebuild commands preserve a symlinked document root is not established. If they do not, the fallback is `rsync --delete` into `public_html` from the release directory (atomic enough for static files, loses the cheap rollback). The probe in §5 step 6 decides.

### Hestia plug-in mapping (design, not code)

| Port operation | Hosting abstraction | Hestia (from the hosting line, NOT VERIFIED) |
|---|---|---|
| `siteState` | `findByToken(siteName)` | `v-list-user` of the account `s-<hex>` |
| `issueManagedCertificate` | `issueCertificate(mode: 'managed')` | Let's Encrypt through the panel; expiry read from `v-list-web-domain-ssl`, key discarded by the adapter |
| `putRelease`, `switchCurrent`, `probe`, `removeRelease` | **none** | not in the REST API: SFTP into the account home (planned on the hosting line); `probe` is plain HTTPS from the platform |
| node capability check | `probe()` → `hosting.runtime.static` | reported by the probe, never assumed |

## 4. Preview URLs, temporary subdomains, ADR-060

- A staging deployment is reachable at `https://<site>-<16 hex>.<PREVIEW_DOMAIN>/` (`temporarySubdomain`). The 16 hex characters (64 bits) are a hash of the deployment id, or an HMAC of it under a vault-held server key when one is supplied: stable for one deployment, different for each, not guessable by enumeration (QA concern O-16). A real run must supply the key.
- **ADR-060 is enforced in code** (`assertIsolatedPreviewDomain`): the preview domain must be a valid host name on a registrable domain **different** from every console, admin, API and marketing domain, and a parent or child relation counts as shared. The public-suffix check is an approximation (a short list of two-level suffixes); the owner confirms the final domain against the real public-suffix list.
- No preview domain configured (the simulated target) → the host ends in `.staging.nuzm.invalid`, which can never resolve. A simulated URL cannot be mistaken for a live one.
- Host matching is exact (`isTemporaryPreviewHost`): no suffix tricks, no extra labels.
- What the owner must supply: a domain for previews (not under the console or API domain), wildcard DNS `*.<domain>` pointing at the node, and a wildcard certificate (DNS-01 needs API access to that domain's DNS). The preview-serving host must run with no access to the vault, the API tokens or the internal network (ADR-060 §8: infrastructure, NOT VERIFIED here).

## 5. SSL configuration flow

`planSsl` is a pure planner (it performs nothing). Cases:

| Host | Plan |
|---|---|
| temporary subdomain | covered by the wildcard at the edge: state `not_required`. A real run is blocked until HG-06 (node/panel access) is recorded |
| custom domain, DNS not proven | `show_dns_records`, then `verify_dns` |
| DNS proven, no certificate | `issue_managed` (the node's ACME client) |
| issuing | `wait` |
| failed | `retry_issue` with back-off 60 s, 5 min, 30 min, 2 h |
| active, within 30 days of expiry | `renew_managed` |
| expired | `failed` + `renew_managed` |
| customer-supplied certificate | refused: `unsupported_custom_certificate` (the hosting adapter reports it unsupported until built and tested) |

`canSwitchLive` refuses to switch a custom domain live without an active or expiring certificate. Every plan carries the label `SIMULATED` or `NOT VERIFIED`.

## 6. Environment variables

Names and `vault://` references only (`validateEnvBindings`). A pasted secret is refused and **never echoed** (problems carry the variable name only). Reserved names (`PATH`, `NODE_OPTIONS`, `NUZM_*`, `DATABASE_*`, `AWS_*` …) cannot be bound. A static site has no runtime, so only explicit `PUBLIC_*` build-time variables are accepted for it. Build and node output pass through `redactLogLine` before being stored. **Not wired into the request or the approval hash yet**: a store with no consumer would be dead code (gap G4). It becomes real when a runtime target (C) or a node environment channel exists; the validator and the redactor are ready and tested.

## 7. Health, logs, cancellation, recovery

| Concern | Behaviour | Evidence |
|---|---|---|
| Health | smoke on the staged release (HTTP 200 on every page; TLS when https) and again on live | SIMULATED |
| Logs | append-only `deploy.deployment_logs`; build and node output redacted; the console shows a SIMULATED banner | SIMULATED |
| Cancellation | queued: at once; running: at the next checkpoint (before build, before stage, before switch); the staged upload is discarded and the live site is never touched | SIMULATED |
| Failed staged smoke | **new in this batch:** the staged upload is now discarded (the integration test found it lingered on the node); previous release keeps serving; state `rolled_back` | SIMULATED |
| Failed live smoke | previous artifact restored automatically | SIMULATED |
| Uncertain result after a timeout | reconcile before retry: a retried segment first asks what is live (`activeHash`) | SIMULATED |
| Orphaned operation | recovered by `tick()` | SIMULATED |

## 8. Tenant isolation

- Control plane: every deploy table has `org_id` and RLS; cross-organization reads and writes answer 404; tested.
- Target: a site on a node shares nothing with another site in the release layout (tested in memory). **Isolation between two customers' sites on one shared HestiaCP node is NOT VERIFIED**: it depends on per-account Unix users, PHP-FPM pools and file permissions on the real node, and the hosting line lists "isolation tests on a real node" as not built. Shared hosting is therefore acceptable for staging with synthetic content only.

## 9. Approvals and policy

Unchanged defaults: a signed-in person with `deploy:write` (owner, admin, developer) confirms a production publish; an API key can ask for an approval but never decide it (DEFECT-4); a rollback reuses the earlier release's approval.

Switches (owner/admin only, signed-in person, permission `org:security`, audited `deploy.policy.updated` with before and after, optimistic `expectedVersion`):

| Setting | Default (= today) | Stricter value |
|---|---|---|
| `deploy.production_publish_roles` | `[owner, admin, developer]` | e.g. `[owner, admin]`: a developer can request, an owner/admin confirms; owner can never be removed |
| `deploy.rollback_requires_own_approval` | `false` | `true`: a **production** rollback asks for its own approval (bound to that rollback, single use, confirmed by one of the publish roles) |

Routes: `GET /v1/deployments/policy` (deploy:read), `PUT /v1/deployments/policy`. These need the OpenAPI patch in `CONTRACT-5-deploy-policy-and-targets.md` (spec drift reports them until the Master applies it). Scope: the website path; web apps keep their own policy in the app builder. See `PHASE2-06-approval-inputs.md` for the decisions.

## 10. What the owner must provide (checklist)

1. **HG-05** — a cloud account and one **non-production** node (smallest size, Linux, in the approved region) with a hard spend cap and a teardown date. Which provider and region is the owner's decision (docs/07 HG-05-01..04, D-52 names Alibaba SCCC Riyadh and Contabo EU as candidates).
2. **HG-06** — HestiaCP installed on that node (ADR-067 on the hosting line accepted, or the owner states an alternative), the panel FQDN, an access key with the allow-listed command profile **typed once into the admin console** (never in chat, code or logs), the approved Hestia version.
3. A **preview domain** separate from the console and API domains, wildcard DNS to the node, and DNS API access for the wildcard certificate.
4. An **SFTP account policy** for the artifact upload path (this is code that must be written in the hosting module: Session 06 cannot write it without the hosting line decision, see §12).
5. The recorded approval reference (`HG-05:<date>`) to put on the target. Without it the target refuses.

## 11. Evidence needed to move from SIMULATED to LIVE-VERIFIED

Each row is a recorded event with the approval reference, date and the log excerpt (redacted).

| # | Check | Pass condition |
|---|---|---|
| 1 | Panel probe | the node reports `hosting.runtime.static`; version recorded |
| 2 | Create the staging site (an account `s-<hex>`) | found by `findByToken`; reconcile after a forced timeout finds it |
| 3 | Upload release 1 | hash read back from the node equals the artifact hash |
| 4 | Staged smoke | HTTP 200 on `/`, `/about/`, `/health/` over HTTPS from outside the node |
| 5 | Switch | `current` points at release 1 atomically; no request sees a half state (probe in a loop during the switch) |
| 6 | Document-root behaviour | symlinked `public_html` survives a Hestia rebuild; otherwise record the fallback |
| 7 | Temporary subdomain | wildcard certificate valid; the host resolves; cookies of the console are absent (different registrable domain) |
| 8 | Failed release | a forced 503 on one page leaves release 1 serving and removes the staged upload |
| 9 | Cancel | cancelled between stage and switch: live untouched, upload removed |
| 10 | Rollback | switch back to release 1 without re-upload; smoke passes |
| 11 | Isolation | a second synthetic site on the node cannot read or write the first site's files |
| 12 | Teardown | the site, the account and the node are deleted; `verifyWipe` reports nothing left; the provider bill matches the cap |

## 12. Collision with the hosting line (record, nothing executed)

The hosting line (`claude/merge-branches-run-import-295c4d`, head `3460525c`) was read-only. Facts that matter to this work:

- Its commit changes one comment in `apps/api/src/modules/deploy/internal/ports.ts` (the `SitePublisherPort` doc: "until the hosting module gains an artifact upload path (SFTP into the site root…)"). That is the same file this branch edits. A merge will conflict on that comment only; the sentence is already consistent with this design.
- **ADR-067 number**: the hosting line uses `ADR-067-hestiacp-hosting-panel`; this branch uses `ADR-067-execution-gateway`. The Master's reconciliation plan renames ours to ADR-068.
- **Migration numbers**: the hosting line uses `hosting/1980` and `cloud/1985`; Phase 1 here used `deploy/1980`. Phase 2 uses 2180, which collides with neither.
- Its CloudPanel node agent is removed; nothing in this module referenced it.
- Decision needed from the owner before the real upload path can be built (see approval inputs): **which line owns the artifact upload path** (the hosting line's SFTP file manager, or a deploy-owned transport behind `ArtifactTransport`). This session recommends the hosting line owns it and deploy consumes it through `ArtifactTransport`.

## 13. Synthetic-app staging rehearsal

The app is deterministic static output (three pages, one asset, no secrets, no network). The procedure is the same in both modes.

```bash
# SIMULATED (works today, no services, no credentials)
npx tsx apps/api/src/modules/deploy/internal/rehearsal.cli.ts
# the same procedure as a test
cd apps/api && npx vitest run src/modules/deploy/internal/rehearsal.spec.ts
```

Steps recorded in the evidence JSON: `gate` (HG-05/HG-06 approval, preview domain, upload path) → `preview` (isolated origin) → `ssl` → `env` (references only) → `release1` (stage, integrity read-back, smoke, switch, smoke live) → `recovery` (failed smoke: staged upload discarded, release 1 serving) → `cancel` → `rollback` → `isolation`.

```bash
# REAL (refuses today: BLOCKED, exit 3, nothing deployed)
STAGING_MODE=real STAGING_TARGET_ID=hosting:staging-1 STAGING_APPROVAL_REF=HG-05:<date> \
STAGING_PREVIEW_DOMAIN=<preview domain> STAGING_PROTECTED_DOMAINS=<console>,<api> \
STAGING_REGION=<region> STAGING_EVIDENCE_OUT=docs/reports/staging-rehearsal.json \
npx tsx apps/api/src/modules/deploy/internal/rehearsal.cli.ts
```

Real mode never falls back to simulated and never reports a pass unless every step passed; with no upload transport it ends `BLOCKED: no artifact upload path to a hosting node exists yet`. Exit codes: 0 PASS, 1 FAIL, 3 BLOCKED. The full API and console path (approval, job, UI, audit) is covered by `e2e/tests/10-deploy-simulated.spec.ts` against the in-memory node; against a real node the same spec would run with `DEPLOY_PUBLISHER` pointing at the real target once it exists.

### 13a. Rehearsal evidence table (actual output of the simulated run, 2026-11-24)

`STAGING_EVIDENCE_MD=<path> npx tsx apps/api/src/modules/deploy/internal/rehearsal.cli.ts` writes this table. Every row is `SIMULATED`. It proves the procedure and the code paths, nothing about a real node.

| Step | What | Status | Evidence label |
|---|---|---|---|
| gate | target gate (HG-05/HG-06 approval, preview domain, upload path) | PASS | SIMULATED |
| preview | temporary subdomain on an isolated preview origin (ADR-060) | PASS | SIMULATED |
| ssl | SSL plan for the temporary host | PASS | SIMULATED |
| env | variables are vault references; a pasted secret is refused unechoed | PASS | SIMULATED |
| release1 | stage, integrity read-back, smoke, switch, smoke live | PASS | SIMULATED |
| recovery | failed smoke: staged release discarded, release 1 keeps serving | PASS | SIMULATED |
| cancel | cancellation after staging: upload discarded, live untouched | PASS | SIMULATED |
| rollback | release 2 live, then rollback to release 1 | PASS | SIMULATED |
| isolation | a second site on the node shares nothing with the first | PASS | SIMULATED |

Real-mode seal (defence in depth): the gate runs in the CLI **and** inside `HostingTargetPublisher` itself (`stage`, `activate`, `restore` and SSL issuance each re-check it). A real target without the approval reference, without a preview domain, or `LIVE-VERIFIED` without evidence cannot place, switch or restore anything even if constructed directly. `STAGING_MODE=real` today ends `BLOCKED` (exit 3) because no upload transport exists; it never falls back to simulated.

### 13b. "Prepare deployment": the step the agent loop and the console call (Session 05)

`DeployService.prepare(orgId, { projectId, environment?, target? })` is read-only: it creates no deployment and requests no approval. It returns `DeploymentPlanDto`: the product type, the target kind and readiness (`simulated` / `not_yet`) with blockers, whether a publisher is available and its label (`SIMULATED` or `NOT VERIFIED`), the organization's policy, who may confirm the publish approval in that environment (an API key never may), and `ready` with human-readable `reasons`. The agent loop's "prepare deployment / request approval" step should call `prepare`, show or record the plan, and then call the existing `POST /v1/deployments` flow (`create`) for the approval. It must not re-implement the target mapping, the policy check or the approval. No new route exists (a route would need a spec change); an HTTP route can be proposed through a CONTRACT if the console needs it.

### 13c. Matrix hooks for Session 07 (O-1/O-2)

The policy API is theirs to drive: `PUT /v1/deployments/policy` (owner/admin, person only) sets `productionPublishRoles` and `rollbackRequiresOwnApproval`; `GET` reads them. Cases already covered by my tests, so the matrix need not repeat them: defaults equal today; developer self-publish under both settings; rollback with and without its own approval; viewer, API key and other-organization refusals; audit before/after. Suggested additions for the matrix: billing admin (no `deploy:write`), a second developer confirming the first developer's request, expiry of a rollback approval, concurrent confirmation of one approval, and the web-app path (own policy, not covered by these switches).

## 14. Rollback and teardown of the staging deployment itself

- Release rollback: see §7 and evidence row 10.
- Kill switch: unset the target's `approvalRef` (the target then refuses), or the feature flags `hosting.enabled` / `ai.enabled`. No production data is ever on the staging node.
- Teardown: delete the site through the hosting adapter, run `verifyWipe`, delete the node at the provider, confirm the bill. Nothing here deletes production data.

## 15. Cost (structure only; no price is asserted)

| Item | Who pays | Owner action |
|---|---|---|
| One small Linux node for the staging window | owner, at the provider | read the price from the provider's own page; set a hard cap and an end date; delete after the test |
| Preview domain (registration, if new) | owner | choose a domain; renewals if kept |
| Wildcard certificate | free with Let's Encrypt; DNS API access needed | provide DNS API credentials to the node, not to the platform code |
| Outbound traffic of the test | usually within the node's allowance | none |
| Engineering | already done offline | none |

Estimated test duration: the checklist in §11 is one working session once the node and panel exist. The amount is the owner's to fill from the provider's price list: `________` per month × `____` days, cap `________`.

## 16. Open questions

1. Which line owns the artifact upload path (§12)?
2. Does a symlinked document root survive Hestia (§3)?
3. Public-suffix list check for the preview domain (§4).
4. A `developer` confirming a production publish (O-1) and a rollback needing its own approval (O-2) are owner decisions; the defaults are unchanged.
5. Web-app (Session 05) deployments: the release build needs AI credit on the wallet because the sandbox create checks the AI budget; Session 05 is already investigating it in Phase 2.
