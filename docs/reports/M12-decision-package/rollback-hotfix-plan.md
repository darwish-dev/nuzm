# Rollback and hotfix plan (M12 decision package)

> **PROPOSAL.** Prepared by the agent 2026-11-18 for the owner to accept, amend or reject. Nothing here has been exercised: no production environment, staging environment, remote repository or CI exists (D-01 decided "local only" 2026-11-15; HG-01-01 pending). Every step is a proposal until the owner records approval. This plan contains no recommendation to launch.

## 1. Principles (proposal)

1. Prefer the more restrictive, reversible choice (CLAUDE.md §11): turn a capability off before rolling code back; roll code back before touching data.
2. Never delete or rewrite financial, audit, compliance or ledger records to "undo" a change. Corrections are reversing entries (CLAUDE.md §4).
3. Every action in production is performed by a human with the proper role, with step-up and a second approver where the runbook says so. The agent never changes production flags, data or history.
4. Record the change, the approver, the time (UTC) and the evidence in the incident record (`docs/runbooks/incident-response.md`).

## 2. Migrations: forward-only with documented reversal (proposal, from docs/05 and the reports)

| Rule | Source |
|---|---|
| Production migrations are **forward-only**. Each migration ships a `.down.sql` for dev/staging only; in production the rollback is a **forward fix** or a **restore from backup**. | `docs/05-database-ownership-and-migrations.md`; gate reviews M01-M04 ("production forward-fix") |
| Destructive changes use expand, then backfill, then contract across at least two releases. | `docs/05` |
| Financial, ledger, invoice, payment, refund, ZATCA, reconciliation, audit and compliance tables are never dropped in a production profile; their down scripts must not be run in production. The audit down-migration drops the schema. | M01, M02, M03, M04 gate reviews |
| M12 migrations present in this worktree: `identity/1710__identity__sso_scim`, `audit/1720__audit__access_reviews`, `compliance/1730__compliance__policy_versions`, `ops/1740__ops__incidents_alerts_dr_slo_launch`, `cloud/1750__cloud__technical_reconciliation_subjects` (each with a `.down.sql`). `identity/1700__identity__credentials` belongs to the customer sign-in work. | `packages/db/migrations/` |
| Restore from backup is the production reversal of last resort. It is **not exercised**: `docs/runbooks/dr-restore.md` and `db-restore.md` are drafts, and no restore drill is recorded (BR-008). | `blocked-register.md` |

Proposed pre-release check for any migration (owner to confirm): the reversal note exists; the change is additive or follows expand/contract; the previous application version still runs against the new schema; a backup taken before the migration has been restore-tested at least once on non-production data.

## 3. Feature flags: default off (proposal)

- Every new capability ships behind a flag that is OFF until acceptance (CLAUDE.md §4). Examples visible in the code and reports: `hosting.enabled` (default OFF, gates every customer hosting route), `domains.enabled`, `enterprise.sso`, `enterprise.scim`.
- Flags live in `platform.feature_flags`. A flag can be global or set for one organization; an organization-level row overrides the global one (`apps/api/src/modules/enterprise/flags.ts`).
- The admin API is `PUT /v1/admin/feature-flags` with body `{key, scope: global|org, orgId?, value}` (platform permission `admin:flags:manage`, admin-realm session with MFA, audited with before/after) and `GET /v1/admin/feature-flags` to list (`spec/openapi/openapi.yaml`).
- Rollback by flag is the first move for any customer-facing capability.

### 3.1 Disable enterprise SSO and SCIM for one organization (proposal)

| Step | Action | Notes |
|---|---|---|
| 1 | Verify the request and the person (two-person rule, as in `docs/runbooks/sso-lockout.md`). | Staff never lift or change enforcement on an unauthenticated request. |
| 2 | Set the organization-level flag `enterprise.sso` to false: `PUT /v1/admin/feature-flags` with `{key: "enterprise.sso", scope: "org", orgId: "<ORG_ID>", value: false}`. | An org-level row overrides the global value. Enabled means `value` is `true` or `{enabled: true}`; anything else is off. |
| 3 | Set the organization-level flag `enterprise.scim` to false in the same way (`key: "enterprise.scim"`). | |
| 4 | Verify: with the flag off the SSO connection endpoints answer `404 not_found` and SCIM requests answer `404` ("SCIM is not enabled for this organization") (code in `sso-connections.controller.ts`, `scim/scim.controller.ts`). Confirm the audit event for the flag change. | Behaviour confirmed by reading the code; not exercised in a running environment. |
| 5 | Check lock-out risk before and after: if the organization had password sign-in disabled by SSO enforcement, follow `docs/runbooks/sso-lockout.md` first. The author did not verify what a flag-off does to an already-enforced organization's sign-in path. The SSO sign-in endpoints are not yet approved (`M12-spec-change-requests.md`, SCR-M12-05), so this must be tested before it is relied on. | NOT VERIFIED |
| 6 | To disable for all organizations: set the global flag false and remove org-level true overrides. Prefer per-organization changes. | Global change needs the owner (`sso-lockout.md` step 5: do not disable enforcement globally). |

