# Internal scans: plan and results

> INTERNAL, 2026-11-18. NOT independent (HG-12-01 / D-28 BLOCKED). A clean internal scan is not a substitute for the vendor test. Anything the author did not run is `NOT RUN`; nothing below is inferred.

Gate: AC-M12-10 needs "0 open critical/high from SAST/DAST/dependency/container scans". Current position: see the results table. Findings go to [pen-test-remediation-tracker.md](pen-test-remediation-tracker.md) with source `internal scan` or `DAST`.

## 1. Plan

| Scan | Purpose | Repository command / tool (actual) | Needs |
|---|---|---|---|
| SAST | Code-level flaws | No dedicated SAST tool is configured or selected (owner/tooling decision). Available today: `pnpm lint` (`eslint .` with `@eslint/js` + `typescript-eslint` recommended, plus `prettier --check`), `pnpm typecheck` (strict). The ESLint config contains **no security rules** (no security plugin); it enforces `no-explicit-any` and module-boundary imports (`eslint.config.mjs`) | Tool selection; optional extra ESLint rules for template-literal SQL, `child_process`, `eval` |
| Dependency (SCA) | Known-vulnerable packages | `pnpm audit --prod` (CI: `pnpm audit --prod --audit-level=high`, `.github/workflows/ci.yml`); optionally `pnpm audit` for dev dependencies | Network to the package registry |
| Container | Image vulnerabilities and base-image hygiene | None: the repository has **no Dockerfile or container image** (`infra/docker/README.md` is a skeleton) | An image to scan; tool selection |
| Secret | Credentials in the tree/history | `pnpm scan:secrets` (`scripts/scan-secrets.ts`: 8 regex rules incl. private keys, AWS/GitHub/Slack tokens, hardcoded passwords, Luhn-valid card numbers). It is described in its header as a placeholder until a dedicated scanner is wired in CI; it scans the working tree only | A dedicated scanner over full git history (tool selection open) |
| IaC | Misconfiguration in infrastructure code | None: no Terraform, Helm, docker-compose or other IaC exists in the repo; only `.github/workflows/ci.yml` | IaC to review (S57/D-15) |
| DAST | Runtime vulnerabilities | None configured | A staging environment: `BLOCKED (no staging; HG-05-xx, D-15)` |
| Contract/ownership | Guard rails that double as security checks | `pnpm spec:lint`, `pnpm spec:drift`, `pnpm sdk:check`, `pnpm db:test-rls` (RLS forced + policy per tenant table), `pnpm compliance:claims-guard`, `pnpm zatca:guard`, `pnpm compliance:classification-coverage` | Some need the migrated local database |
| Tenant sweep | Cross-tenant 2xx | `pnpm --filter @nuzm/api test:integration` includes `apps/api/src/modules/tenancy/tenant-sweep.int.spec.ts` (see [tenant-isolation-sweep.md](tenant-isolation-sweep.md)) | Local services running |

Run order for the final assessment: lint/typecheck, SCA, secrets, spec/RLS guards, tenant sweep, then DAST on staging once it exists. Re-run after every fix that closes a finding; record command, date, commit and summarised output.

## 2. Results

Date of every run below: 2026-11-18. Worktree: `/Users/elaf/Projects/nuzm/.claude/worktrees/m12-hardening-4cc95e`, branch `claude/m12-hardening-4cc95e`. Commit at the time: 676df74 plus uncommitted M12 work.

| Scan | Exact command | Result summary | Status |
|---|---|---|---|
| Secret | `pnpm scan:secrets` | `secret scan OK: 1389 files, 8 rules, 0 hits.` exit 0 | PASS for the working tree with these 8 rules; history and entropy-based detection NOT RUN |
| Dependency (production) | `pnpm audit --prod --audit-level=high` | exit 0: no vulnerabilities at or above high | PASS for the CI threshold |
| Dependency (production, all severities) | `pnpm audit --prod` | exit 1: `1 vulnerabilities found`, `Severity: 1 moderate`: advisory GHSA-8988-4f7v-96qf, "OpenTelemetry Core: Unbounded memory allocation in W3C Baggage propagation", package `@opentelemetry/core` vulnerable `<2.8.0`, patched `>=2.8.0`, path `packages__telemetry > @opentelemetry/exporter-trace-otlp-http > @opentelemetry/core` | FAIL against a "no open findings" bar; moderate, below the critical/high gate. Open item for the tracker (see 3). Not fixed here (docs-only task) |
| Dependency (all including dev) | `pnpm audit` | not run | NOT RUN |
| SAST | none selected | not run | NOT RUN (tool not selected) |
| Lint / typecheck | `pnpm lint`, `pnpm typecheck` | not run by this pack; see `M12-report.md` for `pnpm verify` | NOT RUN here |
| Container | none | no image exists | NOT RUN (no images; N/A until built) |
| IaC | none | no IaC files exist; CI workflow observed only: actions pinned by version tag, not commit SHA; no `permissions:` block in `.github/workflows/ci.yml`; workflow has never run (no remote, D-01) | NOT RUN (nothing to scan); observations to review when CI exists |
| DAST | none | no environment | BLOCKED (no staging; HG-05-xx, D-15) |
| Tenant sweep | see above | see `M12-report.md` | filled by the parent |
| Spec/RLS/claims guards | `pnpm spec:lint`, `pnpm spec:drift`, `pnpm db:test-rls`, `pnpm compliance:claims-guard`, `pnpm zatca:guard` | not run by this pack | NOT RUN here; see `M12-report.md` |

## 3. Findings raised by these scans

| Tracker ID | Finding | Severity | Notes |
|---|---|---|---|
| (to be created by the owner/parent when the tracker is opened) | `@opentelemetry/core` < 2.8.0 reachable through `@nuzm/telemetry` (GHSA-8988-4f7v-96qf) | moderate (as reported by the audit tool) | Fix = dependency bump in `packages/telemetry`; effect depends on whether W3C Baggage propagation is enabled in the exporter path (not analysed). Proposed SLA 30 days (policy table in the tracker) |

The tracker file itself stays empty of findings until the parent records this one; this pack does not pre-populate it.

## 4. Gaps that block "internal assessment complete"

1. No SAST tool selected or run.
2. No container or IaC artefacts exist; revisit when S57/D-15 produce them.
3. DAST impossible without staging.
4. Secret scanning limited to a regex scanner over the working tree.
5. Dev-dependency audit not run; no SBOM generated.
6. CI has never run, so none of the above is automated.
