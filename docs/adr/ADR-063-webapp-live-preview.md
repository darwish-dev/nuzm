# ADR-063: Live preview of generated web applications

- Status: **Proposed** (the owner accepts or amends; the agent may not accept it). Requested by the owner on 2026-11-20 ("Build the live preview").
- Builds on ADR-060 (isolated preview origin). Feature flag `app_builder.live_preview`, default off.

## Context
The website builder previews static output (ADR-060). A generated web application is not static: its front end calls its own API, needs a signed-in user and keeps its session in browser storage. Until now the web-app workspace showed only a description of what the agents built, with the note that no live preview existed. The owner wants to click through the app before exporting or deploying it.

## Decision
1. **What runs.** The newest application spec of the project, rendered by the trusted generator (`generateProject`). Model-authored code from the changes pipeline (S46) is NOT run in a preview; only the platform's runtime template and the spec-derived metadata are.
2. **Where it runs.** A separate child process per preview (`node --experimental-strip-types preview-launch.ts`), with an EMPTY environment except `PATH`, `NODE_ENV=development` and the TTL: no platform secret, no database address, no vault. Its store is in memory; it listens on loopback only. It exits when the API closes its stdin, on its TTL (30 min), or when replaced.
3. **How it is reached.** On the isolated preview origin of ADR-060: `<token>.<PREVIEW_DOMAIN>`, 160-bit token, only the hash is held (in memory, in `LivePreviewRegistry`). `/_preview/<token>/*` proxies every method to the child when the token is a live preview, else serves a website preview as before. Host binding and the preview-host isolation hook are unchanged.
4. **Credentials.** The isolation hook still strips `Cookie` and `Authorization` on the preview host, so console credentials never reach a preview. The app's own session (signed by the child with its own random secret, valid for the preview's lifetime) travels in `x-preview-authorization`, which the proxy hands to the child as `authorization`. The launcher creates a demo administrator with an unusable random password; the session is delivered once in the URL fragment (never sent to a server) and removed from the address by the app on load.
5. **Framing.** `<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerpolicy="no-referrer">`. This deliberately differs from ADR-060 §6: the app needs its own origin for storage and same-origin API calls. Because the preview origin is a different site from the console, `allow-same-origin` grants it nothing of the console. Responses carry `Content-Security-Policy: default-src 'self' …; frame-ancestors <console origin>` and `Cross-Origin-Resource-Policy: same-origin`.
6. **Limits.** One preview per project (a new one replaces it), 2 per organization, 8 per API process; start timeout 20 s; proxied bodies up to 8 MB; previews die with the API process.
7. **Production.** Refused (`422 unsupported_capability`) when `NODE_ENV=production`: a production preview must run in the sandbox runtime (D-21/HG-10-02), not as a child of the API. This ADR covers development and staging only.

## Consequences
- Owners can try a generated app (lists, forms, board, dashboard, CSV) with sample data before deploying it.
- A preview shows the spec-generated app; if a version also contains approved model-authored changes, those are not in the preview (a known gap until previews run in the sandbox).
- Tests: `live-preview.spec.ts` (flag gate, front end, signed-in API with sample data, writes, console `authorization` not honoured, host binding, unknown token, replacement and stop).
- NOT VERIFIED: browser E2E of the preview tab; independent security review (as for ADR-060).
