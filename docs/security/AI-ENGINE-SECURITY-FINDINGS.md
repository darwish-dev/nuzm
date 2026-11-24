# AI Agent Engine — consolidated security findings (Session 07, QA / security / compliance)

Living document. Last update: 2026-11-24 (re-test after merge) · baseline `f81872d5`, re-tested on `integration/ai-engine` 4af0920c · branch `feature/ai-qa-security`. Method: read-only review of the existing AI, gateway, sandbox, deploy, mobile-signing and access code; adversarial tests written in `apps/api/src/qa/**` and `e2e/tests/fixtures/qa-*.ts`; compliance gates run on my own database (:54347). **No live provider, real credential, customer data, real execution or real deployment was used.** Everything below is offline evidence: it says nothing about a real model, runtime or hosting node (those are NOT VERIFIED / BLOCKED as in `AG-ENGINE-status-2026-11-24.md`). Re-audit the other sessions' code after the Master merges it (section 5).

## 0. Status after the merge (re-test, one file at a time, own Postgres)
| Defect | Status |
|---|---|
| DEFECT-1 | **fixed and re-tested** (79 passed) |
| DEFECT-3 | **fixed and re-tested** (179 passed in the SSRF/egress file) |
| DEFECT-4 (API-key part) | **fixed and re-tested** (deploy 7 passed); developer self-confirm and rollback approval still open by owner decision |
| DEFECT-5 | **fixed and re-tested** (6 passed; the read now refuses with `symlink_in_path`) |
| DEFECT-6 | **fixed and re-tested** (5 passed) |
| DEFECT-2 | **fixed and re-tested** (Session 04 `cc318642`; `qa-ssrf-egress` 187 passed, no expected fail left) |
| Integration finding (manifest ranges for 1920/1921/1980) | **resolved** by the Master's manifest patch; re-verified on `1fff67a4`: harness runs, `db check`, classification (3,396 columns / 271 tables), ROPA and residency hooks all OK |

Table 1 below is the original report (history); the status above prevails.

## 0b. Builder tools (Session 05, flag `builder_tools.enabled`, default off) — QA at the HTTP level
`qa-builder-tools.int.spec.ts`: **19 passed**. Flag off → 404 on every route (organization row beats global row, both directions); no session 401; non-member 404; viewer and billing admin read but every write (rollback, revert, memory add/forget) is 403 with nothing changed; developer writes; API keys: read-scoped key refused on writes; cross-tenant: session and API key of org B against org A's project ids → 404 with no leak (and the reverse); A's key cannot name org B in the header. The two dry-run routes (`plan-previews`, `change-previews`) were proven to write nothing (versions, changes, model usage, metering, operations, reservations, audit and project head unchanged over repeated calls; pure, same answer twice), which supports the Master's decision to pin them as the only non-idempotent exceptions. Memory write is idempotent by key (one entry, one version), refuses secrets/oversize/malformed input without echo; rollback creates a NEW restore version (history kept) and is audited; stale base refused.
New observation O-9: `billing_admin` holds `builder:read` (migration 1400 grants it to every role), so a billing admin can read a customer project's review, symbols, import analysis, components and memory. Probably unintended for source-level views; owner decision (Session 05).

