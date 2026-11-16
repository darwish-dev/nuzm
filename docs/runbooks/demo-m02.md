# Demo: M02 (usage → quota → cap → quote → four-eyes approval → statement)

Local, no live providers. The price book is the DRAFT-NOT-APPROVED placeholder (HG-02-01); all numbers are examples.

## 0. Start
```bash
pnpm services:start && pnpm db:migrate
```
Producer key for the synthetic producer (any random string; only its SHA-256 goes into the API config):
```bash
KEY=demo-producer-key; export METERING_SOURCE_KEYS="[{\"source\":\"demo@M99\",\"sha256\":\"$(printf %s $KEY | shasum -a 256 | cut -d' ' -f1)\"}]"
pnpm --filter @nuzm/api dev:stack     # API :4000 + dev identity provider
pnpm --filter @nuzm/web dev            # customer console :3000 (admin console: pnpm --filter @nuzm/admin dev, :3001)
```

## 1. Organization and usage
1. Sign in at `http://127.0.0.1:3000/ar` (or `/en`) through the dev identity provider; create an organization.
2. Find its id (`select id from tenancy.organizations`) and post events as a producer would (the key fixes the source; `orgId` must be in each event):
```bash
curl -s http://127.0.0.1:4000/v1/internal/metering/events -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"events":[{
  "eventId":"'$(uuidgen)'","orgId":"<org-id>","meterId":"compute.vcpu_hours","quantity":"2","unit":"vcpu_hour",
  "resourceId":"11111111-1111-4111-8111-111111111111","windowStart":"<this-month>T01:00:00Z","windowEnd":"<this-month>T02:00:00Z",
  "occurredAt":"<now>","dimensions":{"region":"sa-central"},"dataRegion":"sa-pending"}]}'
```
3. **Billing → Usage** shows the aggregate (day/hour/month roll-up, data region, CSV export); the meter link opens the per-resource drill-down. **Billing → Quotas**: the free plan's `compute` limit is 0 (hard), so the group is restricted (new consumption refused, nothing deleted).

## 2. Wallet and statement
Credit the wallet through the two-person adjustment (admin console → Billing administration → Adjustments), or in a dev database with `billing.post` as the E2E does. **Billing → Statement** shows the running balance.

## 3. Spending cap, quote, approval
1. **Billing → Spending limits**: set the monthly cap (for example `10` SAR).
2. Create a quote as a developer or owner (no screen creates quotes; the typed create screens arrive with M05+):
```bash
curl -s http://127.0.0.1:3000/v1/quotes -H "x-csrf-token: <nuzm_csrf cookie>" -H "x-nuzm-org: <org-id>" -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' --cookie "nuzm_session=<cookie>; nuzm_csrf=<cookie>" -d '{"kind":"ai-credit","items":[{"credits":"1000"}]}'
```
3. Open **Billing → quote** (`/billing/quotes/<id>`): provisional tax, "not evaluated" residency, expiry countdown and the "needs approval" callout; request the approval.
4. A second person (billing admin) opens **Billing → Spend approvals** and approves (recent MFA required). The requester cannot decide their own request (four-eyes).
5. `OrderService.createFromQuote` (called by the typed create endpoints of later milestones) now accepts the quote exactly once; before the approval it answers `spend_approval_required`.

## 4. Admin console
Staff (platform roles) see **Billing administration**: ledger accounts and transactions, price books (publish by a different person), plans, meters (create), adjustments (request a reversal; a second person decides).

## What this demo does not show
Rated amounts need a rating run (`RatingService`, no HTTP trigger yet); no payment, invoice, tax authority or ZATCA (M03); quote kinds other than `ai-credit` (M05–M08); provider costs (import endpoint missing).
