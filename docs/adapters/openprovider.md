# Openprovider REST API: adapter reference

- Vendor: Openprovider (domain registrar / reseller platform).
- Retrieval date: 2026-11-18.
- Status: NOT VERIFIED (no account/credentials; HG-07-01). Nothing here was exercised against a live or sandbox API. Every statement is paraphrased from the vendor pages below.
- Rule for readers: anything marked "NOT DOCUMENTED — capability treated as unsupported" must not be assumed by the adapter.

## Sources (the "Spec" label below means the Swagger file)

| Label | URL |
|---|---|
| Notice | https://docs.openprovider.com/ (only a move notice; points to developer portal; says `/v1beta` is retired 30 June 2027, new work should use `/v1`) |
| Portal | https://developer.openprovider.com/rest-api-documentation.html |
| Get-started | https://developer.openprovider.com/get-started.html |
| Spec | https://developer.openprovider.com/data/swagger.json (Swagger 2.0, host `api.openprovider.eu`, title "REST API", version "1.0.0-beta"; paths are written with a `/v1` prefix; includes prose quickstarts) |
| Help | https://openprovider.help/books/api-integrations (support knowledge base; old `support.openprovider.eu` links 301 here) |
| Errors | https://openprovider.help/books/api-integrations/page/api-error-codes |
| Limits | https://openprovider.help/books/api-integrations/page/what-are-openprovider-api-calls-limits |
| Sandbox | https://openprovider.help/books/api-integrations/page/sandbox-testing-environment |
| Webhooks | https://openprovider.help/books/api-integrations/page/webhook-notification-system |
| Token TTL | https://openprovider.help/books/api-integrations/page/how-long-api-bearer-auth-token-is-valid-for |
| .sa page | https://openprovider.help/books/domains/page/sa |

Caveat: the Spec file is about 730 KB; it was read in slices through a summarising fetch tool, so field lists are from that reading and should be re-checked against the raw file when the adapter is built. Several Help pages contain self-acknowledged example typos (trailing commas, `name` vs nested `domain` object); the Spec shapes below are preferred.

## 1. Auth

Source: Get-started, Help "Getting started", Spec.

- Login: `POST https://api.openprovider.eu/v1/auth/login` (the same path exists under `/v1beta`).
- Request body: `{"username": "<rcp user>", "password": "<secret>", "ip": "0.0.0.0"}`. The Spec describes `ip` as the caller IP, with `0.0.0.0` meaning any IP. The username is the Reseller Control Panel (RCP) username of the contact person.
- Response: `{"code": 0, "desc": "", "data": {"token": "<string>", "reseller_id": <int>}, "maintenance": false, "warnings": []}`.
- Usage: header `Authorization: Bearer <token>` on every call. Bearer is the only supported scheme.
- Token lifetime: 2 days / 48 hours from issue (Token TTL page, Get-started help). Whether activity extends it: NOT DOCUMENTED — capability treated as unsupported; refresh on expiry or on auth error 196.
- Prerequisite: API access is off by default and is enabled per contact person in RCP (Account overview, Contact persons, API tab). Some domain operations need registry contracts signed (Get-started).
- Base URLs:
  - Production: `https://api.openprovider.eu/v1` (Portal, Get-started). `https://api.openprovider.eu/v1beta/` is the older base, to be switched off 30 June 2027 (Notice).
  - Sandbox (replaces the retired CTE): REST base `https://api.sandbox.openprovider.nl/v1beta/`; control panel and sign-up `https://cp.sandbox.openprovider.nl/signup` (Sandbox). A `/v1` sandbox base: NOT DOCUMENTED — capability treated as unsupported (only `/v1beta` is shown for the sandbox REST API). Sandbox credentials are separate from production.
  - Sandbox limits (Sandbox): domain transfers are not supported; not every TLD is available (depends on whether the registry has a test environment). Whether registry operations are simulated: NOT DOCUMENTED.
- IP allow-list: no mandatory API IP allow-list is stated. The login `ip` field exists. An older doc (not re-fetched) says per-contact IP restriction exists in RCP; the Spec has `api_client_ip_list` and `rcp_client_ip_list` (type `contactClientIpList`) on `PUT /contacts/{id}`. Error 10005 means the caller IP is blocked by a whitelist/blacklist (Errors). Treat IP restrictions as an account-level setting to check at onboarding.
- Rate limits (Limits page, all figures from its table):
  - Identical calls with valid credentials (excluding the four listed below): 300 per 300 s, then "10005 Access denied" until removed manually.
  - Identical `checkDomainRequest`: 20 per 300 s, block 300 s ("Calls limit has been reached"). For eu, uk, co.uk, org.uk, me.uk, it, ch, fi, fr and xn--e1a4c the limit is 60 per 60 s, block 60 s.
  - Identical `createDomainRequest`: 15 per 300 s, error 4007, block 300 s.
  - Failed logins: 100 per 3600 s, block 20 minutes.
  - Token generation (`generateTokenAuthRequest`, REST login): 30 per 60 s, block 1 minute.
  - Invalid operations on .eu: 10 errors per 1200 s, block until Openprovider Support removes it.
  - Limits cannot be raised and IPs cannot be whitelisted (Limits page statement per search summary). Per-endpoint request/second quotas, `Retry-After` or rate-limit headers: NOT DOCUMENTED.

