# HOST-TRANSPORT: decision memo for the owner

Author: Session 06 · 2026-11-24 · A recommendation, not a decision. Full specification: `HOST-TRANSPORT-SPEC.md`. Context: `STAGING-DEPLOYMENT-PLAN.md`, `PHASE2-06-approval-inputs.md` (HG-05, HG-06).
Evidence labels: SIMULATED / READ (source or report read, not run) / NOT VERIFIED / LIVE-VERIFIED. **Effort is stated as UNKNOWN throughout: no estimate was sourced, and none is invented.**

## The question

The deploy module can publish a static site to a hosting node only through an `ArtifactTransport`. It is built and tested SIMULATED (19 shared conformance cases, 6 broken-transport proofs). **No real transport exists**, and today's hosting line has no way to put a tree of files on a node, so staging deployment on a real node (HG-05, HG-06) cannot run, whatever the owner supplies. Who builds the real one, or should the target be something else?

## What is true today (all READ, none run)

- HestiaCP's REST API has no file upload. The hosting line's SFTP file manager handles one file per call, rooted at `public_html`, refuses symlinks and renaming the root, and is unavailable in production until the vault decision D-12.
- The hosting master recorded the upload path (tree write, per-deployment size limit, directory swap) as **not scheduled** and an owner roadmap decision.
- A symlink switch is impossible there; the spec offers two switch strategies (a Hestia panel command that changes the domain's document root, or a two-rename swap). Both are NOT VERIFIED; the panel command exists in Hestia's source and is not in the hosting line's allow-list today.
- HestiaCP is shared hosting: static (and PHP) only, never arbitrary AI-generated server code, and isolation between customers is NOT VERIFIED.

## Options

| | A. The hosting line builds it | B. The deploy module builds a transport on the hosting file-manager service once that exposes a tree API | C. A different target for static sites: object storage + CDN | D. Stay SIMULATED |
|---|---|---|---|---|
| What | A tree-write + switch + release-listing service inside the hosting module, implementing `ArtifactTransportPort` from `@nuzm/domain`, passing the 19 conformance cases | The hosting module exposes a public, org-scoped file-manager tree API; deploy writes the transport against it | A second target kind behind the same port: upload to a bucket prefix per release, switch an alias/pointer, serve through a CDN | No real publish; every deployment keeps its SIMULATED label |
| Effort | UNKNOWN (not estimated) | UNKNOWN; two lines coordinate on an API that does not exist yet | UNKNOWN; also needs a provider decision and an adapter (docs/09) that does not exist | none |
| Fit with what exists | Best: the file manager's guard, vault access, SFTP session, audit and quota are all internal to hosting (the file-manager session's own recommendation) | Workable, but the public API surface and its contract have to be designed first, and the transport then lives in deploy, away from the guard | New abstraction, new provider, new cost; the preview-domain and SSL flow (ADR-060, `ssl-flow.ts`) would have to be re-derived for it | n/a |
| Switch quality | S1 (panel command) is graceful if it reloads gracefully; else S2 (non-atomic window): NOT VERIFIED | same as A | Object-store alias switches are usually atomic: NOT VERIFIED for any named provider, and no provider was researched | n/a |
| Cost to the owner | node (HG-05) already needed; no new vendor; engineering time on the hosting line: UNKNOWN | same | a new vendor account and bill (not researched, no price asserted); a CDN | none |
| Risk | one more allow-listed panel command (S1) changes the hosting line's security posture; isolation on a shared node NOT VERIFIED | two teams, one contract; duplication risk if both grow transfer code | provider lock-in; Saudi data-residency (D-52 names Alibaba Riyadh and Contabo EU for nodes, not storage) must be re-checked for the bucket | deployment stays NOT VERIFIED for ever; staging claims remain unevidenced |
| Blocks | HG-05, HG-06, D-12 for production; owner scheduling the work | same, plus the API design | provider choice, HG for the account | nothing, and nothing is learned |

## Recommendation

**A.** The hosting line already holds every piece the transport needs and the file-manager session recommended it live there; the port, the shared rules and the conformance suite are in `@nuzm/domain` precisely so that line can pick it up without touching deploy. Ask the hosting owner to schedule it (decision HOST-TRANSPORT), starting with the **live probe checklist** (spec §4.5: nine questions, one node, one session) because its answers choose between the two switch strategies and may change the effort. Keep **B** as the fallback if the hosting owner prefers to expose a file-manager tree API; the conformance suite is identical. Treat **C** as a later option for scale (static sites on a CDN), not a way around the missing upload path, and research it only if A is refused. **D** is the default until a decision is recorded.

## What the owner decides

1. Which line builds the transport (A / B / C / D), and when it is scheduled.
2. Whether the hosting line may add `v-change-web-domain-docroot` to its allow-listed command profile (a security-posture change; only needed for strategy S1).
3. The final bounds (files, MiB per deployment, MiB per file, retained releases), which follow the plans' quotas.
4. Metering: event names and rates for bytes written and releases kept (docs/12).

## What does not change whichever option is chosen

The deploy side (target gate, release lifecycle, approvals, O-1/O-2 switches, O-9 content guard, tracks F and G, the evidence record), the HG-05/HG-06 gates, the rule that a result over a stand-in is SIMULATED, and the rule that HestiaCP is not an isolation boundary for server code.
