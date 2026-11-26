# @nuzm/desktop — Nuzm AI for Windows and macOS

An Electron app around the customer console (`apps/web`). It **opens on the console's login page**. After sign-in,
everything in the customer console runs inside the app window: hosting, domains, email, databases, compute, storage,
AI, the builder, billing, settings and the account. It uses the same session, permissions, audit and feature flags as
the web.

The app adds no server capability of its own, so there is no new API, migration or feature flag: every console screen
keeps the flag, authorisation and tenant checks it already has.

## What the app adds

| Feature                                                                                                                       | Where                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Starts on `/login?lang=<ar\|en>`. Arabic by default (D-32); English when the OS prefers English or the person chose it        | `src/policy.ts` `loginUrl`, `pickLocale` |
| Native menu in Arabic and English, with a language switch that keeps the current console page                                 | `src/menu.ts`, `src/strings.ts`          |
| **Go** menu: shortcuts to every console area (Ctrl/Cmd+1…9), plus back and forward                                            | `src/menu.ts` `consoleSections`          |
| Bundled offline page (Arabic RTL and English, keyboard-accessible) with Retry; retries automatically when the network returns | `static/offline.*`                       |
| Remembers the window size and position and the chosen language (never credentials)                                            | `src/settings.ts`                        |
| Single instance; macOS dock behaviour; downloads (invoices) use the system save dialog                                        | `src/main.ts`                            |

## Security posture

- Sandboxed renderer, `contextIsolation`, no Node in pages, `<webview>` blocked, and a separate persistent session
  (`persist:nuzm`).
- Only the console origin, plus any configured sign-in (OIDC) origins, may load in the window. Other http(s) links open
  in the system browser. Every other scheme (`file:`, `javascript:`, custom) is blocked. Rules and tests:
  `src/policy.ts`, `src/policy.spec.ts`.
- The configured origin must be `https:`; `http:` is accepted only for localhost.
- Camera, microphone, location, notifications and USB/HID permissions are denied.
- The shell never reads or stores passwords. Sign-in happens on the console page, and the session is the console's
  cookie.
- The preload exposes one call (`retry`), and only to the bundled offline page. The main process checks the sender
  and the target address.

## Configuration

Where the console lives, highest precedence first:

1. Command line: `--origin=https://…` and `--auth-origin=https://…` (repeatable)
2. Environment: `NUZM_WEB_ORIGIN` and `NUZM_AUTH_ORIGINS` (comma-separated)
3. `app-config.json` next to `package.json`, bundled into the build (copy `app-config.example.json`; the real file is
   git-ignored)
4. Default: `http://127.0.0.1:3000` (the local console)

## Commands

```bash
pnpm --filter @nuzm/desktop start        # build and open the app against the local console (start apps/web first)
pnpm --filter @nuzm/desktop test         # policy, settings and string tests
pnpm --filter @nuzm/desktop dist:mac     # release/Nuzm AI-<v>-{arm64,x64}.dmg + .zip
pnpm --filter @nuzm/desktop dist:win     # release/Nuzm AI Setup <v>.exe (NSIS, x64 + arm64; builds on macOS too)
```

## Status

| Item                                                                                         | Status                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| App opens on the login page (ar RTL, en) against the local console                           | PASS (dev run and packaged macOS x64 app, screenshots taken 2026-11-23)                                                       |
| Offline page and Retry; a retry address off the allowed origins falls back to the login page | PASS (dev run)                                                                                                                |
| Navigation, configuration, language and settings rules                                       | PASS (`vitest`, 14 tests)                                                                                                     |
| macOS `.dmg` (x64) and Windows NSIS `.exe` (x64) build on macOS                              | PASS (built 2026-11-23)                                                                                                       |
| Windows installer installed and run on Windows                                               | NOT VERIFIED (no Windows machine available)                                                                                   |
| arm64 builds (Apple silicon, Windows on ARM)                                                 | NOT VERIFIED (configured, not built here)                                                                                     |
| Code signing (Windows Authenticode) and Apple notarization                                   | BLOCKED (CLAUDE.md §5: production signing keys are a human gate). Unsigned builds trigger Gatekeeper and SmartScreen warnings |
| Production console origin bundled in `app-config.json`                                       | BLOCKED (production domain not decided)                                                                                       |
| Auto-update channel                                                                          | DEFERRED (needs signed builds and a release host)                                                                             |
