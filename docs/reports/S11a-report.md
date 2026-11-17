# S11a report — E-invoice document pipeline, synthetic profile (M03 sprint 11, first half)

Status: implemented and verified against real PostgreSQL (see §E). **Not committed.** **Everything here is `NOT VERIFIED vs ZATCA`.** S11b (adapter and simulated server, onboarding, submission queue, admin endpoints, delivery gating) is next.

## A. Repository findings and assumptions
- **No official ZATCA documents were supplied, so the specification pin is BLOCKED (M03 prompt §4 item 12, HG-03-03).** `spec/zatca/official/` is empty and `spec/zatca/VERSION` says `UNPINNED`. I did **not** write down what ZATCA requires from memory. Instead the pipeline runs on a clearly labelled **synthetic profile** (`spec/zatca/synthetic-profile.yaml`, `SYNTHETIC-NOT-OFFICIAL`): type codes, namespaces, subtype codes, the VAT-number format, the first-PIH seed, QR tags, reporting window and time offset are *configuration*, not code, so re-pinning from the official documents is a profile and golden-file change plus review, not a rewrite.
- **What is built is the whole pipeline's structure**, as docs/11 §5 describes it: document model, UBL-2.1-style XML, document hash, ICV/PIH chain, QR as TLV, signing through vault references, CSR generation, WORM archive, structural validation. **None of it has been checked against a ZATCA validator, schema, Schematron or sample.** Real canonicalization (C14N), the official element set and order, the QR tag rules (including tag 9), signature parameters, CSR extensions and VAT-number rules are all open until the official set arrives.
- **Seller data:** the seeded billing entity is a placeholder without a VAT number (HG-03-01), so **no e-invoice can be generated for it**: generation refuses with `seller_vat_missing`, creating nothing and consuming no counter value. The integration tests use a registered-looking *test* entity (VAT `300000000000003`, a test value).
- **Keys:** only a development file vault with **self-generated test keys** (`DevFileVault`, refused in a production profile). The vault choice is D-12. `.local/` is git-ignored; `*.pem` already was.
- **Not production, by construction:** `ZATCA_MODE` accepts `off` (default), `sandbox`, `simulation`; `production` is refused by the code (needs HG-03-03 evidence and the owner's own decision).
- **Placement:** the zatca code lives in `modules/invoicing/internal/zatca/` (invoicing owns the `zatca_*` tables, docs/05) behind a small interface, which keeps ADR-014's native/vendor swap possible (`EInvoiceAdapter` arrives in S11b). Migration number **0330** (M03 range 0300–0499; 0303 was refused as older than applied migrations).
- **Debit notes:** the model and XML support them, but nothing in the platform issues a debit note, so no generation path exists.
- **Credit note lines** are mapped to their invoice line's description and unit with quantity 1 (partial credit quantities are not recorded); a [VERIFY] item for the tax advisor.

## B. Plan and changed files
- Spec: `spec/zatca/{README.md,VERSION,CHANGELOG.md,synthetic-profile.yaml,official/}`; `scripts/zatca-spec-guard.ts`, `pnpm zatca:guard` (part of `pnpm verify`).
- Migration `invoicing/0330__invoicing__zatca_documents` (+down).
- Code in `apps/api/src/modules/invoicing/internal/zatca/`: `profile.ts`, `build-document.ts`, `ubl.ts`, `hash-chain.ts`, `qr-tlv.ts`, `signing.ts`, `csr.ts`, `validator.ts`, `archive.ts`, `zatca-document.service.ts`; module wiring and exports; `.env.example`, `.gitignore`.
- Tests: `zatca-pipeline.spec.ts` (27 unit tests), `invoicing/zatca.int.spec.ts` (11 integration tests).

## C. Implemented features
| Area | What exists |
|---|---|
| Spec pin guard | `VERSION` holds the pinned spec version, the checksum of `official/` and the hash of the generator sources; `pnpm zatca:guard` fails when the generator changes without `--update "<note>"` (and a changelog line), or when the official files change without a re-pin. Verified both ways |
| Document model | built from an issued invoice or credit note snapshot (seller/buyer snapshots, lines, totals, reference); SAR only; standard (B2B with buyer VAT number) vs simplified |
| XML | deterministic, compact, escaped; hashed **body** vs **final** XML (QR and signature inserted after hashing at fixed places and removable byte-for-byte) |
| Hash chain | SHA-256 base64 over the body; ICV per entity and environment, PIH = previous hash, first PIH from the profile seed; continuity verification (first icv, gap, duplicate, pih mismatch, hash mismatch) |
| Chain integrity in the database | `zatca_chain_tip` (a security-definer function exposing only icv and hash across tenants) and an insert trigger that enforces `icv = tip + 1` and `pih = tip hash`; the counter is allocated in the same transaction (a failed generation gives the number back: no gap) and serialized by an advisory lock |
| Validator | structural rules of the synthetic profile (VAT-number format, required parties, totals, tax rounding as a warning, references, XML equals model) with an explicit `OfficialValidator` slot that is empty; every result carries `notVerifiedVsZatca: true` |
| QR | TLV base64 (tags 1–8), encode/decode round trip (10,000-run property) |
| Signing | ECDSA secp256k1 over the SHA-256 document hash through a vault **reference**; the interface can sign and reveal the public key only; refuses odd references and a production profile |
| CSR | PKCS#10 built with a small DER writer, signed through the vault; parsed and its signature verified in a test; ZATCA-specific attributes are not included (cannot be pinned) |
| Archive | WORM local store: write once, identical rewrite is a no-op, different bytes refused, checksum checked on read, traversal refused; the database holds the authoritative copy, so a missing object is rewritten and a damaged one is reported |
| Service | `generate` (idempotent, nothing created unless it validates), `stamp` (once; signature, QR, final XML, archive), `ensureArchived`, `verifyChain`, `verifyStored`, `validateStored` |
| API/UI | none in this half (endpoints are S11b; invoice `zatca` status stays `not_generated` until then) |

## D. Migrations and rollback
`invoicing/0330`: `invoicing.zatca_documents` (one per legal document and environment; body immutable; stamp, QR and archive link set once; never deleted or truncated; org RLS + platform read; column-level UPDATE grants) and the two security-definer chain functions. Dev-only `.down.sql` exercised (rollback → migrate → `db check` OK); production is forward-fix.

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0** in one run (earlier attempts this sprint failed on a prettier error in a changelog line the guard appended and a type error in a new test; both fixed):
- lint, typecheck (19/19), build (11/11), `spec:lint`, `spec:drift` (108, unchanged: no endpoints yet), `sdk:check`, `scan:secrets` 1,422 files / 0 hits, **`zatca:guard` OK** (new).
- Unit: api **298** (+27), web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3. Browser E2E: 6 passed.
- `db check` OK; integration: db 43, platform 32, worker 8, **api 513** (+11) = **596**.
- Highlights: 20 concurrent generations across two organizations give 20 unique consecutive ICVs with an intact chain and a gap-free counter; a document that fails validation creates nothing and the next one takes the same number; five simultaneous generations of one invoice give one document; the chain continues across organizations (a document's PIH is another tenant's hash); credit note references its invoice; stamping verifies (signature over the hash with the public key, QR fields equal the document, final XML minus stamp equals the hashed body, WORM copy equals the database copy); tampered and missing archive objects detected and repaired; the database refuses a broken chain, edited bodies, re-stamping and deletion.

## F. Security, tenant isolation, billing, residency verification
- RLS forced on `zatca_documents`; the cross-tenant chain tip exposes only (icv, hash); another organization gets 404 for a document and for generating a foreign invoice.
- Keys never leave the vault interface; only references are stored or passed; the dev vault is refused in production.
- No network call to any ZATCA environment exists or can be configured in this half.
- Residency: `data_region` is copied from the invoice (`sa-pending` until M04); archive location is a local directory (in-Kingdom store: D-15).

## G. Human gates and live checks still needed
HG-03-03 (official documents, Fatoora portal access, OTP, EGS registration) **BLOCKED**: nothing is verified against ZATCA, including type codes, XML structure, hash canonicalization, QR, signature and CSR. HG-03-01 (seller registration data). HG-03-04 (tax advisor: credit-note line mapping, rounding, exemptions). D-11 (native vs vendor) and D-12 (vault). D-34 (retention) for the archive.

## H. Acceptance (S11a rows)
| Row | Status |
|---|---|
| Spec pinning with a CI guard (`spec/zatca/VERSION`, checksum) | PASS for the guard; the pin itself is BLOCKED (no official documents) |
| Document builders (standard, simplified, credit; debit model only) | PASS (synthetic) |
| UBL XML generator | NOT VERIFIED vs ZATCA |
| Schema/Schematron validation harness | PARTIAL: structural harness PASS; official XSD/Schematron BLOCKED (no artifacts) |
| ICV/PIH chain, UUID, gap detection, concurrency | PASS (database-enforced) |
| QR TLV | PASS as TLV; field set NOT VERIFIED vs ZATCA; golden files from ZATCA samples BLOCKED |
| Signing service with vault refs, CSR generator | PASS with self-generated test keys; CSR attributes NOT VERIFIED |
| Archive (WORM semantics, retention config) | PASS (local store); retention config and in-Kingdom store pending D-34/D-15 |
| Onboarding state machine, submission queue/worker, clearance gating, reporting queue, retry endpoint | NOT DONE (S11b) |
| Mock ZATCA server | NOT DONE (S11b) |
| Live sandbox checks | BLOCKED (HG-03-03) |

## I. Handoff and open decisions
- **S11b:** `EInvoiceAdapter` + `zatca-native` over a **simulated** in-repository server (our own contract, not ZATCA's), `zatca_onboarding` and `zatca_credentials_refs` (vault refs only) with the two-person credential steps, `zatca_submissions` (append-only, derived state, backoff, dead letter), clearance gating of standard invoices and the reporting window SLO, the admin endpoints of docs/04 (`onboarding`, `submissions`, `retry`) and the invoice `zatca` status/XML, scheduler step, runbooks.
- **Owner:** supply the official ZATCA specification set (this unblocks pinning, goldens, real validation) and the HG-03-01 entity data; choose D-11.
