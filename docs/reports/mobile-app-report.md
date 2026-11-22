# Mobile app (Flutter): Nuzm AI home + every console page, live API — report

Date: 2026-11-22 · Branch: `claude/flutter-app-identity-colors-466efc` · Not a milestone deliverable: a new client of the
existing API. It adds no endpoints, tables or migrations.

## A. Findings and assumptions
- The identity comes from the customer console's design system (`packages/ui/src/console-css.ts`): chrome gradient,
  frame, mint/teal accent, orange second colour and the Cairo font. Navigation comes from `apps/web/lib/nav.ts` and
  labels from `packages/i18n`.
- Auth is cookie-based (`nuzm_session` + `nuzm_csrf`, realm `web`). A native client can hold the cookies itself, so
  no API change was needed. The web build cannot (browser cookie rules), so it runs on sample data.
- Assumption: the app is read-first. Writes beyond sign-in, organization creation, AI chat and marking notifications
  read stay in the web console for now (they show a note).

## B. Plan and changed files
- `apps/mobile/` (new Flutter app, see its README): `lib/api/*` (client, secure session store, data source, generated
  notification texts), `lib/screens/*`, `lib/theme/*`, `lib/widgets/*`, `test/*`, `assets/fonts` (Cairo, OFL).
- `eslint.config.mjs` and `.prettierignore`: skip `apps/mobile` (Dart, checked by `flutter analyze`; its build output
  is generated JS).
- `.claude/launch.json`: `mobile-web` preview (serves `apps/mobile/build/web`).

## C. Screens
Nuzm AI home (chat), menu (search, quick sections, all 13 sections, recent chats, account and organization switcher,
sign-out), section screen with the console's underlined tabs for all 44 pages, resource detail, notifications,
sign-in, create organization, splash. Every page has loading, empty, error, forbidden and not-enabled states. Arabic
(RTL) is the default; English, light and dark are also covered.

## D. Migrations
None.

## E. Tests run (actual results)
| Command | Result |
|---|---|
| `flutter analyze` | PASS: No issues found |
| `flutter test` | PASS: 28 passed, 1 skipped (the live check, run separately) |
| `NUZM_LIVE_API=http://127.0.0.1:4000 flutter test test/live_api_test.dart` | PASS: sign-up → create org → 44/44 pages, notifications, recent chats and domain search loaded from the local API + Postgres; sign-out OK |
| `pnpm scan:secrets` | PASS: 2490 files, 0 hits |
| `pnpm compliance:claims-guard` | PASS |
| `eslint .` / `prettier --check .` | Not clean, but no finding is in a file from this change: 3 ESLint files (`apps/web/components/PaymentsPanels.tsx`, `design/*/…mjs`) and 35 Prettier files, all untouched here |

The UI tests render every page in ar/en × light/dark at phone size and fail on any layout overflow. The API tests use
a fake HTTP server: cookies, CSRF only on unsafe methods, org header, UUID v4 idempotency key, 401 forgets the session,
offline, sign-in → organization, no-organization path, mappers (minor units), forbidden/404, and the chat flow.

Screenshots (web build, sample data): `docs/reports/mobile-app/{home-ar-dark,menu-ar-dark,home-ar-light,dashboard-ar-light}.jpg`.

## F. Security, tenancy, billing, residency
- Tenant context only from `/v1/me` memberships, sent as `x-nuzm-org`. The API stays the authority (RLS); the app
  never builds org-scoped paths from user input.
- The session cookie lives in the Keychain / Keystore and is never logged. Cleartext http is allowed only in the
  Android debug manifest and for local addresses on iOS.
- Money is shown from integer minor units with its currency; no floats.
- AI chat on the local stack answered `403 residency_denied`: the organization's residency policy blocks the
  configured AI provider. The app shows that in Arabic or English and does not work around it.
- Domain search answered `503 service_unavailable` once (registrar sandbox, HG-07-01 NOT VERIFIED). The app shows a
  "temporarily unavailable" message.

## G. Human gates and live checks still needed
- AI chat replies end to end: NOT VERIFIED (blocked by the residency policy on the dev stack; needs an allowed
  provider/region decision).
- Store builds, signing and submission: not done (owner action; §5).
- A device or simulator run of the native builds: NOT VERIFIED here (no simulator in this session). The data layer was
  checked live from the VM; screens were checked in tests and on the web build.

## H. Acceptance
| Item | Status |
|---|---|
| Layout like the reference (AI home + menu) | PASS (screenshots) |
| Console identity in light and dark, same gradients | PASS (tokens from console-css.ts; screenshots) |
| All console pages | PASS (44/44 render in tests; 44/44 load live) |
| Integrated with API and database | PASS for reads, sign-in, org, notifications, domain search; NOT VERIFIED for AI replies (residency) |
| Writes (create/edit/delete) | DEFERRED: web console for now |

## I. Next
Create/edit flows per module (with the same idempotency and step-up rules as the web console), registration, password
reset and two-step verification in the app, push notifications, a feature flag for the mobile client, and a
simulator/device E2E run.
