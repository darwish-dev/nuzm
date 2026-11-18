# Demo script — M06 shared hosting (mock node)

Everything below runs against the **mock node agent** (no CloudPanel, no real node): it demonstrates the control plane, not CloudPanel (all live rows BLOCKED/NOT VERIFIED).

Prerequisites: `NUZM_PGPORT=54332 pnpm services:start`, env of docs/runbooks/local-setup.md, `pnpm build`.
The scripted equivalent is the integration suite: `pnpm --filter @nuzm/api exec vitest run --config vitest.integration.config.mts src/modules/hosting` (every step below is a test).

1. **Add a mock node** — `POST /v1/admin/hosting/nodes {name, computeInstanceId}` (hosting_admin) → enrol the agent with the one-time token → `POST …/inventory` → `PATCH {status:'active'}`. (`hosting-nodes.int.spec.ts`)
2. **Create two tenants' sites** — each organization: `POST /v1/quotes {kind:'hosting', items:[{planId, runtime}]}` → `POST /v1/hosting/sites` (202) → the operation steps run → `active`. (`hosting-sites.int.spec.ts`)
3. **Attempt a cross-read** — as site A on the mock node: read B's `.env`, traverse, symlink, `/proc`, `/tmp`, PHP `open_basedir`, other DB: every attempt is denied (30 cases). (`mock/isolation.spec.ts`) Over the API, B's ids answer 404 everywhere.
4. **Backup / restore** — `POST …/backups`, mutate files, `POST …/restores`: pre-restore safety backup, checksum verified, files identical. (`hosting-s26.int.spec.ts`)
5. **Fill capacity** — a plan that takes the rest of the node, then any new site → `409 no_capacity`; no leaked reservation. (`hosting-sites.int.spec.ts`; the 100,000-operation fuzz and 100-parallel test are in `capacity.fuzz.int.spec.ts`)
6. **Drain the node** — `PATCH {status:'draining'}`: new sites go elsewhere; `POST /v1/admin/hosting/sites/{id}/migrations` moves a site; a failing migration leaves the source serving. (`hosting-s26.int.spec.ts`)
