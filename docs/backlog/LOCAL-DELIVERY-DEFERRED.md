# Backlog: deferred after the local delivery of 2026-11-25

Owner decision of 2026-11-25: these do not block the local delivery. **Nothing listed here was deleted.** Sources are local branches (never pushed). Details of the branch comparison: [UNMERGED-BRANCHES-2026-11-25](../reports/UNMERGED-BRANCHES-2026-11-25.md).

Columns: **State** — `UNMERGED` (code exists on a branch), `NOT BUILT` (no usable code), `BLOCKED` (needs a decision or infrastructure first).

## Next milestone: running AI-changed code
| ID | Item | State | Source | Needs first |
|---|---|---|---|---|
| DL-001 | Isolated execution sandbox | BLOCKED | `packages/domain/src/ai/execution-gateway`, `packages/runtime-agent`, `docs/security/sandbox/` | D-21 (technology, node, budget), HG-10-02 (independent isolation review), ADR-069 acceptance, a Linux node |
| DL-002 | Build and live preview of code Claude changed (template adaptation) | BLOCKED | adaptation saves to branch `work/ai`; the live preview renders only the platform's own generator output (ADR-063) | DL-001, then wiring the real execution port into build and preview |

## Compliance (parallel implementation; must be rebuilt on `main`'s schema, not merged)
Sources: `claude/m04-compliance-46a3a9` `52cfc31c5809` (also in `integration/m03-s12d-m04`, `claude/m05-adapters-4e5fc6`, `claude/m05-provider-core-05b775`).
| ID | Item | State | Needs first |
|---|---|---|---|
| DL-010 | Admin queue for data-subject requests, identity verification, retry (screen and 4 operations) | UNMERGED | PA-13 |
| DL-011 | Platform residency floor, region matrix, decision simulator (screen and 5 operations) | UNMERGED | SI-M04-8 |
| DL-012 | Data-class coverage view (screen and 1 operation) | UNMERGED | spec for the endpoint |
| DL-013 | Breach case detail and evidence pack (screen and 2 operations) | UNMERGED | spec |
| DL-014 | Compliance overview screen | UNMERGED | DL-010 to DL-013 |
| DL-015 | Control detail, control review records, removing a control mapping | UNMERGED | spec |
| DL-016 | Starting evidence collectors and retention runs from the API (collectors work from the command line; retention has preview only) | UNMERGED | spec |
| DL-017 | Listing legal holds | UNMERGED | SI-M04-7 |
| DL-018 | Listing consent purposes and request reason codes | UNMERGED | SI-M04-6 |

## Design and documentation
| ID | Item | State | Source | Notes |
|---|---|---|---|---|
| DL-020 | "Bento" dashboard design (resources panel, mosaic, UI kit, fonts) | UNMERGED | `feat/webapp-studio-parity` `a37f0e7b64e3`, `wip/slider-pause-from-other-session` `ff31ea420ff9`, detached worktree `merge-final` | product decision; the current dashboard is a later design |
| DL-021 | Domain and e-mail screens redesign | UNMERGED, unfinished | `feat/domain-email-design` `b70d76f96163` | stopped at the owner's request |
| DL-022 | In-console documentation (4 screens, `ConsoleDocs`) | UNMERGED | `recovery/desktop-uncommitted-2026-11-25` `7d4b8100451c` | |
| DL-023 | Desktop app (Windows/macOS) improvements, offline page, fonts | UNMERGED | same recovery branch | |
| DL-024 | Cloud compute loading placeholder | UNMERGED, cosmetic | `integration/m05-m08` `9bf974c58344` | |

## Sign-in
| ID | Item | State | Source | Required before any merge |
|---|---|---|---|---|
| DL-030 | Long-lived sessions for the desktop app | UNMERGED, **security review required** | recovery branch `7d4b8100451c` (`identity/internal/session.service.ts`) | **As written, any customer sign-in whose User-Agent contains `NuzmDesktop/<n>` gets a sliding 10-year session. The header is chosen by the client, it is on by default (`SESSION_DESKTOP_SECONDS`), and it overrides the accepted 30-minute idle and 12-hour absolute limits (D-30).** Needs a way to authenticate the desktop client, a bounded lifetime, default off, an owner decision, and a new decision number (its `D-51` is already used by the Dynadot decision). |
| — | Development fixed two-factor code (`feat/dev-fixed-mfa-code` `6a418a0cc379`; also in `claude/local-app-credentials-ea83ec`) | **WILL NOT MERGE** | | Owner decision 2026-11-25: it weakens two-factor sign-in. Branch preserved. |

## Gaps found while preparing manual testing
| ID | Item | State | Notes |
|---|---|---|---|
| DL-040 | The admin template upload form cannot state provenance | NOT BUILT | Every upload from the console is `THIRD_PARTY`, so activation needs **two approvals from admins other than the uploader**. The API accepts `FIRST_PARTY` (one approval) with the publish permission. |
| DL-041 | The project-type filter on the builder start screen is shown only to read-only members | product decision | Changed when the two console designs were reconciled (Phase 3 note). |
| DL-042 | The AI change path policy accepts `.env` / dotenv files | OPEN, security | Found by the template validation (2026-11-26): `..`, absolute paths, `.git`, backslashes and secret patterns are refused, but a model can add `.env`. Refuse dotenv names in the proposal checks. |
| DL-043 | A failed copy-from-template leaves an empty project | OPEN | The project row is created before the copy; a failure should remove it or mark it failed. |
| DL-044 | Plan and run responses do not return the run id | OPEN | Clients must poll the plan to find the run. |
| DL-045 | A failed run's error shows the raw database message to the customer | OPEN | e.g. a constraint name in `ai.runs.error.message`; map to a registry code. |
| DL-046 | The web-app activity timeline lists a failed run's reason in the server's English words | OPEN, minor | The run card shows the localized reason (2026-11-26); the timeline event still uses the raw message. |
| DL-047 | Tune the library's automatic-selection coverage (0.4) with real templates | OPEN | Keyword/metadata matching only (semantic search BLOCKED, D-47). First value chosen after a café starter was matched to an agency brief. |
| DL-048 | Confirm: a website request matched to a library template becomes a code (web-app) project | product decision | The section-based website builder cannot use template source; see `docs/reports/AI-BUILDER-CUSTOMER-FIXES-2026-11-26.md` §2.3. |

## Known data and test limits (not features)
- Two chat messages created 2026-11-20 cannot be opened with any field key present on this machine. They are preserved unchanged.
- The template library in the preserved database is empty.
