# Demo — search → register → DNS → link to a hosting site (local, MOCK registrars)

Everything below runs against **local mock registrar servers** shaped from the vendors' documentation. The result is a demonstration of OUR flow, **not vendor evidence** (HG-07-01): every registrar row in the admin screen says NOT VERIFIED, and the hosting site is an in-memory fake (M06 absent).

```bash
NUZM_PGPORT=54333 pnpm services:start
export DATABASE_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54333/nuzm_dev DATABASE_URL=postgres://nuzm_app:nuzm_dev_only@127.0.0.1:54333/nuzm_dev
pnpm db:migrate && pnpm db:dev-logins
DOMAINS_DEV_MOCKS=true DOMAINS_ENABLED=true DOMAINS_ALLOW_NON_LIVE_REGISTRARS=true pnpm --filter @nuzm/api dev:stack
```

1. Sign in to the customer console, create an organization. As the DPO/platform admin: add the `openprovider` and `resellerclub` processors to the ROPA entry `adapter:registrar`, then in Settings → Data residency allow personal data to `NL` and `IN`. Record the consent `domain_registrant_disclosure` (Privacy → Consents). Fund the wallet (sandbox top-up).
2. **Search** (`/domains/search?q=myshop&tlds=com,sa`): `.com` is available with a SAR price; `.sa` is listed as *not supported* with its reason (no vendor call).
3. **Checkout**: get the quote (tax estimate, expiry countdown), fill the registrant, confirm. The domain page shows *pending*, then *active* once the operation finished.
4. **DNS**: create the zone, add `www A 192.0.2.10`, apply; add an invalid record (CNAME at the apex) and read the per-change error.
5. **Link to hosting**: the hosting screen is disabled until a site exists; with the API, register a fake site in the in-memory port (tests do: `domains-s31.int.spec.ts`) and call `POST /v1/domains/{id}/hosting-links` (preview, then `apply:true`).
6. Admin console → Domains: registrars (NOT VERIFIED), orders queue, RC-04 reconciliation, support lookup (contacts masked).
