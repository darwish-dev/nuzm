# packages/db

Migrations (ordinal ranges per docs/05 §2a), RLS test harness, ownership checker.

- Owner milestone: see `docs/03-milestone-dependency-matrix.md`.
- Public API: none yet (nothing implemented in S01).
- Status: **skeleton only**.

## Demo data (dev only)

`pnpm db:dev-seed <organization id, name or slug>` fills one organization with demo servers, websites, domains
and databases, plus the dev-mock references they need (a mock cloud account, two placeholder hosting plans, a sandbox registrar
account), and turns on that organization's `cloud.provisioning`, `hosting.enabled` and `domains.enabled` flags. It refuses
non-local databases, writes only obviously fake values (`demo-*` and `<slug>-*` names, 203.0.113.0/24 IPs, `vault://dev/demo/...` references)
and is idempotent: run it again and it adds only what is missing. Point it at the database your stack uses with
`DATABASE_ADMIN_URL`, e.g. `DATABASE_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54329/nuzm_full pnpm db:dev-seed codgoo`.
The rows are written directly, not through the provisioning flows, so nothing is metered, billed or audited.