## 1. Defects (reported to the owning session in `docs/parallel/sessions/DEFECT-<n>-*.md`)
| ID | Severity | Area / owner | Summary | Test (state today) |
|---|---|---|---|---|
| DEFECT-4 | **MEDIUM** (fix reported by S06 in `8d787bfa`, read by QA, not yet re-tested: merge pending) | Deploy / S06 | A website publish approval is decided by the requester in the same `POST`, with only `deploy:write`; an **API key** (non-human) completes request + confirm in two calls; audit records the key creator as a user | `qa-deploy-approval.int.spec.ts`: `it.fails` + CONFIRMED-TODAY control |
| DEFECT-6 | **MEDIUM** | AI runs / S02 | `POST /v1/ai/runs/{id}/approvals` needs only `ai:write`; an API key can approve a run's pending publish/delete/spend approval; `ai:approve` not consulted; comment claims "human member" and a hash check that is not in the code | `qa-run-approval.int.spec.ts`: `it.fails` + control |
| DEFECT-7 | **HIGH** | AI gateway / S02 (cc S05) | lock-order inversion between `reserve` (balance, then run) and settle (run, then balance) deadlocks when two calls of ONE run overlap; the loser of the deadlock is the usage transaction, AFTER the wallet debit was committed: customer charged, no usage row, no metering events, run cap under-counted; reservations sometimes left `held` until the TTL sweeper | `qa-ai-integrity.int.spec.ts`: `it.fails` (reproduces the `40P01`); control: calls of one run in sequence reconcile exactly |
| DEFECT-8 | LOW-MEDIUM | AI gateway / S02 | one call id sent 12 times at once reaches the provider 9-11 times (held reservation is reused by every duplicate); customer charged once, platform pays the provider N times and records one cost | `qa-ai-integrity.int.spec.ts`: `it.fails` + customer-side twin passes |
| DEFECT-9 | MEDIUM | secret scanner / S02, Master | 13 secret shapes pass the outbound scan: prefixed `.env` names (`STRIPE_SECRET_KEY=`, `JWT_SECRET=`, `ACCESS_TOKEN=`…), JSON config (`"password": "…"`, `"apiKey": "…"`), YAML next-line values, provider keys (`sk-ant-`, `sk-proj-`, `AIza`, `sk_live_`) | `qa-secret-scan.int.spec.ts`: 13 `it.fails` + 15 passing controls |
| DEFECT-2 | LOW-MEDIUM | SSRF fetcher (`packages/domain/src/ai/ssrf.ts`, no session row → Master) | `isBlockedAddress` treats IPv6 spellings of private IPv4 (IPv4-compatible, 6to4, SIIT, Teredo) as public; the sandbox egress policy blocks most of them (two implementations diverge) | `qa-ssrf-egress.int.spec.ts`: 8 `it.fails` |
| DEFECT-1 | LOW-MEDIUM | Execution Gateway policy / S04 | `decideExec` throws a `TypeError` for profile names that exist on `Object.prototype` (`constructor`, `toString`, `__proto__`): a refusal becomes an exception (not an allow) | `qa-exec-gateway.int.spec.ts`: 5 `it.fails` + "never allowed" control |
| DEFECT-5 | LOW today / HIGH as a rule | Sandbox runtime / S04 | `LocalDevSandboxRuntime.readFiles(named path)` and `writeFiles` follow symlinks left by sandboxed code (confused deputy); the escape suite has no control-plane symlink attempt | `qa-local-dev-sandbox.int.spec.ts`: 2 `it.fails` |
| DEFECT-3 | LOW | Sandbox egress / S04 | `blockedV6` misses SIIT `::ffff:0:a.b.c.d` and `100::/64` | `qa-ssrf-egress.int.spec.ts`: 2 `it.fails` |

`it.fails` = the test states the secure expectation and is expected to fail; when the owner fixes the defect it turns red ("expected to fail") and the marker is removed. No assertion was weakened and no test was skipped.

## 2. Observations (not defects; need an owner decision or are accepted design)
| # | Observation | Owner / action |
|---|---|---|
| O-1 | a `developer` can request and confirm a production publish alone on the legacy path, while the M10 engine lists owner/admin for `production_deploy`: two approval systems, two rules | Owner decision (DEFECT-4 §2) |
| O-2 | `rollback` reuses the previous approval; M10 policy has `production_rollback` | Owner decision |
| O-3 | 26 organization `POST` routes lack `@Idempotent()` (e.g. `POST /v1/billing/spend-approvals/{id}/decision`, `POST /v1/compliance/data-exports`, `POST /v1/organizations`, builder `changes`/`previews`); pinned as the baseline in `qa-route-inventory.int.spec.ts`; each owner should confirm idempotency by construction or add the decorator (CLAUDE.md §4). New ones fail the gate | each module owner |
| O-4 | `LocalDevSandboxRuntime` is refused only when `NODE_ENV==='production'` and `SANDBOX_LOCAL_DEV!=='true'`; a staging environment with another `NODE_ENV` and that flag runs customer code **unisolated** as the API user. Recommend an explicit allow-list of environments (and refusing when any real tenant exists) | S04 |
| O-5 | The reservation hold TTL (`AI_RESERVATION_TTL_SECONDS`) and per-call timeout × attempts are independent settings with no invariant; a mis-set TTL lets the sweeper release an in-flight hold (settlement still records spend, so no loss, but the cap check could be briefly exceeded) | S02: validate in `loadAiConfig` |
| O-6 | `npm run <declared script>` also runs `pre<name>`/`post<name>`; project `.npmrc`/`package.json` can set `script-shell`, `node-options`. The Execution Gateway policy cannot (and does not claim to) contain that: the **sandbox** is the only boundary. Keep `EXEC_ENV` fixed, consider `--ignore-scripts` and `NPM_CONFIG_USERCONFIG=/dev/null` for profiles that do not need them | S04 |
| O-7 | (RESOLVED, not a defect) `apps/api` `tsc` failed in my worktree only because the adapter packages had no workspace links after the first install; `pnpm install --frozen-lockfile --offline --force` fixed it and the typecheck is clean | none |
| O-10 (FIXED in Phase 2, Master) | `packages/db/src/dev-cloud.ts` seeded simulator ids (`dev-sa-1`, `spark-*`, `dev-ubuntu-*`) that the mock-compute adapter rejects (`region_not_listed`), contradicting its header ("only the simulator account can actually provision"); a customer creating a server from the seeded dev catalog gets a failed instance. Dev-only, found by the 08-compute E2E | Master (`packages/db/src`) |
| O-8 | The admin AI provider endpoint is a single `POST` guarded by `admin:ai:read` plus per-action checks in the handler (`need()`), with step-up. Correct today (tests exist), but a new action added without `need()` would be readable-permission-only | S02: review on change |

