# ADR-008: Identity provider

- Status: **Proposed — partially decided by the owner (2026-11-18, in chat); formal acceptance and signature pending**
- Related decision: D-04 (see `docs/07-open-decisions-and-blockers.md`)
- Source of proposal: `docs/02-system-architecture.md` §11

## Context
See docs/02 and docs/05. Until now the platform signed people in only through an external OpenID Connect provider (authorization code + PKCE) and never stored a password. The provider itself (D-04: Keycloak / Ory / managed / custom) is still not chosen.

## Decision (owner choice recorded 2026-11-18)
1. **Customer console (`web`, realm `web`):** Nuzm itself offers **email + password registration and login**. A user created this way has `issuer = 'nuzm:local'`; the password is stored only as a salted scrypt hash in `identity.credentials` (parameters inside the hash string so they can be raised later). OIDC sign-in for the customer console stays available as an additional method.
2. **Admin console (realm `admin`):** unchanged — **platform staff sign in through OIDC only and always with MFA**. A database trigger refuses a password for a platform user, and the password endpoints refuse the admin realm.
3. Passwords: 12–128 characters, no composition rules, a short deny-list of very common passwords, never equal to the email address. Five consecutive failures lock the account for 15 minutes (proposals; same numbers as MFA). Responses for unknown email, wrong password and a locked account are identical (no account enumeration at login); unknown-email logins spend the same hashing time.
4. Email verification and password reset use single-use, hashed, expiring tokens (`identity.auth_tokens`); a reset revokes every session of the user. Delivery goes through the existing `Mailer` port; the development mailer logs the token, production has no mail provider until M08/D-08 and so cannot send these emails yet.

## Alternatives considered
- Only an external IdP with a sign-up page (the proposed default in docs/02) — not chosen by the owner for the customer console.
- Argon2id instead of scrypt — preferred by OWASP but needs a native dependency; scrypt (OWASP-listed, in Node's core) is used now and the hash format allows moving later.

## Consequences
- The platform is now a credential holder for customers: breach handling (`docs/runbooks/breach-handling.md`), the ROPA and the data classification include `identity.credentials` (`password_hash`: credentials).
- Self-registered email addresses are **not verified** before use until a mail provider exists (D-08); this must be decided before paid features are opened to self-registered accounts.
- No MFA is required for customer sign-in (as before); factors can be enrolled by the user.
- D-04 remains open for the staff identity provider.

## Owner / date
Owner (chat) / 2026-11-18 — signature pending.
