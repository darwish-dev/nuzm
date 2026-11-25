# Main integration and local runtime report

Date: 2026-11-25 · Local `main` only: **nothing was pushed** (GitHub `main` is still `281c094b`) and **nothing was deployed**.

## 1. Result
| Item | Value |
|---|---|
| Final local `main` | the commit that adds this report, on top of `72310ea5` (launcher fixes) and merge `a7e7cb04` |
| Verified tree | `a7e7cb04` has the same tree as `d198e6cf`, which differs from fully tested `ac186dc6` only by two documents |
| `main` before | `281c094b`, kept as tag `pre-integration-main-2026-11-25` and branch `backup/main-pre-integration-2026-11-25` |
| Phase 3 before | branch `backup/phase3-pre-integration-2026-11-25` (`eef3861a`) |

Status words follow CLAUDE.md §6.

## 2. What was integrated
`integration/unified-main` = Phase 3 (`integration/phase3`, which already contains every Phase 2 and Phase 3 session branch) + `main` `281c094b` (hosting line, CI and deploy tooling) + `74b6477d` (code-view race, cross-tenant fixtures, run-cancel race) + the fixes below. 53 local branches are fully contained. The 14 that are not, and why, are in [UNMERGED-BRANCHES-2026-11-25](reports/UNMERGED-BRANCHES-2026-11-25.md); deferred work is in [the backlog](backlog/LOCAL-DELIVERY-DEFERRED.md). Every screen and file of the old `main` is present (0 lost; 247 routes).

**Conflicts resolved:** three generated API-doc files (regenerated, `docs:check` passes); `ai/internal/run.service.ts` (kept the stricter cancel check from `74b6477d`).

**Defects found and fixed during this integration**
| Commit | Fix |
|---|---|
| `2572bd39` | The evidence matrix, harness and approvals checker waited for `ADR-067` (now the HestiaCP decision) instead of `ADR-069`: an approval of the Execution Gateway would never have registered. |
| `63ecae60` | A wrong seal key made the field cipher **overwrite** the stored field-encryption key (reproduced); a missing seal key next to a full vault created a new one. Both now fail safely; nothing is ever replaced. |
| `924890ec` | `AI_MAX_OUTPUT_TOKENS` and `AI_MAX_REPAIR_ATTEMPTS` (only lower spending; a malformed value stops the process). |
| `ef48cb6a`, `e6fe0c79` | A database connection that broke while a transaction held it **crashed the API** (this caused 74 browser-test failures). Now only that transaction fails; tested for integrity, pool recovery and isolation, and live under load (150 connections cut, no restart). |
| `1d0421da` | Audit entries read as one word (`tenancyworkspace created`). |
| `1ef98d89`, `ac186dc6` | Durable E2E runner; health checks that accept only each console's exact redirects and a real sign-in page. |
| `72310ea5` | Launcher: stopped silently on a free port, and built the consoles for API `:4000` (another project on this machine). |

## 3. Verification (actual results)
| Check | Result | Revision |
|---|---|---|
| `pnpm verify` (lint, types, 6,354 unit tests, build, spec, SDK, docs, secrets, ZATCA, claims, testenv) | **PASS** at the time, **corrected 2026-11-26**: the database unit tests were a Turbo cache replay; a real run failed one stale test (fixed; see [template validation report](reports/TEMPLATE-AI-VALIDATION-2026-11-26.md) §7) | `ac186dc6` |
| Migrations from an empty database, RLS check, classification, ROPA, residency hooks | **PASS** | `ac186dc6` |
| Integration: db 102, platform 38, worker 92, API 3,069 passed (6 skipped) | **PASS** | `ac186dc6` |
| Browser E2E, Arabic and English: 64 files, **114 of 114**, 0 retries, 189/189 health checks | **PASS** | `ac186dc6` |
| `main` after merge: install, build (31 tasks), launcher health (8 checks) | **PASS** | `72310ea5` |