## 3. Verified controls (evidence I ran and saw)
| Control | Result | Evidence (command → actual output) |
|---|---|---|
| Every organization route: no session → 401; non-member → 404; role lacking the permission → 403 (viewer, billing_admin, developer; owner/admin hold all) | **PASS** | `qa-authz-matrix.int.spec.ts`: 10 passed |
| Every route declares access; `/v1/admin/**` platform-permission only; 34 public routes pinned; AI engine areas expose only the preview/form webhooks publicly; 502 routes scanned | **PASS** | `qa-route-inventory.int.spec.ts`: 8 passed; `pnpm spec:drift` OK 502 routes |
| Execution Gateway policy: closed surface, fixed argv/env, script allow-list, lifecycle scripts denied, tenant/run bound, gate closed by default | **PASS** (policy only) | `qa-exec-gateway.int.spec.ts`: 74 passed, 5 expected fail |
| SSRF fetcher and sandbox egress policy over a 36-address corpus + URL attacks (userinfo, schemes, decimal/hex/octal IPs, metadata hosts, rebinding, redirect chains, DNS tunnel names) | **PASS** except the gaps above | `qa-ssrf-egress.int.spec.ts`: 177 passed, 10 expected fail |
| Deploy: cross-tenant isolation, viewer/billing_admin refused, approval single-use and bound to environment/site, malformed ids → 4xx | **PASS** | `qa-deploy-approval.int.spec.ts`: 7 passed, 1 expected fail |
| Run approvals: viewer/billing 403, other tenant 404, no cross-run move, decisions final | **PASS** | `qa-run-approval.int.spec.ts`: 5 passed, 1 expected fail |
| Mobile signing (R6 10b scenario, API level): real viewer refused for read and write and nothing stored; non-member 404; owner control 201; key material 422 and never echoed | **PASS** | `qa-mobile-signing.int.spec.ts`: 6 passed |
| Migrations 1800–1870 reversible; schema identical after down + up; second migrate no-op | **PASS** | `qa-migration-roundtrip.int.spec.ts`: 9 passed |
| Local-dev sandbox: refuses traversal/absolute/encoded paths, refuses to start without the dev switch or in production, listing skips symlinks | **PASS** except DEFECT-5 | `qa-local-dev-sandbox.int.spec.ts`: 4 passed, 2 expected fail |
| RLS/ownership rules; classification complete (3,368 columns / 268 tables); ROPA coverage; residency hooks | **PASS** | `db check`, `classification`, `ropa-coverage`, `residency-hooks` on my migrated database |
| `spec:lint`, `spec:drift`, `scan:secrets` (2,647 files), `compliance:claims-guard`, `zatca:guard` | **PASS** | exit 0 each, on this branch |
| Static review PASS: key custody (`setCredential`, sealed store, never echoed, refused in production), two-person enable, dev exemptions refused in production, budget reservation under a per-org row lock, settlement idempotent by call id, audit and approvals tables immutable (trigger), run state machine enforced by trigger | **PASS (static)** | code read, file:line in the threat model; not all dynamically exercised by me |

## 4. Not verified / blocked (stated, not hidden)
- Real model behaviour, injection resistance of any real model, tool-call quality: **NOT VERIFIED** (no provider enabled; D1–D12 open).
- Isolation of any real runtime, escape suite on it, egress proxy, resource limits: **BLOCKED (D-21, HG-10-02)**.
- Real hosting node deploy/rollback/smoke: **BLOCKED (HG-05/06)**; only the in-memory publisher was exercised.
- Browser E2E, Arabic/English RTL, axe accessibility, screenshots, SDK client compatibility, full integration regression, concurrency/cancellation suites: **not run by me** (heavy: Master slot; see REPORT-07 heavy-run requests). The R6 results (E2E 45/45 per locale with 2 documented skips; integration 2,128 passed) are the baseline, historical, not re-run.
- `08-compute-customer` mock-catalog test: **PASS (simulated)** in ar and en on an isolated stack (REPORT-07 checkpoint 6); proves the screens and the simulator flow, nothing about a real provider.
- Pen test, DPO review, legal review: out of scope, human gates.

## 5. Re-audit plan when the Master merges the sessions
1. Re-run my gates after each merge batch: `cd apps/api && NUZM_TEST_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:<port>/postgres npx vitest run --config vitest.integration.config.mts src/qa` (≈2 min). The route inventory fails on any new public route, missing access declaration or non-idempotent POST; the authz matrix covers every new organization route; the migration round trip covers the new ranges 1900–1999 and fails on a missing `.down.sql`.
2. `pnpm --filter @nuzm/db exec tsx src/cli.ts check|classification|ropa-coverage|residency-hooks` after the new migrations (classification of every new column; ROPA/residency hooks for any new vendor-facing path).
3. Review new code for: approver kind checks (DEFECT-4/6 pattern), symlink confinement (DEFECT-5), argv/env closure (E1), egress decisions through one shared implementation (DEFECT-2/3), secrets in logs/prompts, `data_region`, metering and audit on every mutation, feature flags default off.
