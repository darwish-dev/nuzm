# Runbook — E-invoicing onboarding (M03 S11b) — SIMULATED ONLY

**Read this first.** Everything in this runbook runs against the **simulated** e-invoicing server of this repository. It is not ZATCA, it implements our own contract, and every outcome is `NOT VERIFIED vs ZATCA`. No official ZATCA documents were supplied (HG-03-03), no step below contacts a ZATCA environment, and **production onboarding is not possible with this build** (`ZATCA_MODE=production` is refused by the code). The real onboarding needs the human steps in §4, performed by finance and security with the Fatoora portal.

## 1. Switching it on (sandbox or simulation only)
`ZATCA_MODE=sandbox` (or `simulation`); the default is `off`, in which nothing is generated and invoices behave as before. Set `ZATCA_GENERATE_FROM=<ISO date>` to let the scheduler create e-invoices for invoices and credit notes issued from that date on (unset = nothing is created automatically; nothing older than the date is ever picked up). Requires a **registered billing entity** (VAT number, HG-03-01): with the seeded placeholder entity generation refuses with `seller_vat_missing` and creates nothing.
The development key vault and WORM archive are local directories (`ZATCA_DEV_VAULT_DIR`, `ZATCA_ARCHIVE_DIR`, git-ignored). **The key vault choice is D-12; a development vault with self-generated test keys is refused in a production profile.**

## 2. The steps (admin console, `POST /v1/admin/billing/zatca/onboarding`)
Credential steps need **two different people**: finance (`admin:zatca:manage`) requests, security (`admin:zatca:approve`) approves. The requester can never approve (service and database both refuse). Steps run in order; a completed step cannot be redone.
| Step | Who | What happens |
|---|---|---|
| `csr` | finance requests, security approves | A **test key** is generated in the vault and a PKCS#10 CSR is built (stored as a public fact in the step result). ZATCA-specific CSR attributes are **not** included (cannot be pinned without the official documents) |
| `compliance_csid` | finance requests, security approves **and supplies the one-time password** | The server issues a compliance credential. The OTP is used once and is **never stored or logged**; the credential's token and secret go to the vault, the database keeps references only |
| `compliance_checks` | finance (runs at once) | Three synthetic sample documents (standard, simplified, credit note; fictional buyer; never stored, never in the chain) are stamped and checked |
| `production_csid` | finance requests, security approves | The production credential is issued with the compliance credential; the onboarding is complete |
A step the server refuses (wrong OTP, unavailable) ends `failed` with a plain reason; request it again. A rejected request frees the slot.

## 3. After onboarding
The scheduler tick (`BILLING_SCHEDULER_INTERVAL_SECONDS` > 0, ADR-017) generates, stamps, queues and submits. **Standard (B2B) invoices are not delivered (PDF/XML) before clearance** (409 "delivered only after clearance"); simplified (B2C) invoices are queued and reported within the window (`reportingWindowHours` in the profile, alarm at 50%). See `zatca-queue-stuck.md`.

## 4. What the REAL onboarding needs (not done, not possible here)
1. The official ZATCA specification set in `spec/zatca/official/` and a re-pin (`pnpm zatca:guard --update`), then golden files and the official XSD/Schematron validation.
2. Fatoora portal access and an EGS unit registration for the registered billing entity; the portal issues the one-time password for the compliance credential.
3. Real key custody (D-12) instead of the development vault; the CSR with ZATCA's required attributes.
4. The owner's decision to enable production, recorded with HG-03-03 evidence. **Never done by the agent.**
5. Credential renewal and key rotation: **not built** (a completed step cannot be redone in this build); needs the official renewal rules.
