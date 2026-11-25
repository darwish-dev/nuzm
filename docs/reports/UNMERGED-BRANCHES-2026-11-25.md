# Excluded branches: what each holds that the final commit does not

Date: 2026-11-25. Final code commit compared against: `ac186dc6` (`integration/unified-main`).
**Nothing was deleted.** All 14 branches, every worktree and all uncommitted files are as they were. Nothing was pushed.

## How this was compared, and what the method cannot see
For each branch, only what its **own** non-merge commits touched was compared with the final commit: screens (Next.js `page.tsx` / `route.ts`, ignoring the `[locale]` and route-group folders), API operations (method and path in `spec/openapi/openapi.yaml`), tables and columns (parsed from migration SQL), migration files (by name, ignoring the number), exported names, and source files. Branches that only edit existing files were checked by how many of their added lines exist in the final files. The compliance operations were then checked by hand against the final controllers.
**Limit:** this is a comparison of names and text. Two functions with the same name that behave differently would not show up. "Duplicate" below means the capability was found in the final code, not that both versions behave identically.

## Summary

| # | Branch (head) | Verdict |
|---|---|---|
| 1 | `claude/all-branches` (`ca4289feb9a9`) | **Duplicate.** Two merge commits, no changes of its own. |
| 2 | `claude/merge-branches-run-import-295c4d` (`bad6091eaf10`) | **Duplicate.** Two commits; both topics are covered. |
| 3 | `claude/local-app-credentials-ea83ec` (`5cd323bf5b5c`) | **Superseded** early billing ledger; its dev MFA shortcut is unmerged (see 14). |
| 4 | `claude/m04-compliance-46a3a9` (`52cfc31c5809`) | **Contains genuinely unmerged compliance functionality** (section A). |
| 5 | `integration/m03-s12d-m04` (`dcf34da5f9f2`) | Same compliance functionality as 4. Nothing further. |
| 6 | `claude/m05-adapters-4e5fc6` (`11f3475ca35a`) | Same as 4. Its cloud work is in the final commit; one compute loading state is not. |
| 7 | `claude/m05-provider-core-05b775` (`4f80238781a0`) | Same as 4. Its cloud work is in the final commit (`RegionResolver` is replaced by the region registry). |
| 8 | `integration/m05-m08` (`9bf974c58344`) | **Obsolete by decision** (CloudPanel node agent) plus one loading state. |
| 9 | `feat/start-project-ai` (`a0d1ea53223d`) | **Duplicate / superseded** by `0eca6a51`, which is in the final commit. |
| 10 | `preview/all-features` (`f3d4eb8548f2`) | **Superseded** test reconciliation. No product code of its own. |
| 11 | `feat/webapp-studio-parity` (`a37f0e7b64e3`) | **Genuinely unmerged design** (section B). |
| 12 | `wip/slider-pause-from-other-session` (`ff31ea420ff9`) | Same as 11. Its own slider-pause commit is 85% present. |
| 13 | `feat/domain-email-design` (`b70d76f96163`) | **Genuinely unmerged, unfinished** redesign (section C). |
| 14 | `feat/dev-fixed-mfa-code` (`6a418a0cc379`) | **Genuinely unmerged, left out on purpose** (it weakens two-factor sign-in). |

## Branch by branch

### 1. `claude/all-branches`
No non-merge commit is missing from the final commit. Screens, APIs, migrations, logic: none unique.

