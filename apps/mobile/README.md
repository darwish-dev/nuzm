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

## Try it on a phone (local demo account)

```bash
pnpm exec tsx scripts/seed-mobile-demo.ts        # demo account + data; credentials → .local/mobile-demo-account.txt
cd apps/mobile && flutter build apk --debug --target-platform android-arm,android-arm64 \
  --dart-define=NUZM_API_URL=http://<this-mac-lan-ip>:4100
```

The API listens on 127.0.0.1 only, so a phone on the same Wi-Fi needs a relay from `<lan-ip>:4100` to
`127.0.0.1:4000` while testing (stop it afterwards: it exposes the dev API to the local network). Debug builds only:
release builds do not allow plain http.

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

## Writes (create, edit, delete)

`lib/actions/registry.dart` holds every write, per page, against the same endpoints the web console calls. The screens
show them as an orange button at the top of the page (create or edit) and as buttons on each item's detail screen.
`lib/actions/action_sheet.dart` runs them:

- **Forms** are checked before anything is sent (required fields, the API's own patterns, integer minor units for
  money). Field errors the API returns are shown on the matching field.
- **Paid resources** (servers, hosting sites, databases, buckets, mailboxes, domain register and renew) go through
  `POST /v1/quotes` → the price (subtotal, tax estimate, total, validity, a note when it needs approval) → **Confirm**
  → create with `quoteId`. Nothing is created before the person confirms the price. Changing the form invalidates
  the price.
- **Idempotency**: one `Idempotency-Key` per opened form, reused on retries. **Edits and deletes** read the
  resource's ETag and send `If-Match`.
- **Destructive actions** ask first. Deleting a build project asks for the project name, which the API requires.
  **Step-up** actions (role change, spend decisions, bucket delete) are marked; without a recent two-step
  verification the API answers `step_up_required` and the app explains it.
- In **sample mode** the forms open but never write.

Covered: workspaces, projects, build projects, mobile builds, AI approvals, AI budgets, servers (create, start, stop,
reboot, delete), hosting sites (create, rename, back up, delete), domains (register from search, renew, lock,
auto-renew), databases, buckets, email domains, mailboxes, senders, templates, messages, suppressions, spending cap,
spend approvals, subscriptions (cancel), tax profile, team (invite, role, remove), organization, and password change.

Still in the web console (`kWebOnlyWrites`): workflows, connectors, webhooks, marketplace and transfers (open-ended
bodies), paying invoices and payment methods (the payment provider's redirect), SSO, agency and reseller,
registration, password reset and setting up two-step verification.

Fonts: Cairo (SIL OFL 1.1, `assets/fonts/Cairo-OFL.txt`), static weights cut from google/fonts `Cairo[slnt,wght].ttf`.
