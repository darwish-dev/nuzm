# CONTRACT-P3-S02-3 — new workspace package `@nuzm/runtime-agent`, lockfile, root scripts (request to the Master, from P3-S02)

Status: REQUEST. `packages/runtime-agent` (the node agent) is a new package. It is matched by the existing `packages/*` workspace glob but is not yet in `pnpm-lock.yaml`.

1. **Lockfile.** Run `pnpm install` on the integration tree to register `@nuzm/runtime-agent` (`dependencies: @nuzm/domain workspace:*`; `devDependencies`: `@types/node ^22.20.5`, `typescript 5.9.3`, `vitest ^5.1.0`: the same versions `@nuzm/domain` uses, no new third-party package). The agent itself has NO runtime dependency outside Node's standard library and `@nuzm/domain`.
2. **Root `package.json` scripts** (requested names; the commands work today with `npx tsx`):
   - `"sandbox:escape-suite": "pnpm --filter @nuzm/api exec tsx src/modules/appbuilder/internal/sandbox/escape-runner.cli.ts"` (CONTRACT-04-3 asked for this; the CLI now also takes `--connection`/`--secrets-dir` for https endpoints);
   - `"sandbox:qualify": "pnpm --filter @nuzm/api exec tsx src/modules/execution/qualification.cli.ts"` (subcommands `conformance`, `sign`, `negative`, `evidence`).
3. **Turbo.** No change needed (the package has `build`, `typecheck`, `test` scripts like `@nuzm/domain`). `pnpm test` stays DB-free and executes nothing: every agent test uses a recording command runner or a simulated launcher.
4. **CI.** `pnpm verify` should include the new package's `typecheck` and `test` through the existing filters. The mTLS tests call the system `openssl` to make a throw-away CA and skip themselves if it is missing.
5. **Module boundaries (lint).** `apps/api/src/modules/execution/**` imports only `@nuzm/domain` and `@nuzm/platform`. `escape-runner.cli.ts` imports `../../../execution` (its public index). `packages/runtime-agent` imports only the `@nuzm/domain` barrel.
6. **Not requested.** No OpenAPI/SDK change (the node protocol is internal, agent ↔ control plane), no `messages.ts`, no `app.module.ts` registration.
