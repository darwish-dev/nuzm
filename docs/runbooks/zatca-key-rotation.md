# Runbook — E-invoicing key and credential rotation (M03) — **NOT IMPLEMENTED**

**Status: not built.** The M03 prompt lists a key-rotation runbook; rotation and credential renewal cannot be implemented honestly without the official ZATCA rules (credential validity, renewal and revocation, what happens to documents signed with the old key). No official documents were supplied (HG-03-03), and the only credentials in this repository are **simulated** (`NOT VERIFIED vs ZATCA`).

## What the build does today
- Each onboarding step can complete **once** per billing entity and environment (database rule). A new CSR, a new compliance credential or a new production credential therefore cannot be created by repeating the steps.
- The credentials table (`zatca_credentials_refs`) already has `active`, `superseded` and `revoked` states and an expiry column; nothing sets them yet. Documents stay signed with the key they were stamped with.
- Test keys live in the **development vault** (self-generated, refused in a production profile). Real key custody is decision D-12.

## What is needed before this runbook can be written
1. The official credential lifecycle (validity, renewal window, revocation) from the ZATCA documents.
2. D-12: the real vault and who holds the signing key (least privilege; no export).
3. An onboarding extension that supersedes the active credential atomically, keeps signing documents with the old key until the new credential is issued, and never leaves the signing service without an active credential.
4. A decision on how already-queued documents are handled during the switch.

## Until then
- Do **not** try to rotate by editing rows or the vault by hand: the database refuses edits to credential references and onboarding records, and a hand-made key would break the e-invoice chain's signatures.
- If a credential or key is suspected compromised: stop the scheduler's e-invoicing step by setting `ZATCA_MODE=off` (documents keep their state; nothing is submitted), involve security and finance, and treat it as a security incident (D-12 owner).
