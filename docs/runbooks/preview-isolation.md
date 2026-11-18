# Runbook — preview origin isolation (M09; DRAFT; see ADR-060)

**Invariants to keep true** (each has a test in `apps/api/src/modules/builder/builder.int.spec.ts`): preview host ≠ any Nuzm domain; token 160 bits, hash only in the database; CSP `default-src 'self'` + `frame-ancestors <console>`; no cookies set or read; preview host reaches no API route; API host never serves `/_preview/`.
- **Check headers** (replace host/token): `curl -sI https://<token>.<PREVIEW_DOMAIN>/ar/ | grep -iE 'content-security|set-cookie|x-content-type|cross-origin'`.
- **Revoke:** `UPDATE builder.previews SET revoked_at = now() WHERE project_id = …` (support, with audit) or delete the project (revokes all).
- **Suspected leak of a preview URL:** previews expire in 30 minutes; revoke as above; nothing in a preview is secret beyond the draft site content.
- **Edge/network checks (infrastructure, not verifiable from code):** the serving process has no egress, no vault access and no internal network route; wildcard certificate renewed; DNS wildcard intact. Owned by ops/HG-12-01.
- **Independent security review sign-off (AC-M09-04) is required and BLOCKED** until a reviewer is named by the owner.
