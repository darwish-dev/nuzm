# Gate Review — M11 (PREPARED for the owner; NOT SIGNED)

- Date / reviewers: prepared 2026-11-18 by the implementing agent; **reviewer: owner**. Nothing below is a sign-off. The milestone is **NOT DONE**: M11's completion rule forbids DONE while any acceptance row is unevidenced, and AC-M11-06, -10, -11 are BLOCKED, AC-M11-13 NOT VERIFIED.
- **Owner-directed exception recorded:** M11 was started before M09 reached the shared base (the prompt's "stop if a hard dependency is missing" was overridden by the owner). AI-run, deployment, website/app-template install and artifact-store behaviour are ports with unavailable defaults and test fakes: **NOT VERIFIED** ([assumptions](M11-m09-interface-assumptions.md)).
- **Gate text (prompt §1) vs evidence:**
  | Gate item | Result |
  |---|---|
  | Retries idempotent | **PASS** (AC-M11-01: 210 seeded fault runs, 0 duplicate effects; non-idempotent steps never auto-retried) — effect receivers are fakes |
  | Unauthorized connectors blocked | **PASS** (AC-M11-02: 31 fixtures; publish 422, runtime fail-closed 403 semantics; revoked authorization stops a running execution at its next step) |
  | Purchased templates install only for entitled tenants | **PASS** (AC-M11-04: 62 attempts, 0 successes; DB trigger as second layer) — installer for website/app templates NOT VERIFIED |
  | Agencies cannot cross client boundaries | **matrix PASS, row BLOCKED** (AC-M11-06): deny-by-default guard, per-request live validation, 17 deny cells, ≈100+ routes sweep, 150-tuple property test, no impersonation; **revocation routes are not approved (SCR-M11-01)** so the row stays BLOCKED |
  | Reseller issuer model only as approved (D-24) | **PASS as posture / BLOCKED as feature** (AC-M11-10): `disabled`; any other model BLOCKED and impossible to enable by code path, config or database; nothing approved |
- Acceptance rows: see [M11-report.md §H](M11-report.md). **PASS:** AC-M11-01, -02, -03, -04, -05, -07, -08, -09, -12, -14. **BLOCKED:** AC-M11-06 (SCR-M11-01), -10 (D-24, HG-03-04), -11 (HG-11-01, HG-04-01). **NOT VERIFIED:** AC-M11-13 (Playwright/axe/screenshots NOT RUN; UI-M11-14/20/21/22 BLOCKED by SCR).
- **Pre-S54 blocker:** SCR-M11-01 was required before S54 and is unapproved. S54 was built around it (service-level revocation). **Recommendation: `agency.enabled` stays OFF in every shared environment until the owner approves and wires the revoke routes.**
- Spec change requests: SCR-M11-01..08 prepared ([document](M11-spec-change-requests.md)); nothing outside docs/04 was implemented except the §1-convention inbound webhook route (declared and flagged).
- Open critical/high defects: none known. Known limitations: all effects are fakes (no real receiver, OAuth server, PSP, artifact store, malware engine, egress proxy, M09); per-process rate limiters; DSR erase/export and retention purge of automation data NOT implemented; no load test run; `@Delegable()` only on workflow routes; marketplace listings carry the unverified `sa-pending` region by default (purchases/installs are denied fail-closed until a verified region is configured).
- Migration + rollback notes reviewed: `1600–1606` each have a dev-only `.down.sql`; production is forward-fix. **Reviewer action:** read the down scripts and confirm; note that 1605 deliberately accepts only `issuer_model = 'disabled'`.
- `spec/` in sync: drift OK (319 routes), lint clean, SDK regenerated and checked, classification (2200 columns / 178 tables) and residency-hook checks clean.
- Money: purchase invoices go through M03; accrual on ledger 2600 only; **the 70 % publisher share is a placeholder (D-26)**; no payout code exists; marketplace VAT/principal-vs-agent and reseller invoice treatment need the tax advisor (HG-03-04; scenario pack prepared).
- Compliance hooks checklist (M11 §15): see the report §H (DSR/retention of automation data and counsel notices are NOT done).
- Owner decisions requested: (1) SCR-M11-01 first, then -02..-08; (2) D-24 and HG-03-04; (3) D-26/HG-11-01 incl. the share rate; (4) D-34 retention for execution/webhook data and whether DSR handlers for automation data are required for go-live; (5) delegable-scope catalogue and which owners add `@Delegable()`; (6) sub-organization creation and ownership; (7) M09 event topic names for the allow-list; (8) how/when M09/M10 wire the four ports.
- Decision: **hold for owner.**
- Owner sign-off (name, date): _pending_
