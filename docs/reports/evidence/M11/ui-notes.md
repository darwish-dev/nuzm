# M11 UI notes (UI-M11-01..22)

Scope: the customer console (`apps/web`, including the agency and reseller portals as route groups), the admin console (`apps/admin`), the message catalogue and the Playwright specs. Backend, spec, CLAUDE.md and the other docs were not touched. Nothing was committed.

Status vocabulary follows CLAUDE.md section 6. "BUILT" means implemented and covered by unit/component tests that were run; it does NOT mean browser-verified (see "NOT RUN").

## 1. Files

Created (customer console, `apps/web`):

- `lib/m11.ts` (DTO shapes mirrored from the API controllers, status tones, workflow-definition hints, canvas layout, grant/expiry rules, markup arithmetic, error mapping), `lib/m11.spec.ts`
- `lib/m11-server.tsx` (page gate with permission / org type / feature flag, M11 view states, acting-org cookie, agency/reseller profile loaders)
- `components/M11Ui.tsx` (mutation hook with 422 `errors[]`, `SecretOnce`, `JsonBlock`), `components/M11Parts.tsx` (`Status`, `DisabledAction`, `BlockedState`, `FeatureOff`, tabs), `components/AutomationTabs.tsx`, `components/MarketplaceTabs.tsx`, `components/ProgramTabs.tsx`
- `components/WorkflowCanvas.tsx` (plain React + SVG step cards), `components/WorkflowEditor.tsx` (canvas + JSON view, inspector, publish), `components/AutomationPanels.tsx` (status, run, connectors, webhooks), `components/MarketplacePanels.tsx` (buy, install, publisher forms), `components/ProgramsPanels.tsx` (profiles, invite, grants, acting, partners, sub-orgs, price rules), `components/M11Panels.spec.tsx`
- Pages: `app/[locale]/(console)/automation/workflows/{page,new/page,[id]/edit/page}.tsx`, `automation/executions/[id]/page.tsx`, `automation/connectors/page.tsx`, `settings/webhooks/page.tsx`, `settings/partners/page.tsx`, `marketplace/{page,listings/[id]/page,purchases/page,publisher/page}.tsx`, `agency/{clients/page,clients/[clientId]/access/page,acting/[clientId]/page,billing/page}.tsx`, `reseller/{sub-organizations,pricing,statements}/page.tsx`, `reseller/statements/export/route.ts` (CSV)

Modified (customer console): `app/[locale]/(console)/layout.tsx` (flag-aware navigation, active-section highlighting, persistent acting-as banner), `agency/page.tsx` and `reseller/page.tsx` (the M05 placeholder shells are now the dashboards UI-M11-10 and UI-M11-15).

Created (admin console, `apps/admin`): `lib/m11.ts`, `lib/m11.spec.ts`, `components/M11AdminPanels.tsx`, `app/[locale]/(console)/{marketplace/moderation,programs,automation/abuse}/page.tsx`. Modified: `app/[locale]/(console)/layout.tsx` (three navigation entries gated by platform permission).

Modified: `packages/i18n/src/messages.ts`: ONE append-only block at the end of the `ar` object and ONE at the end of the `en` object, marked `// >>> M11 UI messages` / `// <<< M11 UI messages`, 646 keys prefixed `m11.`, identical key set and placeholders in both languages, no existing line changed (the diff has only insertions).

Created (E2E): `e2e/tests/11-automation-marketplace.spec.ts`, `e2e/tests/12-agency-reseller.spec.ts`, `e2e/tests/13-admin-m11.spec.ts` (all carry a NOT RUN header). `e2e/playwright.config.ts` was NOT changed: the M11 flags are database flags (`platform.feature_flags`, as hosting and compute do), switched by the specs themselves.

## 2. Screens

