# File ownership (a session may edit only the paths it owns; shared paths are Master-only)

| Session | Owns (create/edit) |
|---|---|
| 02 Providers | `packages/adapters/model/**`, `apps/api/src/modules/ai/**` (except gateway budget internals listed under Master), `apps/admin/components/AiProvidersPanel.tsx` and new `apps/admin/**/ai-providers*`, `docs/adapters/**`, `docs/ai-intelligence/S-AG4-*.md`, `docs/parallel/sessions/REPORT-02.md` |
| 03 Benchmarks | `packages/domain/src/ai/benchmarks/**`, `apps/api/src/modules/benchmarks/**` (new), `apps/admin/**/benchmarks*` (new), `docs/ai-intelligence/S-AG5-*.md`, `docs/parallel/sessions/REPORT-03.md` |
| 04 Sandbox | `packages/domain/src/ai/execution-gateway/**`, `apps/api/src/modules/appbuilder/internal/sandbox/**`, `apps/api/src/modules/execution/**` (new), `docs/adr/ADR-067*`, `docs/ai-intelligence/S-AG6-*.md`, `docs/security/sandbox/**` (new), `docs/parallel/sessions/REPORT-04.md` |
| 05 Builder tools | `apps/api/src/modules/appbuilder/**` (except `internal/sandbox/**`), `apps/api/src/modules/builder/**`, `packages/domain/src/ai/agent-tools/**`, `packages/domain/src/ai/agent-loop/**`, `apps/web/components/Builder*.tsx`, `apps/web/app/**/builder/**`, `docs/ai-intelligence/S-AG-builder-*.md`, `docs/parallel/sessions/REPORT-05.md` |
| 06 Deployment | `apps/api/src/modules/deploy/**`, `apps/api/src/modules/hosting/**` (deploy-related files only), `apps/web/components/*Deploy*.tsx`, `apps/web/app/**/deployments/**`, `apps/admin/**/deploy*`, `e2e/tests/10-app-builder.spec.ts` (deploy leg only), `e2e/tests/fixtures/deploy*.ts` (new), `docs/parallel/sessions/REPORT-06.md` |
| 07 QA | `e2e/tests/**` (except files named above), `e2e/tests/fixtures/qa-*.ts` (new), `apps/**/**/*.int.spec.ts` only when NEW files named `qa-*.int.spec.ts`, `docs/security/**` (except `sandbox/`), `docs/parallel/sessions/REPORT-07.md` |
| 01 Master (only) | `docs/parallel/**` (except REPORT-0N), `spec/**` (OpenAPI, ownership manifest), `packages/sdk/**`, `packages/contracts/**`, `packages/db/migrations/**` numbering allocation and `spec/db/ownership.yaml`, `packages/i18n/src/messages.ts` (see below), `CLAUDE.md`, `package.json`/`pnpm-lock.yaml`/`turbo.json`, CI config, `scripts/**`, root `e2e/playwright.config.ts`, `e2e/tests/helpers.ts`, `e2e/tests/reset.ts`, `apps/api/src/common/**`, `apps/api/src/app.module.ts` |

## Shared files that several sessions need
- **OpenAPI / SDK / ownership manifest:** a worker writes its change as a patch file `docs/parallel/sessions/CONTRACT-<n>-<name>.md` (+ proposed YAML snippet) and the Master applies it to `spec/` and regenerates the SDK. Workers do not edit `spec/**`.
- **Migrations:** a worker writes migrations only inside its allocated id range, in its module's migration folder, with a `.down.sql`; it adds the table rows to its patch for `spec/db/ownership.yaml` (Master applies).
- **i18n messages:** new keys go into a new file `packages/i18n/src/<area>-messages-<session>.ts` only if the package already supports merging; otherwise the worker appends a clearly delimited block at the END of `messages.ts` for both `ar` and `en` and the Master resolves textual conflicts when merging. Keys are prefixed with the session's area (`prov.`, `bench.`, `exec.`, `bt.`, `dep.`).
- **Module registration** (`app.module.ts`) and other single-line registrations: the Master merges them; the worker states the line in its report.
Any edit outside your row is a conflict to be reverted by the Master on merge.
