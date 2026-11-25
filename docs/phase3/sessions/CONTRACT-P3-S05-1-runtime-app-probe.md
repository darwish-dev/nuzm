# CONTRACT-P3-S05-1 — runtime support for the app probe (request to the Master, for P3-S02)

From P3-S05. Needed so that the *same code* that is SIMULATED today runs for real in the qualified runtime. Nothing here changes behaviour until S02 implements it; S05 switches one constant (`PROBE_PROFILE` in `gen/probe-runner.ts`).

1. **Image**: PostgreSQL 16 server binaries (`initdb`, `pg_ctl`, `postgres`) in the sandbox rootfs, at `/usr/lib/postgresql/16/bin` (the probe also searches PATH and `/usr/local/bin`), executable by the unprivileged sandbox user (postgres refuses to run as root). No data directory, cluster or role pre-created: the probe creates a throw-away cluster inside the workspace.
2. **Profile** `app-probe` in `EXEC_PROFILES` (`packages/domain/src/ai/execution-gateway/policy.ts`): argv `npm run probe --silent` (fixed), `network: 'loopback-only'` (127.0.0.1 only; no registry, no other host), approval `none` (the script is platform-owned, byte-pinned by the static gate `platform-integrity`), limits `wallSeconds 300, memoryMb 2048, diskMb 1024, pids 256`, env = the constant `EXEC_ENV` (the probe builds the app's environment itself and inherits nothing; note `DATABASE_`/`SECRET` names are forbidden in `EXEC_ENV` on purpose and stay so).
   Interim: today the probe is started through `run-script` with script `probe` (human approval, network `none`; loopback inside the sandbox works without a network class).
3. **Lifecycle**: the workspace (and with it the ephemeral database) is destroyed when the run ends, including on kill/timeout; the cleanup evidence is recorded (this is `isolation.databaseDestroyed` + the existing cleanup record).
4. **Output screening**: the run's stdout may contain one line `NUZM_PROBE_REPORT <json>` (<= 200 KB). The screen must keep that line intact unless it matches a secret pattern (the report contains none; the platform re-screens and refuses a report with a secret).
5. **Conformance**: add a conformance case "app-probe against a synthetic generated app" to the real-runtime suite once a node exists (R3 of P3-S02).

Not requested: any change to egress/registry policy. `npm ci --ignore-scripts` (profile `install-deps`, registry-only) still runs first and produces the lockfile-verified install; the probe runs after it.
