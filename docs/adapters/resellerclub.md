# ResellerClub (LogicBoxes) domain registrar: adapter research

## 1. Header

- Vendor: ResellerClub (Reseller API on the LogicBoxes / Newfold "HTTP API" platform).
- Retrieval date: 2026-11-18.
- Status: NOT VERIFIED (no account/credentials; HG-07-01). Nothing here was exercised against a live or test endpoint.
- Source caveat (important): every `resellerclub.com` / `manage.resellerclub.com` URL returned HTTP 403 to our fetcher, including the entry page https://manage.resellerclub.com/kb/answer/751. The operation pages below were read from a white-label LogicBoxes knowledge base (`https://cp.nic.gi/kb/answer/<N>`), which uses the same article numbers as the ResellerClub KB (for example `answer/751` = API Requests index, `answer/752` = Register). Content is therefore the LogicBoxes platform documentation, not text read from resellerclub.com. Reseller-brand specifics (supported TLD set, support contacts, limits) must be re-checked on the real account. Citations below use the form `KB-N` = `https://cp.nic.gi/kb/answer/N` (official ResellerClub equivalent: `https://manage.resellerclub.com/kb/answer/N`).
- Related official pages found by search but NOT readable (403): https://manage.eu.resellerclub.com/kb/node/3188 (Access and Authentication), https://www.resellerclub.com/help/article/Register-Domain-Names-Using-the-API, https://www.resellerclub.com/developer-portal.
- Newer REST API: search results (not the pages themselves) indicate ResellerClub also advertises a separate REST API (`POST /rclub/domains`, headers `x-user-id`/`x-api-key`; another snippet suggests a sandbox host and an `Authorization` scheme). The sources disagree and the reference could not be read. NOT DOCUMENTED in what we could read; this adapter targets the legacy HTTP API only. Per the same source, hosting/email/SSL stay on the legacy API.
- Index of operations (article ids) used throughout: KB-751 (https://cp.nic.gi/kb/answer/751).

## 2. Authentication and transport

Source: KB-753 (https://cp.nic.gi/kb/answer/753), KB-744, KB-754, KB-755.

| Item | Documented |
|---|---|
| Auth params | `auth-userid` (integer, the Reseller Id) and `api-key` (string) on every request. A password variant is NOT DOCUMENTED in what we read. |
| Live base URL | `https://httpapi.com/` (KB-753). The availability check page uses a separate host `https://domaincheck.httpapi.com` (KB-764). |
| Test base URL | `https://test.httpapi.com/`, to be used with demo-reseller credentials, not live ones (KB-753). Per KB-753 the test host accepts GET for any call and returns HTTP 500 plus a message on failure. |
| Transport | HTTPS always. |
| Methods | GET for retrieval, POST for create/modify/delete; wrong method returns an error (KB-753). Doc examples place parameters in the query string even for POST calls (KB-752). |
| Encoding | Parameters are strings; URL-encode values (KB-744). Array = repeat the parameter; Map = numeric suffix starting at 1 (`attr-name1`/`attr-value1`, no gaps); values are case sensitive (KB-755). |
| Response format | Path suffix `.json` or `.xml`; JSON is the default if omitted (KB-754). Some doc pages show only `.xml` paths (premium search, DS record, transfer auth code, DNS activate): the `.json` variant for those is NOT DOCUMENTED on the page; adapter should only use paths exactly as documented or probe on the test host. |
| IP allow-listing | Required: the API is reachable only from registered IPs (KB-744). Settings > API; the white-label page says up to 3 single IPs, no ranges, 30-60 minutes to take effect, non-listed IPs get an "Access Denied" message (KB-753; limit counts may differ per brand). |
| API key rotation | Regenerating invalidates the old key immediately (KB-753). |
| Rate limits | The overview says usage is capped and higher needs require contacting the vendor, but states no numbers (KB-744). The API-abuse page (`faq682`) returned 404 on the mirror: NOT DOCUMENTED -- treat limits as unknown; adapter must apply its own conservative throttle and back-off. |
| Client idempotency key | NOT DOCUMENTED -- capability treated as unsupported (see section 3.4). |

## 3. Operations

All paths are under `/api/`; all calls also take `auth-userid` and `api-key` (omitted from tables below). Success/error envelope detail in section 4.

### 3.1 Domain availability, premium, pricing

**Availability check** (KB-764, https://cp.nic.gi/kb/answer/764)
- `GET https://domaincheck.httpapi.com/api/domains/available.json`
- Params: `domain-name` (array, required), `tlds` (array, required).
- Response: map keyed by the full name per requested TLD with `status` in `available`, `regthroughus`, `regthroughothers`, `unknown` (registry connection down; recheck later). Optional `tm-claims-key` (Trademark Clearinghouse match), `costHash` for premium names (create/renew/transfer plus currency symbol) and for Early Access Program names (`early_access_fee`, non-refundable, add to selling price).
- Limit: for Donuts TLDs at most 5 names per Donuts TLD group per call, otherwise all in that group return `unknown`.
- Sync. Error shape not described on this page.

**Premium check for one name** (KB-3053, https://cp.nic.gi/kb/answer/3053)
- `GET /api/domains/premium-check.json`; param `domain-name` (name.tld).
- Response: `premium` (bool), `costHash` (`create`, `renew`, `transfer`), `sellingCurrencySymbol`, `resellerCostPriceHash`.

**Aftermarket premium search** (KB-1948, https://cp.nic.gi/kb/answer/1948)
- `GET https://domaincheck.httpapi.com/api/domains/premium/available.xml`; params `key-word`, `tlds` (array), optional `price-high`, `price-low`, `no-of-results`. Covers secondary-market names only, not registry-premium names. Adapter: treat premium as unsupported unless explicitly enabled.

**Product availability for a domain** (KB-832, https://cp.nic.gi/kb/answer/832)
- `GET /api/products/availability.json`; params `domain-name`, `product-key`. Response: boolean `true` if the product can be offered; failure is `status: ERROR` + message.

**Reseller selling price (slabs)** (KB-865, https://cp.nic.gi/kb/answer/865)
- `GET /api/products/reseller-price.json`; optional `reseller-id`. Response: map by product type; for TLDs: product key (e.g. `domcno`) -> slab order -> `pricing` -> operation (`addnewdomain`, `renewdomain`, `addtransferdomain`, `restoredomain`) -> {years: price}. Docs recommend caching (large, slow). Currency is not stated on the page.

**Reseller cost price** (KB-1029, https://cp.nic.gi/kb/answer/1029)
- `GET /api/products/reseller-cost-price.json`; optional `reseller-id`. Response: product key -> action -> tenure(years) -> price. Cache recommended.

**Customer price** (KB-864, https://cp.nic.gi/kb/answer/864)
- `GET /api/products/customer-price.json`; optional `customer-id` (else generic customer pricing). Same nesting by product key, action, tenure.

Mapping a TLD to its `product-key` is not algorithmic: usually "dot"+tld but with exceptions (`.com` = `domcno`, `.org` = `domorg`, `.biz` = `dombiz`, `.info` = `dominfo`, `.us` = `domus`) and grouped keys (Donuts groups, CentralNicPremium) (KB-1918, https://cp.nic.gi/kb/answer/1918). The full key table is on that page.

### 3.2 TLD catalogue, per-TLD data, privacy, DNSSEC, restricted TLDs

- **Signed-up TLDs** (KB-2467, https://cp.nic.gi/kb/answer/2467): `POST /api/domains/tld-info.json` (page says POST; the request has no params besides auth). Response: map of the TLDs the reseller account is signed up for with `locking_available`, `registry`, `type` (gTLD/ccTLD), `privacy_available`, `phases` (current phase, start/end dates). This is the documented source for "which TLDs we can sell" plus privacy and lock capability. Existence of this call to be confirmed by probe.
- **Product details** (KB-833, https://cp.nic.gi/kb/answer/833): `GET /api/products/details.json`, map by product key. Whether it carries TLD minimum/maximum years, required attributes or feature flags: NOT DOCUMENTED -- capability treated as unsupported.
- **Category mapping** (KB-862): `GET /api/products/category-keys-mapping.json`; map of categories to product keys. Whether it covers TLDs: NOT DOCUMENTED.
- **Per-TLD additional data**: carried as `attr-name`/`attr-value` pairs on register/transfer/renew (examples named in the pages: `phase`, `smd`, `tnc`, `intended-use`, premium-domain type, registrant-organization consent) (KB-752, KB-758). Contact-level extras (e.g. `countryOfCitizenship` for non-EU/EEA individuals) go on add-contact (KB-790). A machine-readable list of required attributes per TLD: NOT DOCUMENTED -- capability treated as unsupported (adapter needs a hand-maintained per-TLD table, verified by probe).
- **Contact extra details call** (KB-795, https://cp.nic.gi/kb/answer/795): `POST /api/contacts/set-details.json`, deprecated; lists product keys dotasia, dotca, dotcoop, dotes, dotjobs, dotnl, dotpro, dotru, domus. New contacts must carry extras instead.
- **Privacy protection**: availability flag `privacy_available` in tld-info; `purchase-privacy` / `protect-privacy` on register/transfer/renew; "Not supported for .FR" is stated on register (KB-752).
- **DNSSEC**: DS-record add/delete exist (see 3.9); supported extensions list is NOT DOCUMENTED on those pages.
- **Restricted/eligibility TLDs such as .sa**: NOT DOCUMENTED. The product-key table page does not list the `.sa` ccTLD (the only "sa" match is `sa.com` under CentralNicPremium) and no page we read mentions .sa contacts or eligibility (KB-1918, KB-790, KB-795). Treat .sa as unsupported on ResellerClub until the account's tld-info response proves otherwise. For other restricted TLDs the docs only show generic mechanisms (attributes, extra details, registrant verification APIs listed in the index: KB-751 items "Validate Registrant" 1505, "Resend Registrant Verification" 2010; not read).

### 3.3 Customers and contacts

**Add customer** (KB-804, https://cp.nic.gi/kb/answer/804)
- `POST /api/customers/v2/signup.xml`. Required: `username` (email), `passwd`, `name`, `company`, `address-line-1`, `city`, `state` (send "Not Applicable" if none), `country` (ISO alpha-2), `zipcode`, `phone-cc`, `phone`, `lang-pref`. Optional: `other-state`, `address-line-2/3`, `alt-phone(-cc)`, `fax(-cc)`, `mobile(-cc)`, `sms-consent`, `vat-id`, `accept-policy`, `marketing-email-consent`.
- Success: new customer id (integer). Error: `status: ERROR` + message. `.json` variant of this path: NOT DOCUMENTED on the page.

**Modify customer** (KB-805): `POST /api/customers/modify.json`, requires `customer-id`, `username`, `name`, `company`, address, phone, `lang-pref`; returns `true`; error as above.

**Get/search customer**: by username `GET /api/customers/details.json` (`username`) (KB-874); search `GET /api/customers/search.json` with `no-of-records` (10-500), `page-no`, filters `customer-id`, `username`, `name`, `company`, `status`, date ranges; returns `recsonpage`, `recsindb` and per-customer rows (KB-1270).

**Add contact** (KB-790, https://cp.nic.gi/kb/answer/790)
- `POST /api/contacts/add.json`. Required: `name` (<=255), `company` (<=255; "N/A" for individuals), `email`, `address-line-1` (<=64), `city`, `state`, `country` (alpha-2), `zipcode` (<=10, validated per country), `phone-cc` (1-3 digits), `phone` (4-12 digits), `customer-id`, `type` ("Contact"). Optional: `address-line-2/3`, `fax-cc`, `fax`, `attr-name`/`attr-value`.
- Success: contact id (integer). Failure: `status: ERROR`, `message` describing one or several invalid fields.

**Modify contact** (KB-791, https://cp.nic.gi/kb/answer/791)
- `POST /api/contacts/modify.json`, but marked deprecated since 2016-12-01 (IRTP): existing contacts can no longer be modified; create a new contact and attach it to the domain. Adapter must not rely on modify. Contacts on suspended domains cannot change; unused non-default contacts older than six months are archived.

**Search contacts** (KB-793): `GET /api/contacts/search.json` (customer id, paging, filters); response includes validity flags per contact.

### 3.4 Register domain (and find-by-reference)

Source: KB-752 (https://cp.nic.gi/kb/answer/752).
- `POST /api/domains/register.json` (page example shows `.xml`).
- Required: `domain-name` (Unicode or Punycode), `years`, `ns` (array), `customer-id`, `reg-contact-id`, `admin-contact-id` (-1 for TLDs without it), `tech-contact-id`, `billing-contact-id`, `invoice-option`, `auto-renew`. Optional: `purchase-privacy`, `protect-privacy`, `attr-name`/`attr-value`, `discount-amount`, `purchase-premium-dns`.
- `invoice-option`: `NoInvoice` (executes, no invoice), `PayInvoice` (paid from debit account if funds suffice, else order stays pending), `KeepInvoice` (invoice for later, order executes), `OnlyAdd` (invoice for later, action pending).
- Response fields: `description` (domain name), `entityid` (order id), `actiontype`, `actiontypedesc`, `eaqid` (action id), `actionstatus`, `actionstatusdesc`; unless `NoInvoice`: `invoiceid`, `sellingcurrencysymbol`, `sellingamount`, `unutilisedsellingamount`, `customerid`; `discount-amount`; `privacydetails` (same style fields) when privacy purchased.
- Async: yes in principle; the response is an action (`eaqid`, `actionstatus`) and pending states exist (PayInvoice without funds, OnlyAdd). Final-state value list for `actionstatus` is NOT DOCUMENTED on the pages read.
- Client reference / idempotency key: NOT DOCUMENTED -- capability treated as unsupported. No parameter on register accepts a caller-supplied token.
- Find-by-name after a timeout (reconcile before retry): use the lookups below, keyed by domain name or customer id (the only natural keys):
  - `GET /api/domains/orderid.json` with `domain-name` returns the order id as an integer (KB-763, https://cp.nic.gi/kb/answer/763).
  - `GET /api/domains/details-by-name.json` with `domain-name` and `options` (KB-1755, https://cp.nic.gi/kb/answer/1755).
  - `GET /api/domains/search.json` with `domain-name`, `customer-id`, `order-id`, `status`, `creation-date-start/end` (UNIX seconds), required `no-of-records` (10-500) and `page-no` (KB-771, https://cp.nic.gi/kb/answer/771).
  - `GET /api/actions/search-current.json` filtered by `order-id`, `eaq-id`, `action-status`, `action-type` (KB-908) for in-flight actions.
  - Recommended token approach (assumption, not vendor-supported): the adapter keeps its own idempotency record keyed by Nuzm operation id and uses domain name as the vendor-side natural key. Domain names are unique across the registry, so existence of an order for that name under our `customer-id` is the reconciliation signal. Not documented whether lookups are strongly consistent immediately after the register call.

### 3.5 Search / get domain details

- By order id (KB-770, https://cp.nic.gi/kb/answer/770): `GET /api/domains/details.json`, params `order-id`, `options` (array, required; values `All`, `OrderDetails`, `ContactIds`, `RegistrantContactDetails`, `AdminContactDetails`, `TechContactDetails`, `BillingContactDetails`, `NsDetails`, `DomainStatus`, `DNSSECDetails`, `StatusDetails`).
- By name (KB-1755): `GET /api/domains/details-by-name.json`, params `domain-name`, `options` (same values).
- Fields returned (names as documented, subset needed): `orderid`, `entityid`, `domainname`, `currentstatus`, `orderstatus` (registry locks), `domainstatus` (system locks), `productkey`, `creationtime`, `endtime`, `customerid`, `recurring` (auto-renew), `allowdeletion`, `isOrderSuspendedUponExpiry`, `noOfNameServers`, `ns1`, `ns2`, `cns`, `domsecret` (transfer secret), `isprivacyprotected`, `privacyprotectedallowed`, `privacyprotectendtime`, `registrantcontactid`, `admincontactid`, `techcontactid`, `billingcontactid`, `dnssec` (`keytag`, `algorithm`, `digesttype`, `digest`), `gdpr`, `raaVerificationStatus`.
- Search (KB-771): response rows include domain name, order id, customer id, added/creation/modified/expiry timestamps, current status, product name and key, reseller/customer/transfer lock statuses, privacy status. Status filter values: `InActive`, `Active`, `Suspended`, `Pending Delete Restorable`, `Deleted`, `Archived`, `Pending Verification`, `Failed Verification`.
- Sync (GET).

### 3.6 Renew

Source: KB-746 (https://cp.nic.gi/kb/answer/746).
- `POST /api/domains/renew.json`; required `order-id`, `years`, `exp-date` (epoch of the current expiry), `auto-renew`, `invoice-option`; optional `purchase-privacy`, `discount-amount`, `purchase-premium-dns`; premium renewals need extra `attr-name`/`attr-value`.
- Response: `description`, `entityid`, `actiontype`, `actiontypedesc`, `eaqid`, `actionstatus`, `actionstatusdesc`, plus invoice fields unless `NoInvoice`, `privacydetails` when privacy purchased.
- Async per action id. The required `exp-date` provides a natural guard: retrying a renew with the old `exp-date` after the expiry moved is a documented-parameter mismatch (behaviour on mismatch NOT DOCUMENTED). Reconcile with details/search `endtime` before retry.
- Client idempotency key: NOT DOCUMENTED -- unsupported.

### 3.7 Transfer-in

- **Validate** (KB-1150, https://cp.nic.gi/kb/answer/1150): `GET /api/domains/validate-transfer.json`, param `domain-name`; returns string `true`/`false`.
- **Initiate** (KB-758, https://cp.nic.gi/kb/answer/758): `POST /api/domains/transfer.json`; required `domain-name` (must be unlocked), `customer-id`, the four contact ids (-1 where TLD lacks the type), `invoice-option`, `auto-renew`; optional `auth-code` (some TLDs require it up front; otherwise the admin contact can approve through the registry email), `purchase-privacy`, `protect-privacy`, `ns` (up to 13), `attr-name`/`attr-value`, `purchase-premium-dns`. Response is the same action-style map as register. Doc notes the response can carry a status of "NoError" while waiting for user or registry input, which is not a failure.
- **Submit auth code later** (KB-2447, https://cp.nic.gi/kb/answer/2447): `POST /api/domains/transfer/submit-auth-code.xml`; `order-id`, `auth-code`; success returns a success string.
- **Transfer status**: no dedicated "transfer status" call was found in the index; poll via details (`currentstatus`/`orderstatus`) or actions search (`/api/actions/search-current.json`, archived variant KB-909). Final status values: NOT DOCUMENTED on pages read. Also indexed but not read: cancel transfer (KB-759), resend approval mail (KB-775), IRTP status (KB-2804).
- Async: yes, explicitly (waits on admin approval, registry, or payment).

### 3.8 Nameservers, lock, auto-renew, privacy, auth code

All POST, all return the action-style map (domain name, `entityid`/order id, `actiontype`, `actiontypedesc`, `eaqid`, `actionstatus`, `actionstatusdesc`); errors `status: ERROR` + message. Several accept optional `otp` and `2fa-type` (only `email` listed).
- **Modify NS** (KB-776): `/api/domains/modify-ns.json`; `order-id`, `ns` (array).
- **Child NS** add/modify/delete: indexed (KB-780, 781, 782, 934), not read -- NOT DOCUMENTED here.
- **Lock** (KB-902, KB-903): `/api/domains/enable-theft-protection.json` and `/api/domains/disable-theft-protection.json`; `order-id`. Current state visible via `orderstatus` / search lock-status fields.
- **Auto-renew**: no standalone modify call appears in the index. `auto-renew` is a parameter of register, renew and transfer; the current value is read as `recurring` in details. Standalone toggle: NOT DOCUMENTED -- capability treated as unsupported (workaround would be to rely on parameters at register/renew only).
- **Privacy on/off** (KB-778, https://cp.nic.gi/kb/answer/778): `/api/domains/modify-privacy-protection.json`; `order-id`, `protect-privacy` (bool), `reason` (required string); response adds `invoiceid`, currency symbol, amount (a zero-value invoice is still created).
- **Privacy purchase/renew** (KB-2085): `/api/domains/purchase-privacy.json`; `order-id`, `invoice-option`, optional `discount-amount`.
- **Auth code / EPP**: set a new code with `POST /api/domains/modify-auth-code.json` (`order-id`, `auth-code`; KB-779). The current code is exposed as `domsecret` in details responses (KB-770). A dedicated "retrieve" call is NOT DOCUMENTED; `domsecret` availability per TLD/status is not stated.
- **Delete** (KB-745): `POST /api/domains/delete.json`, `order-id`; returns `eaqid`, `actionstatus`; success only means accepted, check later via actions.

### 3.9 DNS (managed DNS) and DNSSEC

- Prerequisite: activate DNS service per order, `POST /api/dns/activate.xml`, `order-id` (KB-830). Whether it is per domain order only: yes per `order-id`.
- Record calls (KB-1091 index, https://cp.nic.gi/kb/answer/1091): add A/AAAA/CNAME/MX/NS/TXT/SRV; modify the same plus SOA; search; delete per type (a generic delete is marked deprecated).
- Add A (KB-1093): `POST /api/dns/manage/add-ipv4-record.json`; `domain-name`, `value`, optional `host`, `ttl` (default 14400); success status "Success", failure has an `error` key.
- Modify A (KB-1098): `POST /api/dns/manage/update-ipv4-record.json`; `domain-name`, `current-value`, `new-value`, optional `host`, `ttl`.
- Delete A (KB-1171): `POST /api/dns/manage/delete-ipv4-record.json`; `domain-name`, `value`, optional `host`; success also when the record never existed (idempotent delete).
- Add TXT (KB-1097): `POST /api/dns/manage/add-txt-record.json`; `domain-name`, `value`, optional `host`, `ttl`.
- Search (KB-1106): `GET /api/dns/manage/search-records.json`; `domain-name`, `type`, `no-of-records`, `page-no`, optional `host`, `value`.
- Other type-specific paths (AAAA, CNAME, MX, NS, SRV): indexed (KB-1092, 1094..1105, 1174..1180) but not read; the pattern `add|update|delete-<type>-record.json` is NOT confirmed here, so adapter must read each page before use.
- Batch/atomic changes across records or a "replace zone" call: NOT DOCUMENTED -- capability treated as unsupported. Operations are one record per call, so a multi-record change is not atomic; adapter must implement compensation/reconciliation itself using search.
- Record-level idempotency: adds are not documented as idempotent (duplicate behaviour NOT DOCUMENTED); deletes are.
- Operation scope note: these DNS calls are keyed by `domain-name`, with no `customer-id`/`order-id` on record calls on the pages read.
- **DNSSEC**: `POST /api/domains/add-dnssec.xml` and `/api/domains/del-dnssec.xml` (KB-1910, KB-1911): `order-id` plus attr pairs `keytag` (integer), `algorithm` (0-255), `digesttype` (1, 2 or 3 for .com/.net; 1 or 2 otherwise), `digest` (hex, 40 chars for type 1, 64 for types 2 and 3). Action-style response. Zone signing by the DNS service itself: NOT DOCUMENTED (only DS records at the registry).

### 3.10 Webhooks / notifications

NOT DOCUMENTED -- capability treated as unsupported. No push/webhook or signature scheme appears in the API index (KB-751) or the overview pages read (KB-744, KB-753); a web search for ResellerClub webhooks returned no vendor page. Use polling: actions search (KB-908), details, and domain search.

### 3.11 Reseller billing and cost reconciliation

- **Reseller transactions search** (KB-2758, https://cp.nic.gi/kb/answer/2758): `GET /api/billing/my-transactions/search.json`; required `no-of-records`, `page-no`; optional filters `transaction-type` (credit, debit, invoice, receipt), `transaction-key` (manually/systemgenerated), `transaction-id`, `balance-type`, `transaction-description`, `amt-range-start/end`, `transaction-date-start/end` (UNIX), `order-by`. Rows: `transid`, `transactiondate`, `key`, `type`, `description`, `greedy`, `sellingcurrencysymbol`, `sellingamount`, `unutilisedsellingamount`, `parentkey`.
- **Customer transaction details** (KB-868): `GET /api/billing/customer-transactions.json`, `transaction-ids` array; includes `orderid`, amounts in selling and accounting currency, tax, FX difference. Sub-reseller variant `reseller-transactions.json` (KB-1155).
- **Balances**: customer `GET /api/billing/customer-balance.json` (`customer-id`; `sellingcurrencybalance`, `sellingcurrencylockedbalance`, `totalsellingbalance`, accounting equivalents; KB-872); sub-reseller `GET /api/billing/reseller-balance.json` (`reseller-id`; KB-1110). The reseller's own (parent) balance call: NOT DOCUMENTED in pages read.
- Statement/ledger export: the index lists no statement or ledger call (KB-867 summary). Reconcile by matching `transid`/`orderid` plus `sellingamount` against our expected cost from the cost-price API (3.1). Amount type in docs is Float/decimal; adapter must convert to integer minor units itself, and the selling vs accounting currency distinction needs a probe.

## 4. Error model

- Envelope: failures return a map with `status: "ERROR"` (one page writes "Error") and a `message` describing the problem; contact validation may list several problems in one message (KB-790). DNS record pages instead describe an `error` key (KB-1093, KB-1171) and `status: Success` on success. Adapter must accept both `message` and `error`.
- Numeric error codes: NOT DOCUMENTED on any page read -- do not branch on codes.
- HTTP statuses: the only documented one is HTTP 500 plus a message on the test host for failures (KB-753). Production status-code behaviour: NOT DOCUMENTED; the adapter must treat the JSON body as the source of truth and not assume 4xx.
- Auth failure / disallowed IP: "Access Denied" message for a non-allow-listed IP (KB-753). Wrong credentials message: NOT DOCUMENTED.
- Validation: `status: ERROR` + descriptive message (e.g. contact fields, "Please accept the Terms & Conditions" on transfer, KB-758). No stable code list.
- Domain unavailable/taken: availability returns `regthroughus` / `regthroughothers` / `unknown` rather than an error (KB-764). Message text from register when the name is taken: NOT DOCUMENTED.
- Insufficient funds: not an error on the documented path; with `invoice-option=PayInvoice` the order stays pending (register, renew, transfer pages). Dedicated message: NOT DOCUMENTED.
- Rate limit: NOT DOCUMENTED (only that usage is capped, KB-744).
- Outage / registry unavailable: availability returns `unknown`, retry later (KB-764). Other outage behaviour: NOT DOCUMENTED; after any timeout or 5xx treat result as uncertain and reconcile (3.4) before retry.
- Success is not completion: register/renew/transfer/delete return an action (`eaqid`, `actionstatus`); delete page states success only means accepted (KB-745).

## 5. Gaps and assumptions

1. Primary-source gap: resellerclub.com pages were not fetchable (HTTP 403); operations were read from a white-label LogicBoxes KB using the same article ids. Re-verify every path and parameter against the real account docs and with the test host before enabling. Status stays NOT VERIFIED.
2. Auth by password instead of `api-key`: NOT DOCUMENTED on pages read.
3. REST API (`/rclub/domains`) and its auth: only seen in search snippets that disagree; unsupported by this adapter.
4. Production base URL for the availability host and the full path set on `httpapi.com` vs `domaincheck.httpapi.com`: only the availability and premium-search calls name `domaincheck.httpapi.com`; others show only the test host in examples. Assume `https://httpapi.com` per KB-753.
5. `.json` forms of calls whose pages show `.xml` only (customer signup, premium search, DNS activate, DNSSEC, submit-auth-code): NOT DOCUMENTED. Probe on test host.
6. Client reference / idempotency key on register, renew, transfer, DNS: NOT DOCUMENTED -- unsupported. Reconcile by domain name, `customer-id`, order id, and actions search.
7. Value set and terminal states of `actionstatus`, and polling guidance: NOT DOCUMENTED on pages read.
8. Machine-readable per-TLD required attributes, min/max years, DNSSEC support, restrictions: NOT DOCUMENTED (details/category-mapping pages silent). `.sa` is not in the product-key table and is not mentioned anywhere: unsupported until tld-info says otherwise.
9. Standalone auto-renew toggle, dedicated auth-code retrieval call: NOT DOCUMENTED. `domsecret` in details may expose the code.
10. Atomic/batch DNS: NOT DOCUMENTED -- unsupported. Only per-record calls were read; AAAA/CNAME/MX/NS/SRV/SOA exact paths not read.
11. Webhooks/push events and any signature scheme: NOT DOCUMENTED -- polling only.
12. Rate-limit numbers, HTTP status mapping, stable error codes and message text for taken domain / insufficient funds / auth failure: NOT DOCUMENTED.
13. Billing: no statement or ledger-export API found; reseller-own balance endpoint not documented on pages read; currency/decimal precision of `sellingamount` and relation to cost-price API need a probe. All money in Nuzm must be converted to integer minor units with currency.
14. Contacts: modify is deprecated; plan for create-new-contact-and-attach. Contact modification on an existing domain order (KB-777 "Contacts" under Modify) was indexed but not read.
15. Idempotent read-after-write: not stated whether `orderid.json`/details return the new order immediately after a timed-out register call; adapter must retry reads with back-off before concluding "not created".
16. Test environment fidelity: test host behaviour (GET for everything, HTTP 500 errors) differs from production; contract tests must not assume it matches production.
