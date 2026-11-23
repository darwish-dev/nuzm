# Dynadot registrar adapter (`providerCode: dynadot`)

Status: **NOT VERIFIED.** Built only from Dynadot's published documentation; no Dynadot account, key or sandbox has been used by the platform (HG-07-01 equivalent: the owner supplies a sandbox key and runs the connection test).

## Source

| Page | Read | Used for |
|---|---|---|
| https://www.dynadot.com/domain/api | 2026-11-24 | two API generations exist (RESTful, Legacy); keys come from the account's API settings |
| https://www.dynadot.com/domain/api-document | 2026-11-24 | RESTful API conventions: `https://api.dynadot.com` / `https://api-sandbox.dynadot.com`, `Authorization: Bearer <key>`, `X-Signature` (HMAC-SHA256 with the API secret) for transactional requests, rate limits 60 / 600 / 6000 per minute by price level, sandbox pre-funded, "Beta". **The per-command reference of this API is not in the page text we could read** (only two example paths), so no REST command is used |
| https://www.dynadot.com/domain/api-commands (the page's command data file) | 2026-11-24 | the Legacy API (`/api3.json`): every command, parameter and example response used below. The page states: "Legacy API, Scheduled for Retirement. Please use our RESTful API instead" |

## Decision recorded (DYN-1, open)

The adapter speaks the **Legacy API** because it is the only one whose commands we can read in full. It is scheduled for retirement by Dynadot. The transport is one private method (`call()` in `packages/adapters/dynadot/src/adapter.ts`), so a RESTful implementation can replace it once its command reference is supplied, without touching the contract methods. Until then: every result is NOT VERIFIED, and a retirement date from Dynadot should be treated as a deadline.

## Operations used

| Adapter method | Legacy command(s) | Notes |
|---|---|---|
| `probe`, `health` | `get_account_balance`, `tld_price`, `search` | read-only; register/renew/transfer/nameservers/lock/privacy/auth-code/find-by-token are derived from authenticated reads (a mutation cannot be proven without a side effect) |
| `supportedTlds`, `catalog` | `tld_price` (500 per page) | prices per year in the account currency → integer minor units, never floats; a TLD with `Restrictions` other than `--` is `restricted` |
| `search` | `search` with `show_price=1`, `currency` | one domain per call unless the account is bulk (`searchBatch`, 1..100); a premium name gets no price (not offered) |
| `register` | `create_contact` ×1..4, `register`, then `set_ns`, `set_privacy`, `set_renew_option` | the registration stands if a follow-up setting is refused; the next `inspect` shows the real state |
| `transferIn` | `create_contact`, `transfer` (`auth`, `privacy`, `name_servers`) | auth code read from the vault, never returned or logged |
| `renew` | `renew` (`duration`, `year`) | double-renew guard on the expiry |
| `inspect`, `findByToken` | `domain_info`, `get_ns` | **no client token exists**: the domain name under our account is the key |
| `setNameservers` | `add_ns` (each host, "already exists" tolerated), `set_ns` | `set_ns` only accepts name servers already in the account |
| `setLock` | `lock_domain` / `unlock_domain` | |
| `setAutoRenew` | `set_renew_option` (`auto` / `donot`) | |
| `authCode` | `get_transfer_auth_code` | documented precondition: the domain must be unlocked first |

## Capabilities that stay `unsupported`

`registrar.dns` (`set_dns2` replaces a zone wholesale and offers a handful of record types: Nuzm operates DNS itself), `registrar.contacts` (re-pointing a domain's contacts, `set_whois`, was not read in full), `registrar.webhooks` (the Legacy API has none; the RESTful API documents outbound webhooks signed with a webhook key), `registrar.billing-export`, `registrar.eligibility`.

## Not documented (so assumed, and marked)

- Error codes and messages: classification is by message text (`classifyMessage`) and is itself an assumption.
- How a domain that is not in the account is reported by `domain_info`: only a "not found"-looking message is read as provable absence (`findByToken` → `succeeded` with no data); anything else stays `uncertain`.
- The shape of a one-domain `search` answer (flat or list) and of `get_ns` on a parked domain: both are read defensively.
- Whether the key travels only as a query parameter: the documented examples are GET requests with `key=`, so the adapter uses them over https; evidence stores the command name only, never the URL.

## Credentials and configuration

Vault fields: `apiKey` (required), `apiSecret` (optional, only the RESTful API needs it). Typed in the admin console (Domains → Registrars → Dynadot) they go to the sealed secret store (non-production profiles; production needs the vault decision D-12) and only the `vault://` reference is kept. Non-secret settings: `environment` (sandbox / production), `timeoutMs`, `searchBatch`, `dataRegion` (default `US`: confirm against Dynadot's data processing terms), `currency`.

## Verification state

Mock only: `pnpm --filter @nuzm/adapter-dynadot test` runs the shared registrar conformance kit (R01-R14, R18) against a local mock shaped from the documentation, plus adapter-specific cases. R15-R17 are skipped (no DNS, webhooks or billing export). `domains-dynadot.int.spec.ts` drives the admin console path against the same mock. **Nothing here is LIVE-VERIFIED.**
