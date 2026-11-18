# S34 report — object storage

Status: **DONE for the autonomous scope; live rows BLOCKED** · Branch `claude/m08-data-email-b74780` · Written 2026-11-18 · Dev-reference mocks only: **NOT VERIFIED (local reference)**; production providers BLOCKED (D-05..D-09 OPEN, HG-08-01 PENDING).

## A. Repository findings and assumptions
- No S3 provider or emulator exists here; the S3-compat suite can only be a CONTRACT (`ObjectStorageAdapter.compat()` + the `compat` mock report). Real compat evidence is AC-M08-13 (BLOCKED).

## B. Plan and changed files
- Migration 1002, `storage.service.ts`, `storage-flow.ts`, `storage-policy.ts` (pure policy/lifecycle/key validation), `storage-pricer.ts`, `storage.controller.ts`, `storage.int.spec.ts`; OpenAPI for `/v1/storage/buckets/**`.

## C. Implemented features, API and UI screens
- Namespaced `nz-<orgShort>-<name>`; reserved prefixes refused; private by default (`public/policy/org` cannot be set at creation); bucket-scoped credential in the vault; deny-by-default policy subset (`policy_invalid` otherwise); `confirmPublic` + recent MFA + audit for public access; signed URLs (default 900 s, max 604800 s, method-scoped, never logged); lifecycle (expiry/multipart abort; transitions only with the capability); entitlement quotas (count, bytes); daily usage import with `unavailable` meters never estimated; system bucket pair `nz-sys-<region>-backups|replica` in the same region.

## D. Migrations and rollback
- `1002__data__storage_buckets` (+ `.down.sql`, DEV ONLY).

## E. Tests run with actual results
- `storage.int.spec.ts`: 19 integration cases (policy fuzz, MFA/confirm bypass attempts, signed URL tamper/expiry, usage exactness, isolation).

## F. Security, tenant isolation, billing, residency verification
- Isolation: foreign bucket id answers exactly like a missing one; bucket credentials are scoped per bucket (mock provider checks); name collision gives the same `name_taken` whoever holds the name. Residency: EU region denied.

## G. Human gates and live checks still needed
- D-07/HG-08-02 (provider, compat run on the real endpoint, credential scoping test, egress/request metric availability), D-34. DB backups depend on a verified system bucket: with none, databases cannot be enabled (owner decision per docs/14).

## H. Acceptance checklist
| Row | Status |
|---|---|
| AC-M08-13 (S3 compat on the real endpoint) | BLOCKED (D-07, HG-08-01) |
| AC-M08-09 (metering accuracy on fixtures, storage part) | PASS (dev-reference) |

## I. Next-sprint handoff and open decisions
- Email modules reuse the data module's provider service, operations, flow and alerts.
