# DNet (dnet.sa) domain registrar: adapter research

## 1. Header

- Vendor: DNet, https://dnet.sa (Saudi and global domain registration, business email, hosting solutions).
- Retrieval date: 2026-11-21.
- Status: **NOT VERIFIED / BLOCKED (HG-07-03, D-50).** No DNet API documentation is in the repository, and none could be read.
- Source caveat: a web search lists a "API for reseller" entry in the dnet.sa site menu, so a reseller API may exist. The search result carried no content from that page. A direct fetch of `https://dnet.sa/`, `/PagesDetails/6` and `/solutions/1` returned HTTP 403 to our fetcher. Whether the documentation is public, gated behind a reseller account, or only available on request is **NOT DOCUMENTED** in anything we could read.
- Consequence (CLAUDE.md §4/§5): nothing below is an API fact. No endpoint, header, payload, error code, price, rate limit or webhook behaviour has been assumed. The adapter is **not written**; writing one against guesses would break "never invent API methods".

## 2. What we need from the owner (HG-07-03)

Written DNet documents (PDF/HTML/OpenAPI), stored in `docs/adapters/dnet-source/` with their retrieval date, covering each row of the matrix in section 3. Plus a reseller account with **sandbox/test** credentials (never production credentials in the repo, CLAUDE.md §5). Credentials go to the non-production vault only.

## 3. Capability matrix (to be filled from the documentation; every cell is `unknown` = unsupported until then)

Our capability ids are in `packages/adapters/registrar-contracts/src/capabilities.ts`. The brief's operation list maps onto them as follows.

| Brief operation | Registrar capability id / adapter method | Documented by DNet? | State |
|---|---|---|---|
| `checkAvailability()` | `registrar.search` / `search()` | not read | unknown |
| `getRegistrationPricing()` / `getRenewalPricing()` / `getTransferPricing()` | `TldSupport.prices` from `supportedTlds()`; `AvailabilityResult.*Price` | not read | unknown |
| `getDomainRequirements()` | `registrar.eligibility` / `eligibility()` + `TldSupport.requiredContactFields` | not read | unknown |
| `registerDomain()` | `registrar.register` / `register()` | not read | unknown |
| `getDomainStatus()` / `getExpirationDate()` | `inspect()` (`DomainRef.state`, `expiresAt`) | not read | unknown |
| `renewDomain()` | `registrar.renew` / `renew()` | not read | unknown |
| `transferDomain()` / `getTransferStatus()` | `registrar.transfer-in` / `transferIn()`, `inspect()` | not read | unknown |
| `updateNameservers()` / `getNameservers()` | `registrar.nameservers` / `setNameservers()`, `inspect()` | not read | unknown |
| DNS record CRUD | `registrar.dns` / `dns` capability | not read | unknown (default: Nuzm-operated DNS, D-36) |
| `updateContactInformation()` | `registrar.contacts` / `setContacts()` | not read | unknown |
| (needed) idempotent lookup after a timeout | `registrar.find-by-token` / `findByToken()` | not read | unknown; without it, ambiguous outcomes stay `uncertain` and are reconciled by a human or a documented lookup, never retried |
| (needed) webhooks and signature | `registrar.webhooks` / `parseWebhook()` | not read | unknown |
| (needed) cost export for margin | `registrar.billing-export` / `fetchBilling()` | not read | unknown |
| Authentication scheme, base URL, sandbox host | `AccountContext`, vault reference | not read | unknown |
| Rate limits, IP allow-listing | adapter throttle | not read | unknown |
| Supported `.sa` suffixes and per-suffix eligibility/document rules | `TldSupport`, `spec/providers/tld-policy.yaml` | not read | unknown |

The suffix list in the brief (`.sa`, `.com.sa`, `.net.sa`, `.org.sa`, `.edu.sa`, `.gov.sa`) is the platform's `always_restricted_suffixes` list; it is a hypothesis about DNet's catalogue, not a finding.

## 4. Questions the documentation must answer

1. Authentication (key, secret, reseller id, token, signature?) and the sandbox/test base URL; is the API IP-allow-listed?
2. Is there a read-only call safe for "Test connection"? If not, the admin UI says connectivity cannot be verified.
3. Does registration complete synchronously, or is there an asynchronous order with review (documents, SaudiNIC approval)? How does an order status map to `pending/active/failed`?
4. How are identity/commercial-registration documents submitted (API upload, portal, email)? Retention and deletion terms?
5. Is there a client idempotency key, or a lookup by our order reference (needed for `findByToken`)?
6. Prices: currency, VAT-inclusive or not, per-year slabs, renewal and restore prices.
7. Is authoritative DNS hosted by DNet? Record types supported (A, AAAA, CNAME, MX, TXT, SRV, CAA)? Atomic change sets?
8. Transfer-in rules for `.sa` (not assumed to be EPP auth-code based).
9. Webhooks: events, signature, replay window.
10. Rate limits and error codes (to normalise into the platform error registry).

## 5. Planned adapter shape (after the documentation arrives)

New package `packages/adapters/dnet` (`@nuzm/adapter-dnet`) beside `openprovider` and `resellerclub`, implementing `RegistrarAdapter` with `providerCode: 'dnet'`, a mock server for CI (evidence labelled `mock`, never LIVE-VERIFIED), the shared conformance kit in `packages/adapters/registrar-conformance`, and a factory entry in `apps/api/src/modules/domains/internal/factories.ts`. Egress is limited to the documented DNet hosts through `FetchHttpClient`.

## 6. Live verification

None done. Every row stays `NOT VERIFIED` until a sandbox run with owner-supplied credentials produces `live` evidence (CLAUDE.md §5).

## 7. Admin settings page (added 2026-11-21, owner request)

Admin → Domains → Registrars → **DNet settings** (`/domains/registrars/dnet`, `PUT /v1/admin/registrars/dnet`, needs `admin:domains:manage` and a recent MFA check).

- Stores the non-secret settings in `domains.registrar_accounts.settings` (migration `1900`, in the M07-INT range above every applied migration because the runner is forward-only): label, environment, base URL (https only), reseller id, timeout. The `dnet` registrar row is seeded **disabled**.
- Credentials (API key, optional secret) are **write-only**. Outside production they are typed into the form and kept in the sealed secret store (dev profile, D-12); only the `vault://` reference is stored. In production only a `vaultRef` is accepted.
- Any save disables the account and clears its probe. The page says "Not connected" and has no test button: there is no DNet adapter yet, so a verification answers `unsupported_capability`.
- The field names are generic on purpose. When DNet's documentation arrives, the exact authentication fields, the egress host allow-list and the read-only "test connection" call are added with the adapter. The domains module's vault client is still the refusing `UnavailableVault` (D-12), so the adapter will also need the sealed store wired in for non-production runs.

## 8. What the public reseller page says (read 2026-11-21)

Source: https://dnet.sa/resellersolutions ("API للموزعين"), opened in a browser (the automated fetcher gets HTTP 403 on dnet.sa).

- It is a marketing page, not documentation. It says DNet offers a "RESTful Reseller API" for domain registration and management and DNS services, with real-time availability checks, management services for your customers, and prices you set yourself.
- Access is by a contact form ("Get Started"): the DNet team replies to discuss the API. Contact shown: phone 920033202, support@dnet.sa.
- It does **not** state: documentation or Swagger/Postman links, base URL, authentication, endpoints, sandbox, webhooks, pricing, deposits, supported `.sa` suffixes, document/eligibility rules, or transfer rules. All matrix cells in section 3 therefore stay `unknown`; HG-07-03 stays open until DNet answers.

