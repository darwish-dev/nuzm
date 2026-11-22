# Nuzm mobile app (`apps/mobile`)

Flutter app for the customer console. The home screen is **Nuzm AI** (the builder assistant); the menu opens every
section of the web console (13 sections, 44 pages) in Arabic (default, RTL) and English, light and dark.

The look is the console's own design system (`packages/ui/src/console-css.ts`), token for token and gradient angle for
gradient angle. See `lib/theme/nuzm_colors.dart`:

- the window is the chrome gradient (dark 180°, light 98°) with its glows, and the content sits in the frame
  (22 px top corners, 1 px border, 6 px from the edges)
- primary buttons, the mic/send button and the counts use the orange gradient at 165°
- cards are 18 px with a 1 px border, fields 14 px, and section tabs are underlined in the accent colour

## Run

```bash
pnpm services:start && pnpm db:migrate && pnpm --filter @nuzm/api dev:stack   # API on :4000
cd apps/mobile && flutter run                                                    # Android emulator / iOS simulator
```

- Debug builds reach the local API at `10.0.2.2:4000` (Android emulator) or `127.0.0.1:4000` (iOS simulator).
- Point any build elsewhere with `--dart-define=NUZM_API_URL=https://…`. Release builds must use https:
  cleartext is allowed only in the Android debug manifest and for local addresses on iOS.
- The web build (`flutter build web`) runs on **sample data only**. Browsers keep the API's cookies away from the page,
  so live mode needs a native build.

## How it talks to the API

- `lib/api/api_client.dart` sends what the web SDK sends: the `nuzm_session` cookie of the `web` realm, `x-csrf-token`
  from `nuzm_csrf` on unsafe methods, `x-nuzm-org`, `x-nuzm-realm: web`, `accept-language`, and an `Idempotency-Key`
  on every POST. Cookies are kept in the Keychain / Android Keystore (`flutter_secure_storage`) and never logged.
- `lib/api/api_data_source.dart` maps each page to the endpoint the web console uses for it: `/v1/compute/instances`,
  `/v1/billing/invoices`, `/v1/organizations/{orgId}/members`, and so on. Money stays in integer minor units.
- Sign-in uses `POST /v1/auth/password/login`. The organization comes from `/v1/me` memberships; an account with no
  organization is asked to create one (`POST /v1/organizations`).
- Nuzm AI chat flow: `POST /v1/ai/sessions` → `POST /v1/ai/sessions/{id}/messages` → `POST /v1/ai/runs`
  (`kind: chat`) → poll the run → read the assistant message.
- Error handling: 401 returns to sign-in; 403 shows the forbidden state; 404 (module flag off) shows "not switched on";
  problem codes such as `residency_denied` and `insufficient_credits` are explained in the reader's language.
- `lib/api/notification_kinds.dart` is generated from `packages/i18n` (`notif.kind.*`).

## Check

```bash
flutter analyze
flutter test                                                       # UI (all pages × ar/en × light/dark) + API layer
NUZM_LIVE_API=http://127.0.0.1:4000 flutter test test/live_api_test.dart   # against a running local stack
```

The live check registers a throwaway `mobile-it-<time>@example.test` account. Its password is random and never
printed. The check refuses any host that is not local or `.test`.

## Not yet in the app (web console only for now)

- Create, edit and delete actions: the app reads everything, signs in, switches organizations, chats with Nuzm AI and
  marks notifications read; other writes show "available in the web console".
- Registration, password reset and two-step verification.

Fonts: Cairo (SIL OFL 1.1, `assets/fonts/Cairo-OFL.txt`), static weights cut from google/fonts `Cairo[slnt,wght].ttf`.
