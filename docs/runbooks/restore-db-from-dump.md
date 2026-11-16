# Runbook — restoring the database from a dump (M01, dev/staging)

First-release rollback strategy (docs/05 §6): **restore a snapshot**; migrations are forward-only in production. This runbook covers the project-local development cluster. A production restore procedure, RPO 15 min / RTO 4 h (D-30) rehearsal and managed-database backups are M12 work and are **NOT VERIFIED** here.

## Take a dump
```bash
pg_dump -h 127.0.0.1 -p 54329 -U nuzm_admin -Fc nuzm_dev -f nuzm_dev.$(date -u +%Y%m%dT%H%M%SZ).dump
```
Dumps contain tenant data and hashed credentials/secret references. Keep them out of the repository (the secret scan does not read binary dumps).

## Restore into a fresh database
```bash
createdb -h 127.0.0.1 -p 54329 -U nuzm_admin nuzm_restore
pg_restore -h 127.0.0.1 -p 54329 -U nuzm_admin -d nuzm_restore --no-owner nuzm_dev.<timestamp>.dump
DATABASE_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54329/nuzm_restore pnpm --filter @nuzm/db exec tsx src/cli.ts check
DATABASE_ADMIN_URL=postgres://nuzm_admin@127.0.0.1:54329/nuzm_restore pnpm --filter @nuzm/db exec tsx src/cli.ts migrate   # applies anything newer than the dump
```
`check` must print `db check OK`. `migrate` refuses to run if an applied migration's checksum changed.

## Verify audit integrity after a restore
The hash chains are part of the data. Run the verifier against the restored database (platform scope):
```bash
# worker role with AUDIT_CHECKPOINT_KEY set; the job logs AUDIT_CHAIN_BROKEN for any broken chain
WORKER_DATABASE_URL=postgres://nuzm_worker:nuzm_dev_only@127.0.0.1:54329/nuzm_restore AUDIT_CHECKPOINT_KEY=<key> AUDIT_VERIFY_INTERVAL_SECONDS=1 \
  pnpm --filter @nuzm/worker exec tsx src/main.ts
```
A broken chain after a restore means the dump was altered or incomplete: stop, preserve the evidence, and do not "repair" it.

## Swap
Stop the API and worker, rename databases (`ALTER DATABASE … RENAME TO …`), start the services, and run `pnpm services:status`. Keep the old database until the restore is signed off.
