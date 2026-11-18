# S27 — billing/metering, abuse, offboarding, UI, acceptance (M06)

## A. Findings and assumptions
M03 dunning exists on this base, so the suspension hook runs against the REAL `billing.dunning_cases` (read-only under the platform scope). Hosting plan subscription via M03 is not built: usage is metered through the central pipeline and priced by the price book (ledger-only usage, M06 §2). Audit event names carry the `hosting.` prefix (`hosting.site.suspended` for the spec's `site.suspended`): the registry format needs three segments.

## B. Changed files
Migrations `0830` (`abuse_cases`, `wipe_reports`), `0832` (`metering_marks`); code `hosting-metering.ts`, `dunning-hook.ts`, `abuse.service.ts`, controllers (`admin-abuse`, `site-abuse`), spec (abuse cases, appeals), UI (below), i18n, runbooks (site-recovery, drain-and-migrate, abuse-handling, offboarding), demo, e2e specs.

## C. Implemented
**Metering:** `hosting.site_months`, `hosting.disk_gb_months`, `hosting.backup_gb_months` accrue per COMPLETE UTC day (`eventId = uuidv5(org|meter|site|day)`), exact 9-decimal fractions with the last day of the month carrying the remainder so a month sums to exactly 1; `hosting.bandwidth_gb` from the cumulative monthly counter as deltas; emitted with `emitUsage` in the transaction that moves the mark (`hosting.metering_marks`).
**Dunning:** open case in `suspended`/`terminated_pending` without a hold → active sites suspended with reason `dunning`; closed (paid) or hold → reinstated; staff/abuse/quota suspensions untouched. **Abuse:** detectors (sustained CPU, SMTP egress attempts, process signatures) with default actions, staff-opened cases (idempotent), actions notify/throttle/suspend with reason codes, appeal by the customer, decision by a DIFFERENT person (service + CHECK), `overturned` lifts what the case did. **Offboarding:** see the runbook (export window, legal-hold re-check, verified wipe report).
**UI (read-only):** customer `/hosting/plans`, `/hosting/sites`, `/hosting/sites/[id]` (+ banners, quota gauges), `domains`, `ssl`, `databases`, `backups`, `usage`; admin `/hosting/nodes`, `/hosting/nodes/[id]` (capacity), `/hosting/sites`, `/hosting/abuse`, `/hosting/agents`; ar/en strings; states loading/empty/error/forbidden through the shared `view()` helper.
**NOT BUILT:** UI-M06-02 create wizard, UI-M06-10 settings/delete, every mutation control (bind domain, upload certificate, create/restore backup, drain/overcommit modal, suspend/resume, abuse action forms), UI-M06-16 (hidden until M11). The API has all of these.

## D. Migrations and rollback
`0830`, `0832` with `.down.sql` (dev/staging); production forward-fix (abuse cases and wipe reports are evidence).

## E. Tests run
`hosting-s27.int.spec.ts` 11 (metering 5 incl. replay, dunning 1, abuse 5). E2E `06-hosting-customer.spec.ts`, `07-hosting-admin.spec.ts` written, **NOT RUN** (ports of another session).

## F. Security / tenancy / billing / residency
Replay with the marks wiped yields the same event ids and 0 aggregate diff through the real ingest; duplicates are `duplicate`; the abuse evidence is staff-only and by reference; wipe reports are append-only.

## G. Human gates / live
AUP/abuse policy text and thresholds (HG-04-01); independent pen test of isolation (HG-12-01 → AC-M06-19 BLOCKED); legal review of the CloudPanel licence terms (HG-06-01); e2e + axe + screenshots NOT RUN.

## H. Acceptance
AC-M06-10 PASS (3 fixtures + replay, mock events through the real ingest); AC-M06-11 PASS at service level against real dunning tables (e2e NOT RUN; M03 subscription billing not built); AC-M06-13 PASS on the mock (0 residual artifacts, legal hold blocks, unverified wipe keeps the site `deleting`); AC-M06-16 NOT VERIFIED (UI partial, e2e not run); AC-M06-14/15 see S24/S25; AC-M06-17/18/19 BLOCKED.

## I. Handoff
See the M06 report §I.
