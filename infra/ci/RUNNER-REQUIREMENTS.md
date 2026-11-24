# Remote CI and build-runner requirements

Status: **PREPARED, NOT ACTIVATED, NOT VERIFIED.** No git remote exists (D-01) and no runner has been provisioned. This file and `.github/workflows/ci-parallel.yml` are the configuration to switch on when the owner provides a remote and runners. The local workstation (macOS 13, 4 CPUs, 8 GB) cannot run eight parallel sessions plus full regressions: on 2026-11-24 the load average passed 600 and swap reached 5 of 6 GB, which made the regression invalid. Local mitigation (done): `scripts/heavy-slot.sh` (fair, resource-aware), `scripts/resource-status.sh`, `scripts/session-env.sh` (per-session database, ports, caches, scratch space).

## Runner classes

| Label                             | Purpose                                                                | Minimum                                                                                                                                                                                             | Notes                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self-hosted, linux, nuzm-build`  | static checks, DB/API integration shards, security suites, browser E2E | **8 vCPU, 16 GB RAM, 100 GB SSD**, Linux x86_64 (Ubuntu LTS), Docker (for Postgres 16 services) or a local Postgres 16, Node 22, pnpm 10.34.9, Chrome/Chromium via `playwright install --with-deps` | one job per runner process; 4 shards x api-integration + 2 e2e + database + security run in parallel on 4+ runners, or sequentially on one         |
| `self-hosted, linux, nuzm-mobile` | Android/Flutter builds of generated projects                           | **8 vCPU, 16 GB, 150 GB SSD**, Flutter 3.35.x, JDK 17, Android SDK (accepted licenses), Gradle caches                                                                                               | **disposable**: re-imaged after each job; no secrets, no cloud credentials, network limited to the registry mirror; this is the B-Android approval |
| `self-hosted, macos, nuzm-xcode`  | iOS no-codesign build and simulator validation (T4)                    | an Apple-silicon or Intel Mac with **full Xcode** compatible with its macOS, CocoaPods, Flutter                                                                                                     | owner-provided (B-iOS); a dedicated non-admin build user; no Apple credentials needed                                                              |
| (later) runtime node              | real isolated execution qualification (P3-S02)                         | dedicated bare-metal Linux, see `docs/phase3/OWNER-SETUP-CHECKLIST.md` section C                                                                                                                    | not a CI runner: the CI job only drives the qualification procedure                                                                                |

## Isolation rules (all runners)

- one database cluster per job (service container or `initdb` in the workspace), never shared across jobs; throw-away databases per spec file already exist (template-DB reset);
- ports are picked free per job by `scripts/e2e-isolated.sh`; no fixed ports;
- build caches are per runner (`TURBO_CACHE_DIR`, pnpm store); a remote cache is optional and must be read-only for forks (cache poisoning);
- no job holds provider keys, vault material or deployment credentials; live qualification never runs in CI;
- artifacts: E2E traces/screenshots only; no logs containing prompts or customer data.

## Sharding and scheduling

- `vitest --shard=i/4` splits the apps/api integration files; the db/platform/worker packages run in the `database` job; E2E runs `ar` and `en` as separate jobs;
- `concurrency.cancel-in-progress` prevents stacked runs; on a single small runner use `heavy-slot.sh --weight 2` around any job step instead.

## Activation checklist (owner)

1. provide a git remote (decision to leave D-01) and runner machines or a hosted-runner plan, with an estimated monthly cost from the provider you choose (not estimated here);
2. register runners with the labels above; 3. enable `ci.yml` (verify) first, then `ci-parallel.yml`; 4. only then consider `pnpm verify:full` removal from developer workflows. Until then every claim of "CI passes" is false: the evidence is the local serialized regression recorded in `docs/parallel/PHASE-2-DELIVERY-REPORT.md`.
