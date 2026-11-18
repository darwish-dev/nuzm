# Demo script — M08 managed data and email (dev-reference only)

Everything below runs against in-memory **dev-reference mocks** (`DATA_LOCAL_REFERENCE=true`, never in production). It proves the code paths, NOT any provider.

1. `NUZM_PGPORT=54334 pnpm services:start && pnpm db:migrate` (Redis is not installed here: the cache path is mock-only).
2. As a platform admin: `POST /v1/admin/data-providers` configure + probe + request_enable + enable a `mock-database` (environment `local`) and watch `blockers` for a production-style row (ADR, live probe, evidence, second approver).
3. As an owner: quote (`kind=database`) → create → backup → restore to a NEW database → rotate the credential → delete (final backup).
4. Buckets: quote (`kind=storage`) → create → policy (try `public-read` without `confirmPublic`) → signed URL → lifecycle.
5. Email: add a domain, publish the records on the fake resolvers (tests) or at a real DNS (needs a provider: BLOCKED), verify, add a sender, create a template, send, replay with the same Idempotency-Key, deliver a signed bounce webhook and watch the suppression.
Evidence for each step is in the integration specs: `apps/api/src/modules/data/*.int.spec.ts`, `apps/api/src/modules/email/email.int.spec.ts`.