`ENTERPRISE_ENABLED=true` forces both flags on for local development and tests and is ignored when `NODE_ENV=production`; it must never be set in production.

### 3.2 Other switches (proposal)

| Switch | Effect | Source |
|---|---|---|
| `OPS_SCHEDULER_INTERVAL_SECONDS=0` (default) | Ops scheduler (TR runs and sweeps) off | `apps/api/src/modules/ops/ops-scheduler.ts` |
| Billing scheduler and compliance jobs | Run in the API process and are off by default (ADR-017 PROPOSED); a production profile must enable them deliberately | M03 and M04 gate reviews |
| Provider enablement | The admin API refuses to enable a provider without accepted ADR, live probe, evidence and a second approver | M08 gate review |
| `hosting.enabled`, `domains.enabled` | Gate customer routes | M06 and M07 reports |

## 4. Application rollback (proposal)

1. Turn the affected flag off (section 3).
2. If the defect is in code that cannot be flagged off, redeploy the previous known-good application build. This requires a build artifact for the previous version; **no Dockerfile, IaC or container image exists today** (security pack README observation 6), so the mechanism is undefined and BLOCKED on the deployment decision (D-15).
3. If the previous build is incompatible with a new migration, apply a forward-fix migration (never run a production `.down.sql` on a ledger, audit, invoice, payment, ZATCA or compliance table).
4. If data is corrupted: follow `docs/runbooks/dr-restore.md`; record the exercise in `ops.recovery_exercises` (schema and service exist; no row recorded).
5. After any rollback: reconcile (`docs/runbooks/reconciliation-variance.md`), review `needs_reconcile` operations (`docs/runbooks/queue-recovery.md`), and record the incident.

## 5. Hotfix process under D-01 (local-only git) (proposal)

D-01 decided "local only for now": there is no remote, no CI and no branch protection (HG-01-01 pending). The following is a proposal that works without them and should be revised when a remote exists.

1. **Branch.** Create `hotfix/<tracker-id>-<short-name>` from the commit or tag of the running release. Never commit directly to `main`. Never force-push or rewrite history (CLAUDE.md §5: needs explicit human action).
2. **Fix.** Smallest change, with a regression test that fails before and passes after; Conventional Commit message referencing the tracker id; migrations only if unavoidable and then forward-only.
3. **Verify locally.** Run `pnpm verify` (lint, typecheck, unit, build, spec lint, spec drift, secret scan, SDK check, claims guard) and `pnpm test:integration` with local services running; run `pnpm verify:full` when the fix touches UI flows. Record exact commands and results in the hotfix note. Because CI cannot run, these local runs are the only gate; a second person re-runs them.
4. **Review and approval.** A second human reviews the diff. For critical/high security fixes the security lead sets `fixed-pending-retest` in the tracker (`pen-test-remediation-tracker.md`); critical/high retest by the vendor is the owner's action (HG-12-01).
5. **Release.** The owner approves the release in writing and records it; tag the commit (for example `release/<date>-hotfix-<id>`); deploy by the mechanism the owner defines (undefined today, section 4 item 2).
6. **Back-merge.** Merge the hotfix branch into `main` and into any open milestone branches; resolve conflicts by hand; re-run the checks.
7. **Preserve history.** Because the only copy of the repository is local, the owner should keep an off-machine copy (for example a bundle: `git bundle create`) before and after a hotfix. This is a proposal; the choice of location belongs to the owner.
8. **Communicate.** Use `docs/reports/M12-handover/communications-drafts.md` with the communications lead's approval; no cause or blame until confirmed.
9. **Review.** Post-incident review within the window the owner sets; update the register and runbooks.

## 6. What this plan does not cover

- Production hosting, deployment tooling and rollback of infrastructure (no IaC; D-15 OPEN).
- Rollback of provider-side state (instances, domains, mailboxes created at a real provider): use the provider runbooks (`provider-outage.md`, `orphan-handling.md`, `domains-reconcile.md`) and reconcile before any retry (CLAUDE.md §4). No real provider state exists today.
- Rollback of ZATCA submissions or issued invoices: corrections are credit/debit notes and reversing entries (`invoice-correction.md`, `reversing-adjustment.md`).
- M09-M11 features (in flight on other branches).

## 7. Open items for the owner

| Item | Gate |
|---|---|
| Accept, amend or reject this plan | HG-12-03 |
| Deployment mechanism and previous-build retention | D-15, HG-01-01 |
| Off-machine repository copy | D-01 |
| Test what flag-off does to an enforced organization before relying on section 3.1 | Owner / Security |
| Restore drill for the control-plane database | AC-M12-08 (BR-008) |
