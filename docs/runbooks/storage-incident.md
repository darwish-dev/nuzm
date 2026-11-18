# Runbook — object storage incidents (M08)

Scope: buckets created through `/v1/storage/buckets`. No provider is selected (D-07 OPEN); dev-reference mock only (NOT VERIFIED).

| Symptom | First actions |
|---|---|
| A customer reports a bucket became **public** unexpectedly | Check audit `data.bucket.made_public` (who, when; it needs `confirmPublic` + MFA). If none exists treat it as a provider/config incident: `PUT access-policy` with `access=private` (needs `data:storage:admin`), rotate the bucket credential, review signed URLs issued (`data.signed_url.issued` carries a key hash, never the URL). |
| Leaked signed URL | URLs cannot be revoked individually; they expire (default 15 min, max 7 days). Rotate the bucket credential (signing key) to invalidate all outstanding URLs. |
| Cross-tenant access suspected | Credentials are per bucket; run the isolation cases in `apps/api/src/modules/data/storage.int.spec.ts` against the provider adapter. Escalate to security. Bucket names are namespaced `nz-<orgShort>-<name>`; lookups of foreign buckets answer the same 404 as missing ones. |
| Usage looks wrong | `storage.object_gb_months/requests_k/egress_gb` come from the adapter `usage`; a figure the provider cannot report is `unavailable` (no event, flagged on the bucket) and is never estimated. Compare with the provider invoice via finrec (M03) — not implemented in M08 (see report). |
| System backup bucket unavailable | Database backups cannot be stored; scheduled backups fail visibly (`data.database.backup_*`). Restore verification alerts. Do not disable the bucket's lifecycle without owner approval. |
| DSR erasure for stored objects | Not covered by M08 (no DSR handler registered); raise with compliance. |