### 2. `claude/merge-branches-run-import-295c4d`
- `00506efb` (browser-test updates, 19 spec files): **duplicate topic.** The final commit has Phase 3's updates for the same redesign, and the full suite passes (114 of 114).
- `bad6091e` (notification bell's unread count in its accessible name): **duplicate.** The final component already puts the count in the name without brackets (`Notifications 3`; this branch writes `Notifications: 3`).
- Its earlier commit `74b6477d` **is** merged.

### 3. `claude/local-app-credentials-ea83ec`
An early version of the M02 billing ledger.
- Database: migration `0200__billing__ledger_core`, table `billing.chart_of_accounts`, 6 columns (`ledger_accounts.scope_key`, `sub_key`; `ledger_transactions.created_at`, `reverses_transaction_id`, `scope_key`; `wallet_balances.version`).
- Logic: `ledger-posting.service.ts` and posting recipes with dimensions.
- **Verdict: superseded.** `main` carries the owner-signed M02 ledger with its own schema and service, including reversing entries. The two schemas cannot both be applied.
- It also contains the dev fixed-MFA commit (`1acdf694`), the same change as branch 14.

### 8. `integration/m05-m08`
- APIs: `GET /v1/admin/hosting/agents`, `GET /v1/admin/hosting/nodes/{}/command-log`, `POST /v1/admin/hosting/nodes/{}/enrolment-tokens`. These belong to the CloudPanel node agent, which ADR-067 (HestiaCP) replaced.
- UI: `compute/loading.tsx` with `ComputeLoading` (a loading placeholder): **unmerged**, cosmetic.
- Screens, tables, migrations: none unique.

### 9. `feat/start-project-ai` and 10. `preview/all-features`
- 9: "start a project" prompt box. The same commit title is merged as `0eca6a51`; 78% of this copy's lines are in the final files, and the rest was rewritten later (the projects sidebar).
- 10: 35 test lines reconciling an old combined merge; superseded by later tests.

### 14. `feat/dev-fixed-mfa-code`
A development-only switch (`DEV_FIXED_MFA_CODE`) that accepts a fixed two-factor code. 7 files. **Unmerged on purpose:** it weakens a security control.

## A. Genuinely unmerged compliance functionality (branches 4, 5, 6, 7)
This is a **second, parallel implementation of M04**. `main` adopted the other one. It uses a different shape for the same compliance tables (33 columns and migrations `0500__compliance__core`, `0502__compliance__residency_assessments`, `0504__compliance__controls_evidence` differ), so it **cannot be merged as it is**: bringing features over means rewriting them against `main`'s schema. `main`'s M04 report records several of them as not built or waiting for an owner decision.

**Not available in the final commit**

| Capability | Screens | API operations | `main`'s record |
|---|---|---|---|
| Admin queue for data-subject requests, with identity verification and retry | `compliance/dsr-queue` | `GET /v1/admin/compliance/dsr-requests`, `…/{}`, `POST …/{}/identity-verification`, `POST …/{}/retry` | blocked, PA-13 |
| Platform residency floor, region matrix and decision simulator | `compliance/residency` | `GET/PUT …/residency/floor`, `GET …/residency/matrix`, `…/regions`, `POST …/residency/evaluations` | blocked, SI-M04-8 |
| Data-class coverage view | `compliance/data-classes` | `GET /v1/admin/compliance/data-classes` | not built |
| Breach case detail and evidence pack | `compliance/breach-cases/[id]` | `GET …/breach-cases/{}`, `…/{}/evidence-pack` | list and transitions only |
| Compliance overview page | `compliance` | none | none |
| Control detail, control review records, removing a mapping | none | `GET …/controls/{}`, `POST …/controls/{}/reviews`, `DELETE …/control-mappings/{}` | the final commit can only add mappings |
| Starting evidence collectors from the API | none | `POST …/evidence/collectors/runs` | command line only (`pnpm compliance:collect-evidence`) |
| Starting a retention run | none | `POST …/retention-policies/runs` | preview only |
| Listing legal holds | none | `GET …/legal-holds` | gap SI-M04-7 |
| Listing consent purposes; request reason codes | none | `GET /v1/compliance/consents/purposes`, `GET …/data-subject-requests/reason-codes` | gap SI-M04-6 (the purpose catalogue exists internally) |

**Present in the final commit under a different shape (duplicates):** releasing a legal hold (`POST …/legal-holds`), moving a breach case (`POST …/breach-cases` with `caseId`), deciding a transfer assessment (`POST …/transfer-assessments`), retention preview (`GET …/retention-policies?evaluate=true`), record-of-processing history (`GET …/ropa?history=true`), export download (`GET …/data-exports?download=`, so the separate web download route is not needed), saving a regulatory validation (`POST` in place of `PUT`).

## B. Genuinely unmerged dashboard design (branches 11, 12; also detached worktree `merge-final`)
A "bento" dashboard: `DashboardPanel` with a resources panel, attention card and key-figure cards; the mosaic layout (`mosaic.ts`); the bento UI kit (`bento.tsx`, `bento-css.ts`, `bento-mark.tsx`, `bento-scenes.tsx`); two fonts. No API or database changes. The orange accent work that followed **is** merged, and the final console has a different, later dashboard. Whether this design should return is a product decision.

## C. Genuinely unmerged, unfinished redesign (branch 13)
Domain and e-mail screens: `DomainEmailUi`, `DomainSearchUi`, `EmailDomainsUi` and their styles (about 11% of the commit's lines are in the final files). The commit says it was **stopped at the owner's request and is not finished**. No API or database changes.

## Work that was on no branch (updated after the owner's decisions of 2026-11-25)
| Worktree | What it is | Outcome |
|---|---|---|
| `desktop-app-windows-macos-72a554` | 22 changed and 11 new files: desktop app improvements, an in-console documentation section (4 screens), **changes to sign-in sessions** with a new test | **Preserved** as local branch `recovery/desktop-uncommitted-2026-11-25` (`7d4b8100451c`, on top of `cc20ad3b`), all 33 files identical to the worktree, which was not modified. Searched first for 549 real secret values and key-shaped text: none. **Not reviewed for merge: its sign-in change gives any customer sign-in with a `NuzmDesktop/<n>` User-Agent a 10-year sliding session (backlog DL-030).** |
| `run-it-c30e55` | `.claude/skills/ui-ux-pro-max/` (48 files, an agent design skill) | Tooling, not product code. Left as it is. |
| `run-it-4fe893` | `.claude/launch.json` edits | Local tooling. Left as it is. |
| `p3-s09-version-store-a31cc6` | ownership and residency edits | **Duplicate:** every added line is in the final commit. Left as it is. |
| `merge-branches-run-import-295c4d` | an untracked, unignored copy of a vault seal key (`apps/api/.dev-vault.bak-new/dev-seal-key`) | **Secured:** copied to `~/.nuzm-secure-backups/vault-keys-20261125/` (outside every repository, owner-only), verified byte for byte, then the stray copy was removed. It opened none of the 620 entries in the 36 vault folders on this machine. |

## Recommendations
1. Decide whether any of section A should be rebuilt on `main`'s compliance schema (the DSR admin queue depends on PA-13).
2. Decide on the bento dashboard and the unfinished domain and e-mail redesign.
3. Have the desktop sign-in change reviewed before any of the recovery branch is merged.

Deferred items are tracked in [the backlog](../backlog/LOCAL-DELIVERY-DEFERRED.md).
