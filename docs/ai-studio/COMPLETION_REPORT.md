# AI Studio — completion report (S-A2 … S-A7)

Date: 2026-11-20. Branch: `claude/run-it-4fe893` (local only, D-01). Nothing is committed yet.
Scope: the owner's continuation instruction of 2026-11-20 (D-37, D-39, D-40 approved; D-38 approved for an isolated proof of concept only).

## A. Findings and assumptions

- AI Studio extends the existing builder (M09–M12). Nothing was rebuilt. The backend lives in `apps/api/src/modules/appbuilder/internal/studio/` because app-builder already owns the change pipeline (`ChangeService`), sandboxes and `ProjectsPort`, and already writes `builder.*` tables.
- **Consistency check of the decisions.** D-37, D-39 and D-40 are consistent with each other and with CLAUDE.md §4–5. Third-party skills come only from anonymous reads of public repositories and are never given customer credentials (D-40). Customer repositories go only through the GitHub App (D-39). D-38 stays a gate: the flag `ai.claude_code_sandbox` is off by default, and production refuses even with the flag on until `CLAUDE_CODE_COMPLIANCE=approved` records the legal/provider review. Recorded in ADR-064 ("Consistency check") and in `docs/07`.
- Assumption: connecting GitHub needs `builder:write`; reading needs `builder:read`. No new permission was added. An organization-admin-only permission can be added later if the owner wants one.
- Assumption: file **search** is the only new file-manager endpoint. Edit, rename, move and delete reuse the existing safe-diff `POST …/changes`, and the search results open in the existing Code panel.
- Website projects have no free file tree, so CLAUDE.md sync, skill files and GitHub pull/push answer 422 `unsupported_capability` for them. Web-app and mobile projects are supported.

## B/C. What was implemented

**Database:** `packages/db/migrations/builder/1840__builder__ai_studio.sql` (+ `.down.sql`) adds `builder.skills`, `skill_versions` (append-only), `skill_reviews` (append-only), `project_skills`, `project_instructions`, `instruction_versions` (append-only), `github_connections`, `github_repos`, `github_events` (append-only, platform-only, dedupe key) and `claude_code_sessions`. Every table has RLS, and tenant tables have `org_id`. Every column is classified in `spec/db/ownership.yaml`. No column can hold a token, password or cookie.

