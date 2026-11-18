# Runbook — customer accounts (email + password sign-in)

Decision: ADR-008 (owner choice 2026-11-18, signature pending). Customer console only. Platform staff keep OIDC with MFA; the database refuses a password for a platform user.

## What exists
| Screen (web) | API |
|---|---|
| `/{locale}/register` | `POST /v1/auth/register` |
| `/{locale}/login` (plus "sign in with your identity provider") | `POST /v1/auth/password/login`, `GET /v1/auth/oidc/login` |
| `/{locale}/forgot-password`, `/{locale}/reset-password?token=` | `POST /v1/auth/password/forgot`, `…/reset` |
| `/{locale}/verify-email?token=` and the banner in the console | `POST /v1/auth/email/verification`, `…/resend` |
| `/{locale}/account/security/password` | `POST /v1/auth/password/change` |

Tables: `identity.credentials` (scrypt hash, failure counter, lock), `identity.auth_tokens` (SHA-256 of emailed single-use tokens). Users created here have `issuer = nuzm:local`; the same email through the identity provider is a different account.

## Rules enforced
- Password 12–128 characters, not a very common one, not the email. Hash `scrypt$N$r$p$salt$hash` (cost inside the string).
- Sign-in answers wrong password, unknown email, locked, disabled and staff accounts identically (401 `invalid_credentials`); an unknown email still spends one hash. 5 failures lock the account 15 minutes (even for the right password).
- Reset and verification links are single use (1 h / 24 h), a new request cancels the old one; a reset or change revokes the other sessions. Registration, sign-in, reset and change are rate limited per client address.
- Forms are `method="post"` with the submit button disabled until the page is interactive, so a submit without scripts can never put a password in a URL or a log.

## Operating notes
- **No mail provider yet (D-08).** In development the API log prints the token (`{"mail":"email_verification"…}`); production cannot send: registration still succeeds, the failure is audited (`auth.email.mail_failed`) and the user can ask again. Do not open paid features to self-registered accounts until verification can be delivered.
- **Locked-out customer:** wait 15 minutes, or have them use "Forgot your password?" (a reset clears the lock). Support never sets or sees a password.
- **Account enumeration:** registration says when an email already exists (409) because the user needs to know; sign-in and reset never do.
- **Audit:** `auth.account.registered`, `auth.login.succeeded|failed` (reason, never the password), `auth.password.reset_requested|reset|changed|change_failed`, `auth.email.verified|mail_failed`.
- **Breach handling:** `identity.credentials.password_hash` is class `credentials`; follow `breach-handling.md` and force a reset by revoking sessions and deleting the hash rows if the table is ever exposed.

## Not done (decisions or work left)
No MFA at password sign-in for customers (users may enrol; admin realm always requires it), no "pwned passwords" check, no CAPTCHA (never automated), no change-of-email flow, no account deletion screen (DSR covers it), E2E and axe not run.