## 2. Common response envelope

Source: Spec (`errorError`, `errorWarning`, every `*Response` schema).

- Every response is `{"code": <int32>, "data": <object|array>, "desc": "<string>", "maintenance": <bool>, "warnings": [{"code","data","desc"}]}`. `code` 0 means success.
- Documented default (error) response schema for every operation: `errorError` with `code` (int32), `desc` (string), `data` (string, extra description).
- Pagination convention on list endpoints: query `limit`, `offset`; response `data.results[]` and `data.total`.

## 3. Operations

Unless stated, all paths are relative to the base URL in section 1 and use the Bearer header. "Async" means the response may report a non-final status that needs later polling.

Idempotency / client token (applies to all operations): NOT DOCUMENTED — capability treated as unsupported. No `Idempotency-Key` header, client token or request-id field appears anywhere in the Spec. Documented duplicate guards are only rate-style: error 4007 for repeated identical `createDomainRequest` (block 300 s) and error 342 for a domain renewed again within 10 seconds (Errors page). Do not rely on these for deduplication.

### 3.1 Check availability and price

Source: Spec `POST /v1/domains/check`; Help "Domains API: Check Domain" (https://openprovider.help/books/api-integrations/page/2-domains-api-check-domain).

- `POST /domains/check`
- Request: `{"domains": [{"name": "example", "extension": "com"}], "with_price": true, "with_whois": false}`. Optional `additional_data.idn_script`, `application_mode`, `provider`.
- Bulk: yes, array of domains. Max per call: error 701 states more than 15 domains in one `checkDomainRequest` is rejected (Errors page); the Check page itself gives no maximum.
- Response `data.results[]`: `domain` (full name), `status`, `reason`, `is_premium`, `premium` {`currency`, `price.create`, plus per the Help page `price.renew`, `restore`, `transfer`}, `price` {`product`:{currency,price}, `reseller`:{currency,price}}, `claim_key`, `whois`.
- `status` values: Spec says "free" or "active"; the Spec quickstart example also shows "reserved" and "in use". The complete list: NOT DOCUMENTED. Adapter rule: only `free` means available; any other or unknown value means unavailable/unknown.
- Premium: `is_premium` true plus `premium.price.create`; registering requires `accept_premium_fee` (see 3.4).
- Sync. Pricing adds query time (Spec quickstart).
- Price lookup: `GET /domains/prices?domain.name=example&domain.extension=com&operation=create&period=1`. `operation` is one of create (default), transfer, renew, restore, trade, update; `period` 1 to 10, used with create (Help "retrieve domain price": https://openprovider.help/books/api-integrations/page/3-domains-api-how-to-retrieve-domain-price). Optional `additional_data.idn_script`. Response `data`: `price` {product, reseller}, `is_premium`, `is_promotion`, `tier_price`, `membership_price`, `promotion_data` {start_date, end_date}. Prices can change with currency rates and promotions, so quote right before registering.

### 3.2 TLD catalogue

Source: Spec `GET /v1/tlds`, `GET /v1/tlds/{name}`; Help https://openprovider.help/books/api-integrations/page/1-tld-api-search-an-extension.

- `GET /tlds?extensions=sa&with_price=true&with_restrictions=true&with_description=true&status=ACT`. Other query: `limit`, `offset`, `order`, `order_by`, `name_pattern`, `only_names`, `with_usage_count`, `with_application_mode`, `with_level_prices`, `is_active`, `is_new_gtld`, `application_mode`.
- `GET /tlds/{name}` takes the same `with_*` flags.
- Response `data.results[]` (`tldTld`): `name`, `status`, `min_period`, `max_period`, `quarantine_period`, `soft_quarantine_period`, `usage_count`, `description` {text, url}, `restrictions` (array of strings; contents not specified), `prices` {`create_price`, `renew_price`, `transfer_price`, `trade_price`, `restore_price`, `soft_restore_price`, `update_price`, `setup_price`, `domicile_price`, `reseller_price`, `min_period`, `max_period`}, `level_prices[]`, `supported_application_mode[]` {name,title}, `supported_idn_scripts[]` {value,description}.
- Capability flags: `transfer_available`, `trade_available`, `renew_available`, `domicile_available`; auth code: `is_transfer_auth_code_required`, `is_trade_auth_code_required`, `is_auth_code_requested`, `is_auth_code_available`, `is_auth_code_changeable`; WHOIS privacy: `is_private_whois_allowed`; DNSSEC: `dnssec_allowed`, `dnssec_keys_allowed`, `dnssec_digests_allowed`, `dnssec_algorithms[]`, `dnssec_max_records_amount`; contact roles: `owner_handle_supported`, `admin_handle_supported`, `tech_handle_supported`, `billing_handle_supported`, `billing_handle_enabled`, `reseller_handle_supported`, `reseller_handle_enabled`.
- Is "register available" a flag? NOT DOCUMENTED — there is no `register_available` field; use `status` ACT plus a probe of `POST /domains/check`.
- Required additional data (domain level): `GET /domains/additional-data?domain.extension=<ext>&operation=<op>`; returns `data[]` of {`name`, `description`, `required`, `type` (e.g. select), `options[]` {value, description}}. Customer-level: `GET /domains/additional-data/customers?domain.extension=<ext>` (Spec, quickstart; response schema not captured in detail).
- Structured eligibility rules (residency, trademark, local presence): NOT DOCUMENTED in the API; only free-text `restrictions` and `description`.
- .sa: not mentioned in the API docs. The Help ".sa" page (https://openprovider.help/books/domains/page/sa) states new .sa registrations and transfers are not possible at the moment, and lists requirements: owner with a Saudi local address, a Saudi-valid trademark certificate and copies, domain name closely matching owner or company name, local owner and admin contacts, local landline and mobile, nameservers pre-configured and authoritative, no Openprovider local-presence service. Transfer: auth code optional. Treat .sa as unsupported until `GET /tlds/sa` and a sandbox/production probe prove otherwise.

### 3.3 Customer handles (registrant/admin/tech/billing contacts) and contact update

Source: Spec `/v1/customers`, `/v1/customers/{handle}`, `/v1/contacts`, `/v1/contacts/{id}`; Help https://openprovider.help/books/api-integrations/page/6-customers-api-how-to-create-a-customer-handle.

Important distinction: a domain's owner/admin/tech/billing contacts are **customer handles** (`/customers`). `/contacts` are the reseller account's own login users (they carry `username`, `password`, `api_access_enabled`, `role`), not domain registrants. Use `/customers` for domain contacts.

- Create: `POST /customers`
  - Request (create fields): `{"name": {"initials","first_name","prefix","last_name","full_name"}, "company_name": "…", "address": {"street","number","suffix","zipcode","city","state","country"}, "phone": {"country_code":"+966","area_code":"…","subscriber_number":"…"}, "email": "…", "fax": {…}, "locale": "…", "vat": "…", "comments": "…", "tags": [{"key":"customer","value":"…"}], "additional_data": {…}, "extension_additional_data": [ … ]}`.
  - Required per Spec quickstart: `name`, `address`, `phone`, `email`. `phone.country_code` includes the plus sign; `area_code` omits the leading zero.
  - Response: `data.handle` (string, format like `XX123456-XX`: initials plus country code).
  - Sync.
- Read: `GET /customers/{handle}?with_additional_data=true`. Search: `GET /customers` with `handle_pattern`, `email_pattern`, `first_name_pattern`, `last_name_pattern`, `company_name_pattern`, `comment_pattern`, `pattern`, `type`, `limit` (default 100, max 1000), `offset`. `*` is a wildcard (Spec quickstart).
- Update: `PUT /customers/{handle}`, body fields `vat`, `address`, `phone`, `fax`, `email`, `locale`, `comments`, `additional_data`, `extension_additional_data`, `tags`. Name and company name cannot be changed; clone to a new handle instead (Spec quickstart). `extension_additional_data` is required by some TLDs.
- Delete: `DELETE /customers/{handle}` succeeds only if the handle is not attached to products (error 187 / 6200 otherwise).
- Update of a reseller login user: `PUT /contacts/{id}` (fields include `email`, `name`, `phone`, `address`, `api_access_enabled`, `api_client_ip_list`). Not needed for registrants.
- Customer search by our own reference: `comment_pattern` and `tags` exist; `tags[].key` documented allowed value is `customer` only.
- Responses: `data.id`/`handle`; failure codes for contact data are in the 122-195 and 330-335 ranges (Errors).

### 3.4 Register domain

Source: Spec `POST /v1/domains`; Help https://openprovider.help/books/api-integrations/page/13-domains-api-how-to-create-a-domain.

- `POST /domains`
- Minimal request: `{"domain": {"name": "example", "extension": "com"}, "period": 1, "owner_handle": "XX000001-XX", "admin_handle": "…", "tech_handle": "…", "billing_handle": "…", "name_servers": [{"name": "ns1.example.net"}, {"name": "ns2.example.net"}], "autorenew": "off", "comments": "<our reference>"}`.
- Other fields (Spec): `ns_group` (required only if `name_servers` empty; `dns-openprovider` uses Openprovider DNS), `ns_template_name`/`ns_template_id`, `unit` (yearly, quarterly, monthly), `accept_premium_fee` (required for premium; value is the premium price), `accept_eap_fee`, `is_private_whois_enabled`, `is_dnssec_enabled` (only with Openprovider nameservers), `dnssec_keys`, `additional_data`, `application_mode` (new gTLD phases), `auth_code`, `promo_code`, `reseller_handle`, `provider`, `use_domicile`.
- Client reference: `comments` (string). There is no client token or reference-id field. Comments are visible only to the reseller (Spec quickstart).
- Response `data`: `id` (int), `status` (`ACT` active or `REQ` requested), `activation_date` (only when completed in real time), `expiration_date`, `renewal_date`, `auth_code` (only if the TLD supports it). Use `renewal_date` as the renewal deadline (Spec says `expiration_date` is not the primary reference).
- Async: partly. Most TLDs register immediately and debit the balance; some TLDs return `REQ` until the registry finishes. How to track REQ to completion: not described; poll `GET /domains/{id}` or search (3.5), and use webhooks (3.12).
- Find-by-token approach (reconcile after timeout, since the call is not idempotent):
  1. Put a unique reference into `comments` at create time.
  2. After timeout or 5xx, call `GET /domains?full_name=example.com` (exact) and/or `GET /domains?comment_pattern=<ref>` and inspect `status`, `comments`, `id`.
  3. Retry create only if no domain exists and no REQ/ACT record appears; the identical-create block (error 4007) also punishes blind retries.
- Failure examples: 311 domain not free, 310/920 insufficient balance, 330-335 bad handles, 18003 nameservers not authoritative (Errors).

### 3.5 Get / search domain (reconciliation)

Source: Spec `GET /v1/domains`, `GET /v1/domains/{id}`.

- Search: `GET /domains` with query `full_name`, `domain_name_pattern` (`*` wildcard), `extension`, `id`, `status` (ACT, REQ, DEL, FAI per quickstart), `status_not_equal[]`, `queue_status`, `contact_handle`, `comment_pattern`, `ns_group_pattern`, `renewal_date`, `limit` (default 100), `offset`, `order_by.<field>` (id, domain_name, domain_extension, order_date, active_date, expiration_date, renewal_date, status, transfer_date), flags `with_history`, `with_api_history`, `with_additional_data`, `with_verification_email`, `with_registry_statuses`, `is_deleted`, `application_mode`, `response.type`, `response.to`.
- Response `data.results[]` + `data.total`. Items carry `id`, `domain` {name, extension}, `status`, `owner_handle`, `admin_handle`, `tech_handle`, `billing_handle`, `reseller_handle`, `autorenew`, `unit`, `comments`, `comments_last_changed_at`, `order_date`, `active_date`, `creation_date`, `expiration_date`, `renewal_date`, `registry_expiration_date`, `is_locked`, `is_lockable`, `is_private_whois_allowed`, `is_private_whois_enabled`, `is_dnssec_enabled`, `dnssec_keys`, `is_premium`, `can_renew`, `renew`, `is_deleted`, `deleted_at`, `name_servers`, `ns_group`, `auth_code`, `transfer_auth_code_required`, `transfer_cancel_supported`, `trade_allowed`, `registry_statuses`, `history`/`api_history` when requested.
- Get one: `GET /domains/{id}` (int id); optional `domain.name`, `domain.extension`, `with_history`, `with_api_history`, `with_additional_data`, `with_verification_email`, `with_abuse_details`, `with_whois_privacy_data`, `with_registry_statuses`, `is_deleted`.
- Full list of `status` values: NOT DOCUMENTED. Statistics schema names ACT, FAI, NSR, PEN, REJ, REQ for reseller domain counts (Spec); only ACT/REQ/FAI/DEL are described in the quickstarts.

### 3.6 Renew

Source: Spec `POST /v1/domains/{id}/renew`; Help https://openprovider.help/books/api-integrations/page/18-domains-api-how-to-renew-a-domain.

- `POST /domains/{id}/renew`
- Request: `{"domain": {"name": "example", "extension": "com"}, "id": 123456, "period": 1}`. `period` defaults to 1.
- Response: `data.status` (example `ACT`).
- Sync per the docs; async states other than the status value: NOT DOCUMENTED.
- Window rules: some TLDs renew any time, others only within a window before expiry (28 days is cited); the error page exists ("can only be renewed within 28 days"), codes in the 19000 and 28000 ranges. Error 342 if renewed again within 10 seconds. Auto-renew with insufficient balance leads to deletion at expiry.
- No idempotency key: reconcile via `GET /domains/{id}` (compare `renewal_date`/`expiration_date`) before retrying.

### 3.7 Transfer in

Source: Spec `POST /v1/domains/transfer`, `POST /v1/domains/{id}/last-operation/restart`; Help https://openprovider.help/books/api-integrations/page/14-domains-api-how-to-transfer-a-domain.

- `POST /domains/transfer`
- Request: `{"domain": {"name": "example", "extension": "com"}, "auth_code": "<EPP code>", "owner_handle": "…", "admin_handle": "…", "tech_handle": "…", "billing_handle": "…", "name_servers": [{"name": "…"}], "autorenew": "default", "period": 1, "comments": "<our reference>"}`. Other fields: `ns_group`, `ns_template_name`, `accept_premium_fee`, `is_dnssec_enabled`, `dnssec_keys`, `is_private_whois_enabled`, `additional_data`, `application_mode`, `promo_code`, `at` (scheduled), `roid`, `import_contacts_from_registry`/`import_nameservers_from_registry` (.nl, .ie). Auth code is needed for most but not all TLDs (`is_transfer_auth_code_required` in the TLD record).
- Response `data`: `id`, `status` (`ACT` done, `REQ` awaiting approval, `FAI` failed), `auth_code`, `expiration_date`, `renewal_date`, `error`.
- Async: yes. Code 0 only means the order exists in Openprovider; the registry then holds it as pending transfer; the losing registrar typically has 5 to 7 days; the total can range from instant to over a month depending on TLD. On completion the domain may be renewed one year and set `clientTransferProhibited` (locked).
- Transfer status: no dedicated endpoint. Poll `GET /domains/{id}` or `GET /domains?full_name=…` (`status`, `queue_status`), or consume webhook events (3.12). Restart a stuck operation: `POST /domains/{id}/last-operation/restart` with `{"id":…, "domain":{…}, "auth_code":"…"}` (returns boolean). Cancel an incoming transfer: only the `transfer_cancel_supported` flag is visible; an endpoint is NOT DOCUMENTED.
- Outgoing: `POST /domains/{id}/transfer/approve` `{"id", "domain", "approve": <int>, "auth_code", "registrar_tag"}`.
- Sandbox does not support transfers.
- Errors: 318 auth code wrong, 328 domain locked at current registrar, 322 transfers not supported for the extension, 514 already transferring, 19004 domain under 60 days old, 542 expiry too close.

### 3.8 Modify domain: nameservers, lock, auto-renew, privacy

Source: Spec `PUT /v1/domains/{id}`; Help https://openprovider.help/books/api-integrations/page/21-domains-api-how-to-update-domains-attributes.

- `PUT /domains/{id}`
- Request (send only fields to change): `{"id": 123456, "domain": {"name":"example","extension":"com"}, "name_servers": [{"name":"ns1.x.net","ip":"…","ip6":"…","seq_nr":1}], "ns_group": "…", "is_locked": true, "autorenew": "on", "is_private_whois_enabled": true}`.
  - Nameservers: `name_servers[]` {name, ip, ip6, seq_nr} or `ns_group`; `ns_template_name`/`ns_template_id` only with `ns_group=dns-openprovider`; `remove_nses`. Error 18003 if the nameservers are not authoritative yet.
  - Transfer lock: `is_locked` (boolean). Per-domain `is_lockable` in GET.
  - Auto-renew: `autorenew` is `on`, `off` or `default`.
  - Privacy/WHOIS protection: `is_private_whois_enabled`; per-TLD support `is_private_whois_allowed`.
  - Others: `owner_handle`/`admin_handle`/`tech_handle`/`billing_handle`, `comments`, `is_dnssec_enabled`, `dnssec_keys[]` {alg, flags, protocol, pub_key, readonly}, `reset_auth_code`, `scheduled_at`, `force_registry_update`, `accept_update_fee`, `accept_premium_fee`.
- Response `data`: `id`, `status` (example `ACT`). Async behaviour (scheduled or registry-pending updates): `scheduled_at` exists; completion semantics NOT DOCUMENTED.
- Doc caveat: the Help field table omits `is_locked` and privacy, but the Spec and the Help prose include them.
- Owner change is a trade (`POST /domains/trade`), not an update. Restore: `POST /domains/{id}/restore`. Delete: `DELETE /domains/{id}`.

### 3.9 Auth code / EPP code

Source: Spec `GET /v1/domains/{id}/authcode`, `POST /v1/domains/{id}/authcode/reset`; Help https://openprovider.help/books/api-integrations/page/15-domains-api-how-to-request-or-reset-an-authcode.

- Get: `GET /domains/{id}/authcode?auth_code_type=external` (`external` default, `internal` for Openprovider-to-Openprovider transfers; `sending_type` only for ru / xn--p1ai). Response `data`: `auth_code`, `success`, `type`. For .be and .eu the registry emails the code to the owner instead.
- Reset: `POST /domains/{id}/authcode/reset` body `{"id", "domain", "auth_code_type", "sending_type"}`. Response `data`: `auth_code`, `auth_info.pw`, `domain_roid`, `epp_statuses[]`, `rgp_statuses` {add_period, auto_renew_period}, `success`, `type`.
- Sync. Errors: 319 cannot request for this extension, 338 cannot reset, 352 expired, 393 sent to owner, 1540 domain locked (unlock first).

### 3.10 DNS zones (Openprovider-hosted DNS)

Source: Spec `/v1/dns/zones`, `/v1/dns/zones/{name}`, `/v1/dns/zones/{name}/records`; Help https://openprovider.help/books/api-integrations/page/3-zones-api-how-to-modify-a-zone.

- Create: `POST /dns/zones`
  - Request: `{"domain": {"name":"example","extension":"com"}, "type": "master", "records": [{"name":"www","type":"A","value":"1.2.3.4","ttl":3600,"prio":0}], "secured": false, "template_name": "…", "provider": "sectigo", "master_ip": "…"}`. `type` is master or slave; `master_ip` for slave; `provider: "sectigo"` creates a premium zone with an extra fee.
  - Response: `{"code":0,"data":{"success":true}}` (`zoneZoneBoolResponse`). Sync.
- Get: `GET /dns/zones/{name}?with_records=true&with_history=true&with_dnskey=true` (also `id`, `provider`). List: `GET /dns/zones` with `limit` (default 100, max 500 in Spec; the guide says 1000), `offset`, `name_pattern`, `type`, `with_records`, `with_history`, `with_dnskey`, `provider`, `order_by.*`.
- Zone object (`zoneZone`): `id`, `name`, `type`, `provider`, `ip`, `active`, `is_shadow`, `is_deleted`, `dnskey`, `records[]`, `history[]`, `creation_date`, `modification_date`, `reseller_id`, `premium_dns`.
- List records: `GET /dns/zones/{name}/records` with `zone_id`, `limit`, `offset`, `record_name_pattern`, `value_pattern`, `type`, `prio`, `ttl`, `order_by.type|name|value|ttl|prio`. Response `data.results[]` {`name`, `type`, `value`, `ttl`, `prio`, `ip`, `creation_date`, `modification_date`} and `data.total`.
- Modify: `PUT /dns/zones/{name}`
  - Request: `{"id": 1, "name": "example.com", "domain": {"name":"example","extension":"com"}, "type": "master", "is_spamexperts_enabled": false, "records": {"add": [ {…} ], "remove": [ {…} ], "replace": [ {…} ], "update": [ {"original_record": {…}, "record": {…}} ]}}`. `is_spamexperts_enabled` is required for master zones.
  - One call with several of add/remove/replace/update: the schema (`zoneRecordUpdates`) permits all four arrays together, but every documented example uses one modifier per call; combining is therefore NOT DOCUMENTED as supported.
  - Atomicity / rollback / partial-failure behaviour: NOT DOCUMENTED — treat as non-atomic; re-read records after any error or timeout.
  - A full rewrite (`records` as complete array) is described for small zones; the guide says single-record changes must use the modifiers.
  - Response `{"code":0,"data":{"success":true}}`.
- Record types: A, AAAA, CNAME, MX, SPF, SRV, TXT, NS, TLSA, SSHFP, CAA. `prio` required for MX. TTL guide values: 900, 3600, 10800, 21600, 43200, 86400, anything else saved as 86400; the Errors page mentions a 600-second minimum TTL in the 800-877 DNS range (inconsistent; re-check in sandbox). Escape double quotes in TXT values.
- Delete zone: `DELETE /dns/zones/{name}` (not undoable; optional `id`, `domain.name`, `domain.extension`, `provider`).
- DNSSEC: zone level only the `secured` boolean on create and `dnskey` readable with `with_dnskey`; DS submission to the registry is domain-level via `is_dnssec_enabled` (only with Openprovider nameservers) and `dnssec_keys[]` on domain create/update. Zone-level DNSSEC toggle on an existing zone, and DS handling: NOT DOCUMENTED.
- Templates: `GET/POST /dns/templates` (`name`, `records[]`), `GET/DELETE /dns/templates/{id}`.
- Also present: `POST /dns/domain-token` (purpose not documented in what was read), nameserver and nameserver-group CRUD under `/dns/nameservers` and `/dns/nameservers/groups`.

### 3.11 Reseller billing / cost reconciliation

Source: Spec `/v1/transactions`, `/v1/invoices`, `/v1/payments`, `/v1/resellers`, `/v1/resellers/statistics`. No Help page was read for these; shapes are from the Spec.

- Transactions: `GET /transactions` with `limit`, `offset`, `order`, `order_by`, `start_creation_date`, `end_creation_date`, `filter_for_subject`. Response `data.results[]` and `data.total`; each item: `action`, `type`, `object_type`, `subject`, `creation_date`, `quantity`, `reference_id` (int32), `discount`, `exchange_rate`, `vat`, `price`, `setup`, `total` (each `{product:{currency,price}, reseller:{currency,price}}`, price is a double). No `amount` field; there is no transaction id field in the schema other than `reference_id`. Date format and the meaning of `reference_id`, action/type enums: NOT DOCUMENTED.
- Invoices: `GET /invoices` (same paging and date filters). Item: `id`, `invoice_number`, `creation_date`, `invoice_url`, `attachment_url`, `amount` {product, reseller}.
- Payments: `GET /payments` (adds `type`, `status`). Item: `id`, `amount`, `method`, `status`, `type`, `is_processed`, `creation_date`, `payment_date`, `confirmation_date`.
- Balance: `GET /resellers?with_settings=true&with_statistics=true` returns `balance`, `reserved_balance`, `settings.currency`, etc. (`resellerReseller`).
- Money values are doubles in the vendor API; the adapter must convert to integer minor units on ingestion (project rule), and never use floats downstream.
- CSV/export download or a statement endpoint: NOT DOCUMENTED — capability treated as unsupported.

### 3.12 Webhooks / notifications

Source: Webhooks page (https://openprovider.help/books/api-integrations/page/webhook-notification-system). Also mentioned in the Spec only for SSL orders.

- Supported: yes (domain lifecycle events; a vendor blog calls it a beta program, but the Webhooks page does not state beta status).
- Configuration: no UI. Set through the reseller modify call, REST `PUT /v1/resellers/{resellerId}` (works on `/v1` and `/v1beta`, also in the sandbox). Settings: enable flag, HTTPS endpoint URL, an API key (sent as bearer to our endpoint), optional signature secret. A test event is sent when saving; our endpoint must answer HTTP 200. The exact JSON field names for these settings are NOT DOCUMENTED in what was read (the Spec's `resellerUpdateResellerRequest` field list did not show them); confirm in sandbox. `isEmailEnabled` is reserved with no effect.
- Source IPs to allow-list: 185.87.187.130 and 34.34.72.46.
- Events (21 per the page): transfers (outgoing and incoming: completed, pending, failed, canceled), delete (completed, failed), registration (completed, pending, failed), trade (pending, failed), update (completed, failed), restore (failed), disputes (received, closed), registry message received, `testEvent`. Exact event-type strings: NOT DOCUMENTED in what was read (examples seen elsewhere include `outgoingTransferCompleted` and `domain.created`; they are inconsistent, so do not hard-code).
- Payload: root `id`, `schemaVersion` ("1.0"), `eventType`, `timeStamp` (unix seconds); `data`: `domainId`, `domain`, `action`, `status`, `orderDate`, `activationDate`, `renewalDate`, `expirationDate`, `comments`, `registryMessage`.
- Headers: `Content-Type: application/json`, `Authorization: Bearer <configured key>`, `User-Agent` and `X-Webhook-Agent` = `Openprovider-Webhook/1.0`, `X-Webhook-Event`, and `X-Webhook-Signature` only when a secret is set.
- Signature: HMAC-SHA256 with the secret as key over `<timestamp>.<raw body>`; header carries `t` (timestamp) and `v1` (hex digest); compare in constant time. Exact serialization of the header value and a replay tolerance window: NOT DOCUMENTED.
- Delivery: non-200 or timeout triggers retries, up to 5 attempts with progressive delay (schedule not readable), then the event is logged as undelivered and the reseller gets an email "[OPENPROVIDER] Failed webhooks". Timeout duration, ordering guarantee, event id uniqueness semantics: NOT DOCUMENTED. Webhooks are at-least-once at best; poll `GET /domains` as the reconciler regardless.
- The webhook `data.comments` echoes the domain comments, which can carry our reference.

## 4. Error model

Source: Spec (`errorError`), Errors page, Limits page.

- HTTP status codes: NOT DOCUMENTED — capability treated as unsupported. The Spec declares one `default` error response per operation and does not list 4xx/5xx codes; Help pages show only `code`/`desc` bodies. The adapter must classify by the body `code`, not by HTTP status, and must also treat non-JSON or 5xx bodies as an uncertain outcome.
- Envelope: `{"code": <non-zero>, "desc": "<text>", "data": "<extra>", "maintenance": <bool>, "warnings": []}`.
- Relevant codes (Errors page; numbers verbatim, meanings paraphrased):

| Category | Codes |
|---|---|
| Auth failure | 196 authentication/authorization failed; 190 invalid username; 900 login failed; 901/902 empty username/password; 10004 invalid password; 10006/10007 two-factor required/invalid; 197 account blocked pending processor agreement; 4002 permission denied |
| Access / IP / API disabled | 10005 caller IP blocked; 10008 API disabled for contact; 10009 API disabled for reseller; 4004 API not available |
| Validation | 80 invalid request; 81 wrong HTTP method or endpoint; 104 invalid data; 315/316 bad period; 347 bad auto-renew; 701 more than 15 domains in one check; 1 no changes in data; 19013 invalid period unit; 122-195 contact fields; 220-247 nameservers; 800-877 DNS |
| Domain unavailable/taken | 311 not free; 326/346/350/362 already in account or Openprovider; 327 exists but inactive/quarantine; 512 blocked; 513 reserved; 16 blocked by EURid |
| Insufficient balance | 310 credit not enough; 920 balance insufficient |
| Rate limit / excessive use | 50 calls limit reached; 4007 temporarily blocked for excessive use; 342 renewed again within 10 s; "10005 Access denied" for the identical-call block; message text "Calls limit has been reached" |
| Maintenance / outage | 4005 API disabled for maintenance; 340 registry unavailable for maintenance; 10 registry unreachable; 17 registry error (retry later); 3005 cannot connect to server; 3006 service temporarily unavailable; plus response field `maintenance: true` and warnings |
| Transfer | 318 auth code wrong; 328 locked; 322 transfer unsupported; 514 in progress; 19004 under 60 days |

- Retry guidance for the adapter: treat 4005/340/10/17/3005/3006 and `maintenance: true` as retryable-later; 50/4007/10005 as backoff (not before 5 minutes for 4007 per its block); everything else as terminal; any timeout on a mutating call is "uncertain" and must be reconciled first (project rule).
- Complete code table (hundreds of codes by range) is on the Errors page; consult it for specific mappings.

## 5. Gaps and assumptions

Items we need that the docs read do not state (all: NOT DOCUMENTED — capability treated as unsupported unless noted):

1. Idempotency key, client token, request id: none. Assumption: `comments` plus search (`comment_pattern`, `full_name`) is the only reconciliation handle; unique per attempt reference required. Comment length limit and whether `comment_pattern` is exact or wildcard-only: not stated.
2. HTTP status code mapping and `Retry-After`/rate-limit headers.
3. Complete enumeration of domain `status` values, check-result `status` values, `queue_status` values, and event-type strings.
4. Whether `POST /domains/check` has a documented maximum (only error 701 implies 15).
5. A "register available" flag per TLD and structured eligibility/residency rules; only free-text `restrictions`/`description` exist.
6. Whether .sa works via the API: the Help page says new .sa registrations and transfers are currently not possible; treat .sa as unsupported until a probe against the account shows otherwise. API docs never mention .sa.
7. A transfer-status endpoint and an incoming-transfer cancel endpoint (only domain status polling, restart, and webhooks).
8. Whether token lifetime refreshes on use; a token refresh/logout endpoint.
9. Sandbox `/v1` base URL, whether sandbox registry operations are simulated, sandbox balance funding, and whether sandbox exposes webhooks beyond the statement that webhook config works there.
10. IP allow-list: whether Openprovider mandates one for API users (only optional per-contact lists seen).
11. Atomicity and combined-modifier behaviour of `PUT /dns/zones/{name}`; DNSSEC toggle on an existing zone; minimum TTL (guide and error table disagree).
12. Webhook settings JSON field names, exact event names, signature header format, replay window, delivery timeout, ordering and duplicate semantics.
13. Transactions/billing: statement or CSV export, transaction unique id, date format, enumerations of `action`/`type`, `reference_id` semantics; monetary values are doubles.
14. Which fields of domain create are echoed back (only `id`, `status`, dates, `auth_code`); synchronous guarantee for `ACT` vs `REQ` per TLD.
15. Renewal window per TLD (28 days is cited for some); how `can_renew`/`renew` should be interpreted.
16. Domains created via `/contacts` vs `/customers`: assumption (from the Spec) that registrants are customer handles; verify in sandbox.
17. Version drift: Spec title says "1.0.0-beta" while the paths are `/v1`; `/v1beta` ends 30 June 2027. Adapter should use `/v1` for production and confirm what the sandbox accepts.
18. Source reliability: the Help examples contain typos and the Spec summaries were read through a lossy fetch. Re-validate all field names against the raw Spec and sandbox before shipping; until then every row here is NOT VERIFIED.

## 6. Operations the adapter (`packages/adapters/openprovider`) actually uses

Everything else in §3 is NOT used. Status of every row: NOT VERIFIED (HG-07-01); the adapter is tested only against a local mock shaped from this document.

| Adapter method | Vendor call(s) | Notes |
|---|---|---|
| `probe` | `GET /tlds?limit=1`, `POST /domains/check` (read-only), `GET /dns/zones?limit=1`, `GET /transactions?limit=1` | register/renew/transfer/contacts/lock/privacy/auth-code/find-by-token are derived from the TLD catalogue (no `register_available` flag exists); `dnssec` and `webhooks` stay `unknown`; `eligibility` is `unsupported` |
| `supportedTlds` | `GET /tlds?status=ACT&with_price=true&with_restrictions=true` | non-empty `restrictions` ⇒ `restricted: true` |
| `search` | `POST /domains/check` (≤ 15 per call) | only `free` is available; premium is shown but not sold |
| `register` | `POST /customers` (handles), `POST /domains` | token in `comments` (`nuzm:<token>`); lookup before create |
| `findByToken` / `inspect` | `GET /domains?comment_pattern=` / `?full_name=` | absence is proven by a clean name lookup |
| `renew` | `GET /domains` then `POST /domains/{id}/renew` | double-renew guard compares the expiry with the order baseline |
| `transferIn` | `POST /domains/transfer` | auth code read from the vault; `REQ` ⇒ `accepted` |
| `setNameservers`, `setLock`, `setAutoRenew`, `setContacts` | `PUT /domains/{id}` (+ `POST /customers` for contacts) | |
| `authCode` | `GET /domains/{id}/authcode` | the code goes straight to the vault store, never returned |
| `dns.*` | `POST /dns/zones`, `GET /dns/zones/{name}`, `PUT /dns/zones/{name}` | one modifier per call (non-atomic); MX/SRV/CAA value formats are an assumption |
| `fetchBilling` | `GET /transactions` | doubles converted to minor units without float arithmetic; lines with an unknown currency are skipped |
| `parseWebhook` | — | HMAC-SHA256 over `<t>.<raw body>`, header `t=…,v1=…` (serialization is an assumption); the event-name classification is an assumption |
