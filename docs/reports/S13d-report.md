# S13d report — Field-level encryption retrofit (M04 sprint 13, fourth and last part)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed**: S13a–S13d are all in the working tree and share files (`ownership.yaml`, `openapi.yaml`, the CLI, the module, the migrations); commit them together. S13 is complete; M04 continues with **S14** (residency engine, transfer assessments, DSR, data export) and **S15** (controls, evidence, breach, validation register, compliance UI).

## A. Repository findings and assumptions
- **Key finding: no credentials column holds a recoverable secret.** All 12 `credentials`-class columns of M01–M03 are one-way hashes (`token_hash`, `csrf_hash`, `secret_hash`, `code_hash`: 5), vault references (`key_ref`, `secret_ref`, `token_ref`: 6) or the non-secret lookup prefix of an API key (1). Nothing needs to be encrypted for them; what the task asked for is to make that a **checked property**, so the manifest now declares each column's protection and CI fails on an undeclared credentials column, a name that does not fit (`*_hash`, `*_ref`, `*_enc`), or an `encrypted` column holding anything but sealed values.
- **Selected personal data: the tax profile.** Legal names, VAT and CR numbers and the address are sealed in `invoicing.tax_profiles.pii_enc`. It was chosen because it is clearly personal/business-identifying, is written and read through a small number of code paths (profile service, tax estimate, invoice buyer snapshot) and needs no search by value. The inventory of every other personal column and the reason it is **not** sealed now is in §C.
- **Mechanism** (`apps/api/src/common/field-crypto.ts`): AES-256-GCM, a per-column subkey from the master key (HKDF-SHA256), random 96-bit IV, authenticated data `schema.table.column|rowId` (a sealed value moved to another row or column does not open), format `enc:v1:<keyId>:<…>` so key rotation never breaks old values. Master keys are **vault references** (`FIELD_ENCRYPTION_KEYS`); the key bytes are never in the database or in code. **Production without configured keys fails closed** (it refuses to seal or open; D-12 decides the real vault/KMS, so production use is BLOCKED). Development creates one throwaway key in the dev secret store.
- **Expand/contract migration `invoicing/0503`.** `pii_enc` added; the plaintext columns became nullable (and `address` lost its default); a row never carries plaintext beside ciphertext (always enforced); every NEW write must be sealed (`CHECK … NOT VALID`: legacy rows are exempt until they are sealed and the constraint is validated). The old column rule "a b2b buyer has a VAT number" can no longer be a column check (the number is inside the ciphertext): it is enforced by the service before sealing and, for legacy rows, by a relaxed check. A first draft of the "must be sealed" check let NULL through (a CHECK passes on NULL); a test caught it and it now requires a sealed value.
- **Legacy rows keep working.** The services open either form. `TaxProfileSealer` (operator job `pnpm --filter @nuzm/api run encrypt:backfill`, using the application's own configuration) seals legacy rows and re-seals after a key rotation; it is idempotent, works one organization per transaction under forced RLS with the application role, and does not change a profile's version or update time.
- **Known limits, stated plainly.** (1) The **invoice buyer snapshot** (`invoices.buyer`) and the e-invoice XML keep the buyer's details in plaintext: they are immutable legal tax documents that must be reproducible and archived (D-34, HG-03-04), so sealing them is a separate decision. (2) The operator CLI was typechecked and its job (the sealer) fully tested, but the CLI itself was **not exercised end to end** (it needs the full application configuration). (3) Sealed values are unrecoverable without their master key: key backup is part of the vault procedure (D-12).

## B. Plan and changed files
- Migration `invoicing/0503__invoicing__tax_profile_sealed` (+ down; the invoicing module is now extended by M04 in the manifest).
- Code: `apps/api/src/common/field-crypto.ts` (+ spec), `modules/invoicing/internal/tax-profile.store.ts`, `tax-profile.sealer.ts`, changes to `tax-profile.service.ts`, `tax.service.ts`, `invoice.service.ts` and `invoicing.module.ts`; `FieldCipher` provided globally by the compliance module; `apps/api/src/ops/encrypt-backfill.ts` and the script `encrypt:backfill`.
- Spec/tooling: `spec/db/ownership.yaml` (`classification.protection` for 13 columns, `pii_enc` classified), `packages/db/src/classification.ts` (protection rules and the sealed-value data check), `.env.example`.
- Docs: `docs/runbooks/field-encryption.md` (rotation, backfill, lost key).
- Tests: `field-crypto.spec.ts` (16), `classification.spec.ts` (19, rewritten after a slicing mistake of mine), `tax-profile-sealed.int.spec.ts` (9).

## C. Implemented features, API and UI screens
- **No new API operations** (125 in total); the tax profile API behaves exactly as before and now seals on write and opens on read. **UI:** none.
- **Personal-data inventory (M01–M03) and decision:**
| Column(s) | Decision |
|---|---|
| `invoicing.tax_profiles` legal names, VAT, CR, address | **Sealed now** |
| `identity.users.email`, `display_name`, `subject` | Deferred: looked up and unique by value (login); needs a keyed blind index design (HMAC) before it can be sealed |
| `identity.sessions` ip, user agent, last seen | Deferred: short-lived (idle/absolute expiry), retention-bound |
| `audit.audit_logs` before/after/detail, ip/ua hashes | Not sealed: the hash chain covers the plaintext (tamper evidence); inputs are PII-minimised by contract; archival is M12 |
| `invoicing.invoices.buyer`, `zatca_documents` XML | Not sealed: immutable legal documents (see §A limits); decision with HG-03-04 / D-34 |
| `tenancy.invitations.email` | Deferred: needed to send the mail; looked up by token hash, so a sealed column is feasible next |
| `platform.notifications.body`, `idempotency_keys.response_body`, `operations.input/result`, `outbox.payload` | Deferred: operational and short-lived; notification params are non-sensitive facts by contract |
| credentials columns (12) | **Nothing to seal**: hashes, vault references, lookup prefix (now checked in CI) |

## D. Migrations and rollback
`0503` (dev/staging `.down.sql`: it deletes sealed rows because their plaintext cannot be restored without the key; production is forward-fix and never drops tax profiles). Reviewer action: read the down script and the runbook before any production deploy; do not run the down script anywhere data matters.

## E. Tests run with actual results
| Command | Result |
|---|---|
| `pnpm lint` · `pnpm typecheck` | exit 0 |
| `pnpm spec:lint` · `spec:drift` · `sdk:check` · `scan:secrets` | clean · 125 routes · up to date · 0 hits |
| `pnpm exec turbo run test --filter='!@nuzm/e2e'` | exit 0 |
| `pnpm db:test-rls` · classification (912 columns) · ROPA coverage · `zatca:guard` | all OK |
| `pnpm test:integration` (own Postgres :54339) | db 43, platform 32, worker 8, **api 643 passed** (634 before) |
Highlights: a saved profile leaves no name, VAT, CR or address in any column; the same content seals to a different ciphertext each time; the database refuses a plaintext row, a plaintext column beside ciphertext and a non-sealed value; a sealed value copied to another organization does not open (the API answers 500, never another organization's data); legacy plaintext rows are still read by the profile API, the tax estimate and the invoice buyer snapshot, then sealed by the sealer without touching version or update time, and the constraint validates; key rotation re-seals every profile, the new key ring opens them, an old-key-only configuration cannot, and an old key can be retired only after the re-seal; audit events name counts and key ids, never values. No browser E2E (no UI); `pnpm verify:full` as one command was not run (ports held by another session), its parts ran separately.

## F. Security, tenant isolation, billing, residency
- Keys by vault reference only; fail-closed in production; per-column subkeys and row/column-bound authenticated data; the audit trail never receives values; RLS unchanged (the sealer runs per organization under forced RLS).
- No billing, metering or residency decision.

## G. Human gates and live checks still needed
- **D-12:** the production vault/KMS and key backup; until then production encryption is **BLOCKED** (configuration absent = refusal).
- **HG-04-01 / HG-03-04 / D-34:** which personal columns counsel wants sealed, and whether invoice buyer snapshots may be (retention and reproducibility).

## H. Acceptance checklist (rows touched in S13d)
| ID | Status | Evidence |
|---|---|---|
| AC-M04-03 classification coverage | **PASS** (extended: credential protection is now declared and checked) | `pnpm compliance:classification-coverage` |
| Retrofit task 6 (credentials/selected personal via key refs) | **PASS for the mechanism and the tax profile**; the remaining personal columns are recorded as deferred with reasons (§C) | integration suite |
| AC-M04-12 RLS cross-tenant over compliance tables | PARTIAL (unchanged) | |
| Production key management | **BLOCKED (D-12)** | |

## I. Next-milestone handoff and open decisions
- **S14:** `ResidencyPolicyService` consults the ROPA; DSR erasure uses the holds and retention gates; DSR `details` (free text, class personal) must be **sealed with `FieldCipher` from the start** (M04 §9); data exports are encrypted with a per-export key by vault reference.
- **Deferred sealing candidates** (§C), starting with `invitations.email` and a blind-index design for `users.email`; **M12** audit retention.
- Open decisions: D-12, D-14, D-16, D-34; HG-03-04, HG-04-01. Spec issues unchanged (SI-M04-5, SI-M04-6, SI-M04-7).