| Screen | Route | Status | Notes |
|---|---|---|---|
| UI-M11-01 | `/automation/workflows` | BUILT | List, status, triggers, last run (newest execution of the first 25 rows, one call each), status filter, paging. |
| UI-M11-02 | `/automation/workflows/new`, `/automation/workflows/[id]/edit` | BUILT | Canvas of ordered/branching step cards (row per depth, lane per branch, SVG connectors, an `<ol>` in reading order) + JSON view; inspector per step (id, name, links, retry, idempotency key, params JSON, loop body); browser hints mirror the server rules (expressions are server-only); "Publish version" = POST `/v1/workflows/{id}/versions`, the server's 422 `errors[]` shown inline; create mode = POST `/v1/workflows` with triggers, the webhook secret and URL shown ONCE and then cleared; activate/pause (PATCH with If-Match), manual run, versions, recent executions. |
| UI-M11-03 | `/automation/executions/[id]` | BUILT-DISABLED-PART | Timeline grouped by step with attempts, idempotency flag, redacted input/output/error (masked again in the browser), dead letters. The replay button is rendered DISABLED with the SCR-M11-02 note. Refresh is manual (no polling). |
| UI-M11-04 | `/automation/connectors` | BUILT | Create (http / oauth2 / nuzm / email), authorize with a vault REFERENCE only (the browser refuses anything that is not `vault://…/tenant-<org>-…`), OAuth start and complete. No secret is asked for or displayed. |
| UI-M11-05 | `/settings/webhooks` | BUILT-DISABLED-PART | Create (secret shown once), rotate secret (POST with `secretRotation`, new secret shown once, overlap hours). Deliveries view and test event are DISABLED (SCR-M11-02). |
| UI-M11-06 | `/marketplace` | BUILT | Search, type filter, paging, localized title/description. |
| UI-M11-07 | `/marketplace/listings/[id]` | BUILT | Detail through `?filter[id]=`, price + provisional VAT estimate, versions; buy = POST `/v1/quotes` (kind marketplace) then POST `/v1/marketplace/purchases`; result links to the invoice and to the existing billing invoice page (which has the pay form). A pending licence is never presented as active. |
| UI-M11-08 | `/marketplace/purchases` | BUILT | No purchases-list endpoint exists: built from `GET /v1/billing/entitlements` (`marketplace[]`) + one `GET /v1/marketplace/purchases/{id}` and one listing lookup per entitlement (first 50) + `GET /v1/marketplace/installations`. Install form per active entitlement; 422 `unsupported_capability` is shown plainly with the API's reason. |
| UI-M11-09 | `/marketplace/publisher` | BUILT | Own listings (`?mine=true`), versions with moderation status and scan findings, accrual summary labelled "accrued, not paid out"; create listing and submit version forms; 403 `publisher_not_verified` shows the verification-pending state. |
| UI-M11-10 | `/agency` | BUILT-DISABLED-PART | Profile (or create it), client and grant counts, expiring grants, clients that can be acted in. Per-client health/usage is an explicit BLOCKED panel (no endpoint). |
| UI-M11-11 | `/agency/clients` | BUILT | Invite by organization id (UUID), link status. No revoke control exists in the API, none is offered. |
| UI-M11-12 | `/agency/clients/[clientId]/access` | BUILT-DISABLED-PART | Scope picker from the delegable catalogue, MANDATORY expiry (default 90 days, max 365, date input capped at 364 days), grants list. Revoke is DISABLED with the SCR-M11-01 note. |
| UI-M11-13 | `/agency/acting/[clientId]` | BUILT | Start/stop acting, switcher; cookie `nuzm_acting_org`; the layout shows a persistent client-context banner on EVERY console page while it is set. The workflow screens (list, new, edit, execution) send `X-Nuzm-Acting-Org` with the agency in `X-Nuzm-Org`; a 403 renders the forbidden state. See gap 11. |
| UI-M11-14 | `/agency/billing` | BLOCKED | No consolidated-billing endpoint, and the invoice-issuer model is open (D-24). Explanatory state, no mock. |
| UI-M11-15 | `/reseller` | BUILT | Profile (or create), sub-organization counts, rule-set version, links. |
| UI-M11-16 | `/reseller/sub-organizations` | BUILT | Link an existing organization `{subOrgId, priceBookRef}`; status; creating a new one is stated as unavailable. |
| UI-M11-17 | `/reseller/pricing` | BUILT | Rule editor (plan/meter, percent/fixed, effective date), margin preview on a sample wholesale (integer arithmetic), BELOW-COST block in the browser (save disabled, no request sent), `If-Match` = the loaded rule-set version, 412/428 reported, history. |
| UI-M11-18 | `/reseller/statements` | BUILT | Period filter, totals, ledger variance, lines, CSV through a route handler calling `?format=csv`. The issuer banner is rendered from the statement's `issuer` field (`disabled` / BLOCKED) and no control can enable a model. |
| UI-M11-19 | `/settings/partners` | BUILT-DISABLED-PART | Pending agency links, grant proposals and reseller links with accept/decline; granted scopes and expiry; revoke DISABLED (SCR-M11-01). |
| UI-M11-20 | admin `/marketplace/moderation` | BUILT-DISABLED-PART | Queue and scan results: BLOCKED panel (SCR-M11-05). The decision form is real: listing id (+ optional version id), approve/reject/suspend, reason code, notes, step-up; reports stale (409), not found, refused (422). |
| UI-M11-21 | admin `/programs` | BUILT-DISABLED-PART | Oversight reads: BLOCKED panel (SCR-M11-05). The organizations list (`GET /v1/admin/organizations`, which returns `type`) is filtered client-side to agency/reseller with the existing suspend/reinstate action. |
| UI-M11-22 | admin `/automation/abuse` | BLOCKED | Three BLOCKED panels (paused workflows, anomaly cases, DLQ monitor) naming what is missing (SCR-M11-05). |

Navigation: web entries are hidden unless the flag is on AND the member holds the permission: Workflows/Connectors/Webhooks (`automation.enabled`), Marketplace (`marketplace.enabled`), Partners (`agency.enabled` or `reseller.enabled`), Agency (type agency + `agency.enabled`), Reseller (type reseller + `reseller.enabled`). Every page also shows a "feature is not enabled" state when the flag is off. Admin entries depend on the platform permissions `admin:marketplace`, `admin:org:read`/`admin:programs`, `admin:automation`/`admin:ops`.

