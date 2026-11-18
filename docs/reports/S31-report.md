# S31 report — hosting linkage, renewals, reconciliation, UI, acceptance

Vendor and M06 results **NOT VERIFIED** (HG-07-01; M06 absent: the hosting site is an in-memory fake).

## A. Findings and assumptions
* `DnsLinkagePort` is `DnsLinkageService` (exported by the module). M06's `POST /v1/hosting/sites/{id}/domains` does not exist; the UI uses two **proposed additions** (owner approval pending, like the S12d admin reads): `POST/GET /v1/domains/{id}/hosting-links` (**M07-ADD-2**) and the admin reads `GET /v1/admin/domains`, `GET /v1/admin/domains/{id}` (**M07-ADD-1**, needed by UI-M07-10/12). They are marked as proposals in the OpenAPI descriptions.
* Cost reconciliation: registrar statements are **not stored as cost records** (that would accrue the cost twice). The order cost is captured exactly once at confirmation; the statement becomes **RC-04 bill lines** through a new finrec `BillSourceRegistry` (additive), matched to orders by domain name + action. The prompt says "ingest into `metering.provider_cost_records`": deviation recorded. D-31 (threshold) is open: any non-zero variance is a break.
* Scheduler: `DomainJobs.runDaily()` (+ the sweep) runs from a one-hour timer when `DOMAINS_JOBS_ENABLED=true`; there is no worker/cron host yet (M12). Reminder de-duplication uses the audit log (append-only) as the record.
* Renewal "dunning link" is the static route `/billing/overdue` (M03 owns the real link).

## B. Changed files
`domains/internal/{linkage,renewal,cost-recon,admin-read,reconciler}.service.ts`, `finrec/internal/bill-sources.ts`, controllers, web screens (`apps/web/app/[locale]/(console)/domains/**`, `components/Domain*.tsx`, `lib/domains.ts`), admin screens (`apps/admin/.../domains/**`), i18n keys `dom.*`, `e2e/tests/08-domains.spec.ts`, `apps/api/src/dev/domains-dev.ts` (dev-only mock registrars), runbooks `docs/runbooks/{domains-reconcile,domains-registrar-outage,dns-degraded-zone,domains-demo}.md`.

## C. Implemented
Linkage: preview from the site's real targets (nothing invented), apply through the atomic change-set as **platform-managed** records (users cannot edit/delete them), `_acme-challenge` only through the port (+ clean-up), audited with the approver. Renewals: reminders at 60/30/7/1 days (once per threshold and expiry cycle), auto-renew (spend-approval request above the limit, order within it, `renewal_at_risk` + dunning notice on `402`), `dns.zone_months` accrual (1/30 per active zone per day, deterministic event id). Reconciliation: nightly sweep of `needs_reconcile`/`provider_pending` orders, `sync()` of domain state, forced admin reconcile, RC-04 bill lines.

## E. Tests run (actual)
| Command | Result |
|---|---|
| `domains-s31.int.spec` | **11 pass**: linkage preview/apply/idempotent/ACME/errors; reminders once per threshold; auto-renew once per cycle; approval path; payment failure ⇒ `renewal_at_risk`; zone accrual once per day; **RC-04 on the mock statement reports exactly the injected variances** (`bill_amount_mismatch` for the changed amount, `bill_line_without_cost` for the extra charge; clean run reports none); admin reads masked |
| `pnpm --filter @nuzm/web test` (domain helpers) | 7 pass |
| `pnpm --filter @nuzm/web build`, `pnpm --filter @nuzm/admin build` | pass |
| `e2e/tests/08-domains.spec.ts` | written for 12 screens × ar/en with axe and screenshots — **NOT RUN** (ports 3000/3001/4000/4010 and Postgres :54329 belong to other sessions); AC-M07-11 therefore **NOT VERIFIED** |

## F. Security
`dns.*` writes by `linkage` are the only way to reach reserved names; admin lookup masks contacts always (no break-glass); no PII in notifications (names only).

## G. Gates
HG-07-01 PENDING (AC-M07-12, -14, -15 BLOCKED), HG-07-02/D-19 (AC-M07-13), D-31 OPEN.

## H. Acceptance (S31 slice)
AC-M07-10 PASS (mock statement, injected variance reported exactly); AC-M07-11 NOT VERIFIED (e2e not run); AC-M07-14 BLOCKED; AC-M07-15 BLOCKED.

## I. Handoff
M08: `DnsLinkageService` for `managed_by='email-verification'` (the writer enum and the user-protection already exist). M06: implement `HostingSiteReadPort` and call `applyLinkage` ([assumptions §7](M07-m05-interface-assumptions.md)).