## 4. Database
- Original `nuzm_recovered` (:54329): **never modified**; all 306 tables identical to the backup when checked after the launch.
- Backup: `.dev-data/backups/nuzm_recovered-20261125/` (dump, roles without passwords, fingerprints, SHA256SUMS).
- Platform database `nuzm_local` (:54390): restored from that dump (306 tables identical), migrated 110 → 122 (highest 2382). Every original column of users, organizations, workspaces, projects, providers and the rest is unchanged; the running platform's background jobs have since added audit, metering, alert and backup rows and updated registrar check times, alert states and audit chain heads.
- `nuzm_smoke` (:54390): a disposable copy used only for the live tests.

## 5. Encryption and secrets
- The main folder's vault now uses the seal key that sealed this data (owner-approved copy; the previous vault is backed up in `.dev-data/backups/vault-main-before-keycopy-20261125/`).
- With the application's own code: the Claude key and both two-factor secrets open; field data 68 of 70 open. **Two chat messages (2026-11-20) open with no key on this machine; they are preserved unchanged.**
- A stray, unignored key copy was moved to `~/.nuzm-secure-backups/vault-keys-20261125/` (verified first). Shared ignore rules now cover every worktree. Searched all git objects for 549 real secret values: **none found**; nothing staged.
- The live-test run enrolled two-factor for the disposable test staff account, which added one entry to the main vault.

## 6. Claude (owner-authorized, 2026-11-25)
| Test | Result |
|---|---|
| Connection test, Admin Dashboard → API → provider manager → Anthropic (model listing, no prompt) | **LIVE-VERIFIED**: HTTP 200, the key sees 14 models; audited once |
| One generation: customer console → API → AI engine (gateway, residency, budget) → Claude | **LIVE-VERIFIED**: run `01a21462-2973-7456-8964-5146eea9ba62` succeeded; `claude-opus-5-5`; 980 input and 266 output tokens (provider-reported, not estimated); 3,261 ms model latency, 4.2 s end to end; one request, no correction, no fallback; recorded cost USD 0.01 (list price about USD 0.009) |

Settings for both: only Claude allowed, one attempt, no fallback, no correction requests, 512 output tokens at most, no background jobs, mock model off, disposable database. The synthetic prompt asked for an HTML snippet; the chat assistant answered in prose and offered to add the heading in the builder instead. **That proves the real route, not code-generation quality.** The platform now runs with live calls **off**.

## 7. Running the platform
```
cd ~/Projects/nuzm
pnpm platform:start                                       # start (builds, checks, launches)
NUZM_PLATFORM_LIVE_PROVIDERS=claude pnpm platform:start   # the same with REAL, billed Claude calls allowed
pnpm platform:status | pnpm platform:health
scripts/local-platform.sh stop                            # stop everything it started
scripts/local-platform.sh logs api|worker|web|admin|postgres
```

| Service | Address |
|---|---|
| Customer console | http://127.0.0.1:3300/login (`?lang=en` for English) |
| Admin console | http://127.0.0.1:3301/login |
| API | http://127.0.0.1:4300 (health `/healthz`) |
| Dev sign-in service | http://127.0.0.1:4310 |
| PostgreSQL | 127.0.0.1:54390, database `nuzm_local` |

Sign in with your own accounts as before. Redis is not started: no code connects to it.

## 8. Limitations and what still needs the owner
- **Building and previewing code Claude changed** is BLOCKED (D-21, HG-10-02, ADR-069): Claude's template edits are saved on the project's AI branch, but they cannot be built or previewed until an isolated sandbox exists (backlog DL-001, DL-002).
- Template activation needs **two approvals from admins other than the uploader**; the console cannot mark an upload first-party (DL-040). The preserved data has two platform admins, so a third is needed.
- Template features are off by default per organization: `knowledge.customer_templates`, `knowledge.generation`, plus `app_builder.enabled`.
- With live calls on, one template adaptation can make up to 3 billed requests of up to 16,000 output tokens each.
- Owner approvals D2–D9, D-21, HG-10-02, ADR-069 and the rest are still unrecorded; real hosting, domains, payments and mobile builds remain SIMULATED or BLOCKED as before.
- Deferred by owner decision: compliance adaptation, domain and e-mail redesign, in-console documentation, older dashboard design, desktop sign-in change (needs security review), sandbox and preview. The fixed two-factor shortcut will not be merged.