**API (33 operations, all in `spec/openapi/openapi.yaml`, tag `ai-studio`, SDK regenerated):**
- Instructions: `GET/PUT …/instructions` (If-Match versions; 428/412), `GET …/versions`, `POST …/versions/{v}/restore` (copies forward, so history is never rewritten), `POST …/sync` (writes `CLAUDE.md` through the change pipeline).
- Skills: the catalog `GET/POST /v1/builder/skills` (an organization's private skills are scanned, never executable, and visible only to that organization). Per project: `GET …/skills`, `GET …/skills/recommendations`, `POST …/skills` (explicit list or `auto`, dependency closure), `DELETE …/skills/{skillId}`. Skill files that the customer changed are never overwritten silently: the API answers 409 unless `overwrite`, and the skill stays installed when removal is refused.
- Admin registry (`/v1/admin/ai/skills`): list, get, read a file, import from a public repo (pinned to the commit, quarantined, scanned, never executed), review (licence required, scan reject blocks approval, a note is required for rejections and review verdicts, executable skills need two approvers and the importer cannot approve), and disable or enable.
- GitHub: `GET/DELETE /v1/builder/github`, `POST …/connect` (HMAC-signed state bound to the organization, user and a 30-minute expiry; one installation per organization), `GET …/repositories`. Per project: status, link/unlink, `pull` (409 if Nuzm has unsynced changes unless `replace`), `push` (on top of the last synced commit, never forced; 409 when the branch moved), and list/open pull requests. `POST /v1/webhooks/github` checks the HMAC over the raw body, dedupes on `X-GitHub-Delivery`, and handles `installation` deleted/suspend/unsuspend.
- Claude Code PoC: `GET …/claude-code`, `POST/DELETE …/claude-code/sessions`. It only probes `claude --version` inside a READY project sandbox and records observable states (`NOT_CONFIGURED`, `AUTHENTICATION_REQUIRED`, `ERROR`, `STOPPED`). It never claims `READY`, never handles credentials, and never falls back to billable API use.
- Managed API-based coding is unchanged: it keeps using the existing AI gateway (`ModelGatewayPort` → `GatewayService`). AI Studio adds no second model path.

**UI (Arabic + English, RTL, existing workspace style):**
- Web-app workspace: a new **AI Studio** tab, shown only while `ai_studio.enabled` is on. It has five views: Instructions editor (baseline read-only, project/team layers, free notes, save/sync/preview/history/restore), Skills manager, GitHub manager, file search (results open the file in Code), and Claude Code.
- `/[locale]/builder/github/callback` completes the GitHub App installation (this is the App's Setup URL).
- Admin console: **AI → Skills** registry page (filter, import, review with scan findings and file viewer, approve/reject, disable/enable).

## D. Migrations and rollback

Migration `1840__builder__ai_studio` is forward-only. Its `.down.sql` drops only the new tables and functions. It was applied to the local `nuzm_full` database (`pnpm db:migrate`: no pending migrations). The shared `nuzm_dev` database used by another session was not touched.

## E. Tests run (actual results, 2026-11-20)

| Command | Result |
|---|---|
| `pnpm lint` (eslint + prettier) | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| `pnpm spec:lint` | PASS (no warnings) |
| `pnpm spec:drift` | PASS (449/449 routes) |
| `pnpm sdk:check` | PASS |
| `pnpm scan:secrets` | PASS (2296 files, 0 hits) |
| `pnpm compliance:claims-guard` | PASS |
| `pnpm db:migrate` / `db:test-rls` | PASS (ownership + RLS rules hold) |
| `compliance:classification-coverage` / `ropa-coverage` / `residency-hooks` | PASS (3057 columns classified) |
| `@nuzm/api` unit | PASS 1006/1006 |
| `@nuzm/domain` unit | PASS 601/601 (incl. 14 AI Studio) |
| `@nuzm/web` unit | PASS 793/793 (incl. 4 AI Studio) |
| `@nuzm/admin` unit | PASS 249/249 |
| `ai-studio.int.spec.ts` | PASS 8/8 (instructions, skills, registry review rules, private skills, GitHub connect/link/pull/push/PR/conflicts, webhooks signature/dedupe/uninstall, Claude Code gate) |
| `tenancy/cross-tenant.int.spec.ts` | PASS 509/509 (new routes included; org B gets 404 on every id-bearing route) |
| All `appbuilder/*.int.spec.ts` + cross-tenant, re-run after the final edits | PASS 618/618 (10 files: existing builder behaviour unchanged) |
| Browser (local stack, ports 3100/4100, `nuzm_full`) | Instructions save to v1, auto-install of 7 skills (Flutter excluded), search → Code, GitHub (dev fake) and Claude Code views, Arabic RTL — all checked by hand |

Not run: `pnpm test:e2e` (Playwright) and the full `pnpm test:integration` across all modules. The admin Skills page was not opened in a browser; it is covered by typecheck, lint and the API integration tests only.

## F. Security, tenant isolation, billing, residency

- Tenant isolation: RLS on every new table, project lookups 404 across organizations, cross-tenant suite green.
- GitHub: installation tokens are minted per call and cached only in memory. The App private key and webhook secret come from vault references. Webhook HMAC is compared in constant time over the raw body. Pushes are never forced. Imported files pass the existing secret, canary and dependency checks.
- Skills: no execution during discovery or import; quarantine and two-person approval for executable skills; customer credentials never reach third-party skill sources.
- Claude Code: no credentials collected or stored, no billable fallback, production refuses while D-38 is open.
- Metering: no new billable action. The Claude Code PoC uses the customer's own subscription, and sandbox CPU stays metered by the existing `SandboxService`.

## G. Human gates and live checks still needed

- **HG-AS-01 — BLOCKED:** register the Nuzm GitHub App and store `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY_REF` and `GITHUB_APP_WEBHOOK_SECRET_REF` (vault refs), and set its Setup URL to `/{locale}/builder/github/callback`. Until then production answers 503 and dev/tests use the in-memory fake. Live GitHub: NOT VERIFIED.
- **D-38 — BLOCKED (legal/provider-compliance review):** commercial use of customer Claude subscriptions stays off.
- **PA-M10-01 — PENDING:** the sandbox terminal, needed for the customer to sign in to Claude Code inside the sandbox, is still hidden.
- **D-21 — OPEN:** no isolating sandbox runtime in production, so the PoC runs only on the dev runtimes.
- D-40 operations need two platform staff accounts to approve executable skills.
- Live public-GitHub skill import (`GithubPublicSkillSource`): NOT VERIFIED. Tests use the fake source.

## H. Acceptance checklist

| Item | Status |
|---|---|
| ADR-064 + decision records updated (D-37/39/40 decided, D-38 gate kept) | PASS |
| Migrations for GitHub, Skills registry, project skills, instructions | PASS |
| Backend APIs for the above | PASS (int spec) |
| Skills Manager, GitHub Manager, Instructions Editor, File Manager (search) in the Builder UI | PASS (unit + manual browser check) |
| Admin Skills registry UI | NOT VERIFIED in a browser (typecheck/lint only) |
| Claude Code PoC behind a default-off flag, production-gated | PASS (int spec) |
| Reuse of the existing AI gateway for managed coding | PASS (no new model path) |
| Live GitHub App | BLOCKED (HG-AS-01) |
| Commercial Claude Code | BLOCKED (D-38) |

## I. Handoff

To try it locally, turn on `ai_studio.enabled` for an organization in `platform.feature_flags`, and optionally `ai.claude_code_sandbox`. Both are off by default. Open questions: an organization-admin-only permission for connecting GitHub; whether the skill registry should also accept GitHub App-signed private skill sources later (currently excluded by D-40).
