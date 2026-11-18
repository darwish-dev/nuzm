# ADR-060: Isolated preview origin for builder previews

- Status: **Proposed** (the owner accepts or amends; the agent may not accept it). Milestone M09 S39.4, AC-M09-04.
- Numbering: ADR-018/019/021..049 are free on this branch; 055 exists on another branch, so 060 is used.

## Context
The website builder shows the generated static site inside the console. Generated content comes from a model and from users; it must never be able to touch the console, the API, cookies, tokens or internal networks (prompt injection and XSS are assumed).

## Decision
1. **Separate registrable domain.** A preview is served at `https://<token>.<PREVIEW_DOMAIN>/` where `PREVIEW_DOMAIN` is NOT a subdomain of the console or API domains (example: `nuzm-preview.example` vs `nuzm.sa`). No cookie, localStorage or CORS relation exists with any Nuzm origin. One origin per preview (the token is in the host name), so previews are also isolated from each other.
2. **Unguessable, short-lived, org-bound token.** 160 random bits as a DNS-safe base32 label; only the SHA-256 is stored; default lifetime 30 min; revoked when the project is deleted; at most 10 active previews per project; the token is returned exactly once.
3. **Serving path is read-only and secret-free.** `GET /_preview/<token>/<path>` reads files of one version from the database; it accepts the request only when `Host` equals `<token>.<PREVIEW_DOMAIN>` (else a plain 404 with no detail). The edge maps `https://<token>.<domain>/<path>` to that route (`infra/preview-origin/nginx.conf.example`).
4. **The preview host reaches nothing else.** An `onRequest` hook (`installPreviewIsolation`) answers 404 for every path other than `/_preview/…` when the host is under `PREVIEW_DOMAIN`, drops `Cookie` and `Authorization` before routing, and answers 404 for `/_preview/…` on any other host.
5. **Strict response headers**: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self' <forms origin>; connect-src 'self' <forms origin>; frame-ancestors <console origin>`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `Cross-Origin-Opener-Policy/Resource-Policy: same-origin`; `Permissions-Policy` deny-all; `Cache-Control: no-store`; `X-Robots-Tag: noindex`; no `Set-Cookie`; no CORS headers.
6. **Console embedding**: `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">` (never `allow-same-origin`): the page runs with an opaque origin.
7. **No model-authored script or style is ever served** (the renderer escapes everything, builds CSS from tokens, allows one first-party script, and its output is validated for inline scripts/handlers/`javascript:` URLs).
8. **Network (infrastructure, NOT VERIFIED here):** the preview-serving process runs with no egress and no access to the vault, the API tokens or the internal network; the edge (not the API) terminates TLS for the wildcard certificate. These are IaC/network-policy items for HG-12-01; the code cannot prove them.

## Consequences
Wildcard DNS and certificate for `*.<PREVIEW_DOMAIN>` are needed (owner/ops decision, cost). Tests (`builder.int.spec.ts`) verify headers, host binding, token tampering, expiry, traversal, cookie handling and that the preview host reaches no API route. An independent security review sign-off (AC-M09-04) is still required and is BLOCKED until a reviewer is named.
