# Runbook — break-glass access (DRAFT, M01)

Status: **draft for owner/security review**. Nothing here has been exercised against production. A production break-glass needs a decision on the vault/KMS (D-12), the on-call process and a legal basis for data access (M04/M12), so it is **BLOCKED** until then.

## What exists today
- The role `nuzm_admin_breakglass` (NOLOGIN in migrations). It has read access to the audit store and write access to feature flags, and is **not** used by the application.
- Routine staff work goes through the admin console API with platform roles (`platform_admin`, `support`, `finance`, `compliance_officer`, `security`): admin-realm session, MFA mandatory, step-up for sensitive actions, every action audited. Break-glass is for when that path is unavailable.

## Principles (to be confirmed)
1. **Two people**: one requests, a different person approves. Record both and the reason.
2. **Time-boxed**: grant LOGIN for a fixed window (proposal ≤ 60 min), then remove it; do not leave it enabled.
3. **Audited**: every statement runs under a logged session (`pgaudit` or equivalent, to be chosen); the grant and revoke are written to the platform audit chain by the operator.
4. **Least access**: prefer a read-only role; write access only for the specific recovery action.
5. **Notify**: affected organizations are told when their data was accessed (PDPL).

## Procedure sketch (to be hardened)
1. Open a ticket: who, why, scope, expiry. A second person approves in the ticket.
2. DBA enables the role for the window: `ALTER ROLE nuzm_admin_breakglass LOGIN PASSWORD '<one-time, from the vault>' VALID UNTIL '<expiry>'`.
3. Work through the approved statements only. Save the session log.
4. Revoke immediately: `ALTER ROLE nuzm_admin_breakglass NOLOGIN PASSWORD NULL`.
5. Record an audit event (platform chain) and attach the log to the ticket. Review within 24 h.

## Open items
- Vault-issued one-time credentials (D-12); session auditing tool; on-call rota; notification templates; legal review (HG-04-xx).