Cross-cutting: every screen has empty, error (with trace id), forbidden and feature-off states; the pages are server-rendered, so there is no separate skeleton (the loading state is the pending navigation, and every mutation disables its button while busy); text comes from the catalogue in Arabic (default, RTL) and English; logical CSS properties only; numbers, ids and URLs are wrapped in `Ltr`; the canvas geometry is forced LTR while card text follows the page direction.

## 3. API gaps hit (no endpoint was invented)

1. The delegable-scope catalogue is not served by the API. `DELEGABLE_SCOPES` in `apps/web/lib/m11.ts` is a copy of `apps/api/src/modules/programs/internal/delegation.ts`; the API re-validates every grant, so a stale copy cannot widen access.
2. No purchases list endpoint; entitlements carry no invoice id or version, so the purchases page makes one call per entitlement (capped at 50).
3. No publisher-status read: "verification pending" is only learned from a 403 on create / submit.
4. No artifact upload route: `artifactRef` must already exist in the publisher's own `artifact://<orgId>/…` namespace; the form says so.
5. No organization lookup for agencies and resellers: clients and sub-organizations are shown and invited by UUID only (names appear only for active reseller links).
6. No per-client health/usage (agency dashboard) and no consolidated billing endpoint.
7. A workflow's webhook trigger secret is returned only at creation and there is no rotation route; a lost secret means a new workflow. Triggers cannot be changed after creation (PATCH takes name and status only).
8. `PUT /v1/resellers/{id}/price-rules` requires every rule, including ones already in force, to have `effectiveFrom` at least one day ahead, so re-saving a set whose dates have passed is refused. The editor flags such rows and asks for a new date.
9. Not approved routes (shown disabled/BLOCKED, not faked): SCR-M11-01 revoke grant/link; SCR-M11-02 webhook delivery log, test event, DLQ replay; SCR-M11-03 listing detail GET (the UI uses `filter[id]`); SCR-M11-05 admin queues and pause/resume.
10. The M11 OpenAPI schemas are `M11Object` / `M11Page`, so response types are hand-written from the controllers (`lib/m11.ts`); a controller change will not break the typecheck.
11. `X-Nuzm-Acting-Org` is refused on non-delegable routes (including `/v1/me`), so acting cannot be applied to the whole console. Only the automation workflow/execution screens send it; the banner on every other page says that those pages still show the agency's own data.
12. The `webhooks.enabled` flag exists in the API (`WEBHOOKS_FLAG`) but only the four flags named in the task drive navigation; the webhooks entry follows `automation.enabled`.
13. OAuth completion has no callback route in the web app: after the provider redirects, the person pastes the state and the one-time code (an authorization code, not a long-lived secret).

## 4. Commands run and results

All from the worktree root, nothing else started (no dev server, no browser, no full build, no git state change).

- `pnpm --filter @nuzm/web typecheck` -> exit 0 (no errors), run after the last edit.
- `pnpm --filter @nuzm/admin typecheck` -> exit 0 (no errors), run after the last edit.
- `pnpm --filter @nuzm/i18n test` -> 1 file, 9 tests passed (key parity and placeholder parity of the 646 new keys included).
- `pnpm --filter @nuzm/web test` -> 16 files, 252 tests passed (new: `lib/m11.spec.ts` 23 tests, `components/M11Panels.spec.tsx` 18 tests: below-cost block, margin preview, If-Match, grant expiry rules, delegable-only scopes, 422 errors inline, acting header, secret shown once, vault-reference-only authorization, SSRF message, disabled actions).
- `pnpm --filter @nuzm/admin test` -> 9 files, 141 tests passed (new: `lib/m11.spec.ts`).
- `pnpm exec prettier --check` on the 47 touched `.ts`/`.tsx` files -> "All matched files use Prettier code style!" (after `prettier --write` on them).
- `pnpm exec eslint` on the same 47 files -> exit 0, no output.
- `pnpm exec tsc --noEmit -p e2e/tsconfig.json` -> only the 3 errors that already exist (`Cannot find module '@nuzm/i18n'` in `helpers.ts`, `03-billing`, `04-payments`: the e2e package cannot resolve the workspace package for `tsc`); no error in the three new specs. ESLint on the three new specs: clean.

## 5. NOT RUN

- Playwright specs `11`, `12`, `13`: written, never executed. Selectors, timing, seeded SQL (publisher, listing, moderation case, organizations of type agency/reseller) and the assumptions in each header comment are unverified. The marketplace install step cannot succeed without an artifact store behind the seeded listing; the spec asserts only that a result is shown. The workflow-run step needs the operation worker active in the e2e stack.
- axe (WCAG 2.1 AA) and the stored screenshots: they run inside `audit(...)` in those specs, so no accessibility result and no screenshot exists for any M11 screen. Keyboard operation was designed for (native controls, `aria-pressed` cards in reading order, native `<dialog>` is not used here, focusable scroll regions) but not verified by hand.
- No visual check in a browser: the canvas layout, RTL rendering of the cards and the banner placement have only been exercised through the pure layout tests and jsdom.
- No live check of any provider, payment or vault; all marketplace payment steps stop at the invoice link.
