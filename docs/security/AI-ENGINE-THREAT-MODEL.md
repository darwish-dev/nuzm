# AI Agent Engine — threat model of the new ports (Session 07, 2026-11-24, baseline `f81872d5`)

Scope: the ports defined in `docs/parallel/SHARED-CONTRACTS.md` §2 (proposal 0.1, not yet in code): `ExecutionPort`, `BuildPort`, `ArtifactRef`, `DeploymentPort` (= the existing `SitePublisherPort`), plus the surfaces the parallel sessions add (provider probe, benchmark runner, builder tools). This is a design-time model: it lists what must hold, where today's code already enforces it (with file), and which test proves or will prove it. Nothing here is verified for a real runtime, provider or node: no such thing is enabled. Status vocabulary per CLAUDE.md §6.

## 1. Assets and trust zones
| Zone | Holds | Trusted? |
|---|---|---|
| Control plane (API, worker, DB) | tenant data, vault references, ledger, audit | trusted |
| Model (any provider) | produces text/tool requests | **untrusted output**, hijackable by injected content |
| Project content (customer files, uploads, fetched URLs) | prompts' data blocks | untrusted |
| Sandbox (the runtime behind `ExecutionPort`) | customer code while it runs | **hostile**; no platform secrets |
| Artifact store / hosting node (`DeploymentPort`) | build outputs, live sites | semi-trusted (customer content, served to the internet) |

Attacker goals: (A1) run code outside the sandbox / on the control plane; (A2) read another tenant's data or platform secrets; (A3) spend money or deploy without a human; (A4) exfiltrate data over the network or DNS; (A5) tamper with audit/billing; (A6) persist (symlink, lifecycle script, config file); (A7) deny service (fork bomb, huge output, endless loops, budget exhaustion).

