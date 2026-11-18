# S26 — isolation, quotas, backups/restore, maintenance (M06)

## A. Findings and assumptions
Isolation is implemented as the **agent contract + mock node** (checklist below); the real node, kernel and CloudPanel behaviour are NOT VERIFIED. Backup sink: `node-local-segregated` (in-memory) for dev/test; production has `NoBackupSink` → `422 no_backup_sink` until D-07 / P-M06-1 is decided. A decrypted customer export format is not built (download returns the encrypted archive).

## B. Changed files
Migrations `0820` (`site_quotas`, `quota_events`, `site_usage_reports`, `site_backups`, `site_migrations`), `0831` (re-arm grant); code `backups.service.ts`, `usage.service.ts`, `migration.service.ts`, controllers (`site-backups`, `backup-downloads`), spec (backups, download-links, restores, usage, admin migrations; admin site list gets `nodeId`), i18n notification kinds.

## C. Implemented
**Isolation checklist (task 10) → where verified:** per-site user/group, 0700 homes → isolation 01-06, 10; PHP-FPM pool `open_basedir` + disabled functions → 19-22; separate temp dirs → 07; per-site DB user restricted to its DB → 23-25; per-site cron/log/TLS key → 15-17; per-site credentials and backup keys (vault refs) → site creation test, 30; resource limits (disk, inodes, processes, memory) → 26-28 + `quota.apply`; SFTP chroot → 11; process list visibility → 12-13. Real-node verification: BLOCKED (HG-06-01).
**Quotas:** `site_quotas` from the plan (disk_mb, inodes, bandwidth_gb, processes, memory_mb, db_count, backup_count, backup_gb); soft at 80 %, hard at 100 % (proposals); each threshold notifies owners/admins **once** (`quota_events` unique) and re-arms below the soft limit; hard bandwidth suspends (`quota`) and the new month reinstates; disk/inodes are enforced on the node.
**Backups:** per-site AES-256-GCM key (vault ref), archive in the sink of the site region (M04 hook `m06-backup-sink` enforced), checksum + manifest (path, sha256, bytes; never content/keys), quota on count/size, retention sweep (legal hold keeps), expiring signed org-bound download links (`/v1/hosting/backup-downloads?token=…`; the first design used a path parameter and failed on URL length, so it is a query parameter).
**Restore:** conditional `active → restoring` (409 `restore_in_progress`), pre-restore safety backup, restore + checksum verification, corrupt archive marked `corrupt` before anything is overwritten, site returned to `active` on failure.
**Drain/migration:** draining excludes the node from placement; migration = backup → create on target → restore → verify → switch (reservation moved, domains re-applied, managed certs re-issued) → remove source; failure rolls the target back and leaves the source untouched; same data region only.

## D. Migrations and rollback
`0820`, `0831` with `.down.sql` (dev/staging); production forward-fix (backups are customer data references).

## E. Tests run
`hosting-s26.int.spec.ts` 15 (backups 5, restore 3, quotas 2, drain/migration 4 + one cross-region/inactive case), plus the mock isolation suite (30) and adapter conformance (12) in the unit run.

## F. Security / tenancy / billing / residency
Backup id/link of another organization → 404 (including a link made by the owner and presented by another org, forged and tampered tokens); archives are ciphertext and keys are per site; backup region = site region with a residency check (403 when the policy refuses); no key or file content in rows/audit.

## G. Human gates / live
Production backup sink (AC-M06-18) BLOCKED (D-07 / P-M06-1); restore time budget (≤ 10 min for 1 GB) NOT MEASURABLE on the mock → NOT VERIFIED; neighbour p95 degradation < 20 % NOT VERIFIED; live isolation BLOCKED (HG-06-01).

## H. Acceptance
AC-M06-06 PASS on the mock (5/5 round trips, corrupted backup rejected, safety backup exists); AC-M06-09 PASS at API level (soft/hard once, e2e screen NOT RUN); AC-M06-12 PASS on the mock (0 new placements on a draining node; failed migration leaves the source serving); AC-M06-04 PASS (mock) / BLOCKED live.

## I. Handoff
S27 consumes `site_usage_reports` for metering and abuse detectors.
