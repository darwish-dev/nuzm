# M01 deferrals (change-log entries)

Approved by the owner in chat on 2026-11-16 ("Sign, defer the open rows"). Each row below was NOT DONE at the M01 gate and is now `DEFERRED (approved change-log entry)` per CLAUDE.md §6. Nothing here is converted to PASS.

| ID | Deferred item | Why it is safe to defer | Picked up in |
|---|---|---|---|
| DEF-M01-01 | Monthly partitioning of `audit.audit_logs` (M01 §7) | Volume is nil until real traffic; partitioning needs the partition key in every unique key and in the chain trigger design | M12 (before GA), or earlier if volume warrants |
| DEF-M01-02 | UI-M01-28 admin all-organization operations monitor | No endpoint in docs/04's M01 list; operations exist per org | M12 (`/v1/admin/operations/health`) |
| DEF-M01-03 | UI-M01-29 role/permission matrix viewer | Read-only convenience; `GET /v1/roles` and `/v1/permissions` exist | M02 admin UI work (same screens family) |
| DEF-M01-04 | UI-M01-04 standalone `/auth/mfa-challenge` page; UI-M01-19 operations detail drawer (steps) | Challenge is handled inline (step-up) and at admin sign-in; operations list + cancel work | M05 (first real operations) |
| DEF-M01-05 | PA-17 audit integrity badge/endpoint; PA-18 notification preferences endpoint/screen | Not approved endpoints; verifier job and preference service already exist | When PA-17/PA-18 are approved |
| DEF-M01-06 | E2E for invitation accept via mail link and for impersonation start + banner | Both are covered by API integration tests; the mail token is only in the mail | With a mail catcher (M08) / next E2E extension |
| DEF-M01-07 | Keyboard-only walkthrough; header-scan test; load smoke; DB-failover-during-relay test | Record-only or hardening items | M12 |
| DEF-M01-08 | PII classification annotations for `identity.users` fields in `spec/db/ownership.yaml` (M01 §9.4) | First consumer is M04 | M04 (S13) |

## Still OPEN (not covered by this sign-off)
Recorded for the owner; the implemented behavior stays as built until decided.
1. Additive contract changes beyond docs/04: `X-Nuzm-Org`, `realm` on OIDC login, `X-Nuzm-Realm`, `mfaFactorId`/`platform`/`impersonation` on `/v1/me`, `mfaFactorId` on `mfa_required`, `invitationId` in the invitation mail, invitation link shape.
2. PA-12 (platform-role API), PA-17, PA-18; `POST /v1/admin/organizations` semantics; impersonation approval model (`approvalRef`); one OIDC client per console (D-04).
3. BLOCKED items: HG-01-01 (no remote/CI run), HG-01-02/D-04 (real IdP), D-12 (vault/KMS), D-13 (observability backend), D-08 (mail provider).
