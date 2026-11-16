# Runbook — rotating development secrets (M01)

These are **development stand-ins** until the production vault/KMS is chosen (D-12, BLOCKED). Never reuse a dev secret anywhere else.

| Secret | Where | Effect of rotating | How |
|---|---|---|---|
| `SESSION_SEAL_KEY` | env (API); dev stack stores one in `apps/api/.dev-vault/dev-seal-key` | Invalidates in-flight login state cookies (10 min); **also makes dev-vault TOTP secrets unreadable** | Generate `openssl rand -base64 32`; then re-enrol MFA for users (see below) |
| `AUDIT_CHECKPOINT_KEY` | env (worker + tools) | Old checkpoints no longer verify with the new key; the verifier reports them as invalid | Keep the old key until all chains are re-checkpointed, or record the rotation in the change log; checkpoints carry `key_ref` for this purpose |
| `AUDIT_HASH_KEY` | env (API) | New IP/UA hashes differ from old ones (correlation across the rotation is lost); chain integrity unaffected | Generate and restart the API |
| DB role passwords (`nuzm_app`, `nuzm_worker`) | local cluster only | Services must restart | `pnpm db:dev-logins` re-applies the dev password; set `NUZM_DEV_ROLE_PASSWORD` for another |
| Dev OIDC client secret | env (`OIDC_CLIENT_SECRET`) | Login fails until the IdP and the API agree | Change both sides together |

## Re-enrolling MFA after a seal-key change (dev)
```bash
psql -h 127.0.0.1 -p 54329 -U nuzm_admin -d nuzm_dev -c \
  "DELETE FROM identity.mfa_factors WHERE user_id = (SELECT id FROM identity.users WHERE email = '<email>')"
rm apps/api/.dev-vault/mfa-*     # orphaned encrypted secrets
```
Then sign in and enrol again. Do not do this for real users: removing a factor is a security-relevant action that needs the owner's approval in production.

## Rules
- Secrets never go into code, logs, fixtures, screenshots or the audit log (the audit sink redacts secret-shaped keys as a second line of defence).
- `pnpm scan:secrets` must stay clean.