## 2. ExecutionPort (`request(ExecRequest) → ExecDecision`, `run(decision, ctx) → ExecutionOutcome`)
Existing core: `packages/domain/src/ai/execution-gateway/index.ts` (policy), `apps/api/src/modules/appbuilder/internal/sandbox/**` (runtime port, egress, paths, escape suite).
| # | Threat | Required control | Today | Evidence / gap |
|---|---|---|---|---|
| E1 | Model sends its own argv/env/cwd/shell | closed profile catalogue; any other member refused by name | enforced in policy | `qa-exec-gateway.int.spec.ts` (15 members, params, env copy) PASS |
| E2 | Prototype-chain / odd profile names | own-property lookup | **throws** TypeError | DEFECT-1 (open) |
| E3 | `run-script` smuggles a command (`; rm`, `$()`, flags, lifecycle scripts) | name regex + deny list + must be declared in package.json + human approval | enforced in policy | 25 cases PASS. Residual: a *declared* script (and `pre<name>`/`post<name>` hooks npm runs implicitly, and `.npmrc`/`package.json` config such as `script-shell`, `node-options`) is arbitrary customer code by design → the sandbox, not the policy, is the boundary (see E8) |
| E4 | Tenant/run confusion (decision for org A executed with run of org B) | identity from verified context, compared to the request | enforced | PASS |
| E5 | Gate opens by accident | closed gate, 5 conditions, production needs D-42 | enforced; default closed | PASS; the gate input must be built from evidence, not request data (wiring is Session 04's) — **NOT VERIFIED until wired** |
| E6 | Control plane follows a path the sandbox controls (symlink, hard link, `..`) → read/write outside the workspace | realpath/lstat confinement on every control-plane file op | lexical only | DEFECT-5 (open); escape suite lacks SYM-* attempts |
| E7 | Egress from sandbox: public internet, metadata, private ranges, DNS tunnel, redirect to metadata, rebinding | default deny; exact-host allow list; resolved-address check; pinned connect; every hop re-decided; filtered DNS | policy enforced (pure); proxy enforcement is part of the real runtime | `qa-ssrf-egress.int.spec.ts` PASS (177) + DEFECT-3 (SIIT/100::/64 gap). **The proxy/firewall that applies the policy does not exist yet: NOT VERIFIED** |
| E8 | Escape from the runtime (kernel, container, mounts, procfs, docker socket) | verified isolating runtime (gVisor/Firecracker/Kata on dedicated nodes), escape suite 100 % BLOCKED, secrets absent | only mock and `local-dev` (`isolation:'none'`); D-21 open | **BLOCKED (D-21, HG-10-02)**; nothing may be called verified |
| E9 | Platform secrets or canaries inside the sandbox (env, files, metadata) | scrubbed fixed env, no mounted secrets, canary files detected on exit | fixed env in the policy (`EXEC_ENV`); canary detection in `canary.ts` | PASS on policy; runtime part NOT VERIFIED |
| E10 | Resource exhaustion (CPU, memory, pids, disk, output, time) | limits per profile, kill on wall clock, output cap, quota per org, slot limit | limits defined in the catalogue; enforcement is the runtime's | NOT VERIFIED on a real runtime; dev runner has a wall-clock kill and an output cap only |
| E11 | Result poisoning: stdout/stderr fed back to the model as instructions | outcome enters the prompt only inside an untrusted DATA block with a random fence; truncated; secret-scanned both ways | data block + `scanForSecrets` exist (`untrusted.ts`, gateway step 1) | the exec result path is not built yet; test required when Session 05 wires `BuildPort` into the loop |
| E12 | Unattributed or unlogged execution | audit event per request/decision/outcome (refusals included), trace id, metering event per billable second | not wired | required test: refusal reasons are audited (DEFECT-1 shows a throw skips that) |
| E13 | Non-human approval of an exec profile with `approval:'human'` | approver = session user with permission | the approval engine (`APPROVAL_POLICY`) is correct; the two legacy approval routes are not | DEFECT-4, DEFECT-6 |
| E14 | Kill switch / feature flag | `ai.agent.exec_tools` default off, kill switch refuses new runs and stops running ones | flag name only | NOT VERIFIED |

## 3. BuildPort (`build(BuildRequest) → BuildResult`, built on `ExecutionPort`)
| # | Threat | Control | Status |
|---|---|---|---|
| B1 | `projectId`/`versionId` of another tenant | org from verified auth; RLS on project/version read; request org == context org | covered for the data layer by RLS tests; port itself not built: required cross-tenant test at wiring |
| B2 | Build profile escalates (`typecheck` → `run-script`) | `profile` is a closed enum mapped through `decideExec` | policy PASS |
| B3 | Build writes outside the workspace / artifact path traversal | artifacts listed by workspace-relative path, size and sha256; `ArtifactRef.path` re-validated with `checkPath` on ingest; confinement per E6 | `checkPath` PASS (escape suite PT-*); symlink gap DEFECT-5 |
| B4 | Poisoned dependency install (`install-deps`) | `npm ci --ignore-scripts`, registry-only egress to the platform mirror, lockfile integrity, human approval | policy PASS; the mirror does not exist: NOT VERIFIED |
| B5 | Build logs leak secrets or PII | `redactSecrets` on every log line before storage and before the model sees it | function exists; wiring test required |
| B6 | Log/artifact growth DoS | caps, retention | NOT VERIFIED |

## 4. ArtifactRef (`{id, path, bytes, sha256, createdAt}`)
Integrity: `sha256` computed by the control plane after copy-out, never taken from the sandbox; verified again before deploy (`artifactHash` in the publisher port). Confidentiality: artifact rows carry `org_id` and RLS (migration rule; `pnpm db:check` PASS on baseline). Path: workspace-relative, `checkPath` clean. Threat: a sandbox-supplied `sha256` or `bytes` trusted for billing or deploy. Required test at wiring: tampered artifact → deploy refused.

## 5. DeploymentPort (= `SitePublisherPort`, `apps/api/src/modules/deploy`)
| # | Threat | Control | Today |
|---|---|---|---|
| D1 | Publish without a human | approval bound to exact project version + target + environment, decided by a **human** with the approval permission, single use, expiring | hash binding, expiry, single use and tenant checks PASS; the *human* part FAILS: **DEFECT-4** (API key and requester self-confirm) |
| D2 | Wrong tenant/site | site and project looked up under RLS; another org's id = 404 | PASS (`qa-deploy-approval.int.spec.ts`) |
| D3 | Residency | `assertResidency` before staging | enforced (code); covered by existing tests |
| D4 | Real node publish | needs HG-05/06; publisher is `UnavailableSitePublisher` in production | unchanged; the in-memory fake is the only implementation: **NOT VERIFIED** for any real node |
| D5 | Rollback without approval | rollback restores a previously approved artifact | by design today (reuses `approval_id`); owner to decide if `production_rollback` approval is required (DEFECT-4 §3) |
| D6 | Smoke check abused as SSRF probe | smoke targets only the staged/live URL of the site, paths from the artifact | to re-verify when Session 06 changes the smoke code |
| D7 | Deploy of content with secrets | `scanSecrets` on files before artifact build (`paths.ts`), PT-SECRET escape-suite attempts | PASS (escape suite) |

## 6. Provider probe and benchmark runner (Sessions 02, 03)
- P1 live call without approval: gate `AI_LIVE_PROVIDERS` (empty by default, forced empty in production), `AI_PROBE_APPROVALS` fail closed; tests `capability-evidence.int.spec.ts`. Static review: PASS. No live call was made by QA.
- P2 key custody: keys typed by an admin go to the sealed secret store, never to DB/log/audit/response; refused in production until D-12. Static review: PASS (`provider.service.ts` `setCredential`). Dev exemptions for `mock-*`/`local-*` codes are refused when `AI_LOCAL_REFERENCE` is off or in production (`provider.service.ts:248`). PASS.
- P3 two-person rule for enabling a real provider: enforced (`enable`). Static review: PASS.
- P4 benchmark runner spending money or reading customer content: golden tasks are synthetic; replay is offline; any live run needs a spend budget + D9. Re-audit when Session 03 merges.

## 7. Cross-cutting
| Control | Result |
|---|---|
| Deny-by-default global guard; admin realm only for `/v1/admin/**` | PASS (`qa-route-inventory`, `qa-authz-matrix`) |
| Unauthenticated surface pinned (34 routes) | PASS, gate in place |
| RBAC: denied role → 403, non-member → 404, no session → 401 on every organization route | PASS (live matrix) |
| Tenant isolation at the DB: RLS on every tenant table | PASS (`pnpm db:check` on my migrated DB) |
| Data classification complete (3,368 columns, 268 tables) | PASS |
| ROPA covers every adapter kind and class in use; residency hooks present | PASS |
| Migrations reversible for the AI range 1800-1870 | PASS (up/down/up, identical schema) |
| Prompt-injection | existing suite is strong (obedient mock model, 15 phrases × 4 vectors); it proves the platform holds around a hijackable model, **not** any real model's resistance |
| Budget race | existing 1,000-call property test; reservation settle is idempotent and records spend even when a hold was swept (static review). Config invariant not enforced: `callTimeoutMs × attemptsPerCandidate` should stay below `reservationTtlSeconds` (defaults 60 s × 2 < 300 s) |
