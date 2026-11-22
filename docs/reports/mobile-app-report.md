# Mobile app (Flutter): Nuzm AI home + every console page, live API — report

Date: 2026-11-22 · Branch: `claude/flutter-app-identity-colors-466efc` · Not a milestone deliverable: a new client of the
existing API. It adds no endpoints, tables or migrations.

## A. Findings and assumptions
- The identity comes from the customer console's design system (`packages/ui/src/console-css.ts`): chrome gradient,
  frame, mint/teal accent, orange second colour and the Cairo font. Navigation comes from `apps/web/lib/nav.ts` and
  labels from `packages/i18n`.
- Auth is cookie-based (`nuzm_session` + `nuzm_csrf`, realm `web`). A native client can hold the cookies itself, so
  no API change was needed. The web build cannot (browser cookie rules), so it runs on sample data.
- Writes follow the web console's rules: quote → price → confirm for paid resources, If-Match on edits and deletes,
  one Idempotency-Key per submission, typed confirmation where the API asks for it (build-project delete).
  A few writes stay in the web console (see the app README, "Still in the web console").

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
| `flutter test` | PASS: 37 passed, 1 skipped (the live check, run separately) |
| `NUZM_LIVE_API=http://127.0.0.1:4000 flutter test test/live_api_test.dart` | PASS: sign-up → create org → 44/44 pages read; writes through the app's own action definitions: workspace and project create, rename and delete; build project create, rename and delete; organization, tax profile, spending cap and AI budgets saved; template created; suppression added and removed; invitation sent; password changed; a hosting quote priced (Start/php:8.2 = 33.35 SAR incl. 4.35 tax). Email domains and storage, mailbox and database quotes answered `unsupported_capability` (no provider enabled on the dev stack): recorded, not failed. |
| `pnpm scan:secrets` | PASS: 2490 files, 0 hits |
| `pnpm compliance:claims-guard` | PASS |
| `eslint .` / `prettier --check .` | Not clean, but no finding is in a file from this change: 3 ESLint files (`apps/web/components/PaymentsPanels.tsx`, `design/*/…mjs`) and 35 Prettier files, all untouched here |

The UI tests render every page in ar/en × light/dark at phone size and fail on any layout overflow. The API tests use
a fake HTTP server: cookies, CSRF only on unsafe methods, org header, UUID v4 idempotency key, 401 forgets the session,
offline, sign-in → organization, no-organization path, mappers (minor units), forbidden/404, and the chat flow.

Screenshots (web build, sample data): `docs/reports/mobile-app/{home-ar-dark,menu-ar-dark,home-ar-light,dashboard-ar-light,create-form-ar-dark,detail-actions-ar-dark}.jpg`.

Write tests (`test/actions_test.dart`):
- **Requests:** one idempotency key per submission (a retry reuses it), CSRF on writes, If-Match from the ETag on edits and deletes, quote bodies built from the form and `quoteId` on create.
- **Values:** money as integer minor units, approvals sending the scope hash, members addressed by user id, state-based visibility.
- **UI flow:** form → validation → price → nothing created until confirm → create → list reloads.
- **Sample mode:** never writes.

Bugs the live run found and fixed:
- **Build-project delete:** the app now asks for `confirmName`.
- **Template key:** the form's check now matches the API's slug rule.
- **Plan names:** they come in both languages (`{ar, en}`) and are now shown in the reader's language.

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
| Writes (create/edit/delete) | PASS for the non-paid writes (live); paid creates NOT VERIFIED live: quotes price correctly, but nothing was created without a person confirming a charge, and no provider is enabled on the dev stack for email, storage or databases |

## Update 2026-11-23: menu, transition, chat starters, attachments, voice
- **Menu:** borderless items; the wallet and AI credits on the console's hero surface; the organization as a card that
  opens a switch list; appearance and language moved into a settings section next to sign-out.
- **Transition:** the menu opens as a circle growing from the menu button while fading in, and closes back into it
  (`lib/widgets/circular_reveal.dart`; a plain fade when the system asks for reduced motion).
- **Chat:** the refresh button is gone. Three start cards (mobile app, web app, website) sit above the composer.
- **Attachments:** text files and links, sent as `attachments` on `POST /v1/ai/sessions/{id}/messages`.
  PASS live: the local API stored `[text, url]`.
- **Voice:** dictation with the phone's speech recognizer. NOT VERIFIED on a device: the recognizer and the
  microphone permission need a real phone.
  - Assumption: dictation runs through the operating system's recognizer, like the keyboard mic, before anything
    reaches Nuzm. Whether that is acceptable under the residency policy is an owner decision. It can be limited to
    on-device recognition (`onDevice: true`), at the cost of not working on phones without an offline language pack.
- **Tests:** `flutter analyze` → no issues; `flutter test` → 38 passed, 1 skipped (the live check);
  `NUZM_LIVE_API=… flutter test test/live_api_test.dart` → PASS.
- **Screenshots:** `docs/reports/mobile-app/{home-ar-dark,menu-ar-dark,menu-settings-ar-dark,menu-ar-light}.jpg`.

## I. Next
Next steps:
- **In-app flows:** paying invoices through the payment provider's redirect, setting up and answering two-step verification (that unlocks step-up actions), registration and password reset.
- **Remaining writes:** workflows, connectors and webhooks.
- **Infrastructure:** push notifications, a feature flag for the mobile client, and a simulator/device end-to-end run.
