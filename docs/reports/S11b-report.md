# S11b report — E-invoicing onboarding, submission queue, delivery gating (M03 sprint 11, second half)

Status: implemented and verified against real PostgreSQL and a **simulated** e-invoicing server (see §E). **Not committed.** **Everything here is `NOT VERIFIED vs ZATCA`:** no official ZATCA documents were supplied (HG-03-03), the simulated server implements **our own contract**, and nothing in this repository can contact a ZATCA environment. With S11b the S11 scope is done as far as it can be without the official documents; S12 (reconciliation, reports, UIs, M03 report) is next.

## A. Repository findings and assumptions
- **The "mock ZATCA server" is a simulated adapter, not ZATCA.** The M03 prompt asks for a mock implementing "only behaviours documented publicly as the owner supplies them". The owner supplied none, so the server (`SimulatedZatca`, behind the `EInvoiceAdapter` interface of ADR-014) implements the contract *we* defined: OTP + CSR → compliance credential, compliance checks, production credential, submit (clearance for standard, reporting for simplified), lookup by document uuid, and scenarios (accept, accept with warning, reject, unavailable, timeout). Its only "validation" is internal consistency of a stamp (hash and signature). Deviation recorded: it lives in `modules/invoicing/internal/zatca/` instead of `packages/testing` because the API is its only consumer; moving it is mechanical.
- **Spec additions (docs/04):** `POST …/onboarding` takes an optional `otp` (approval body) and a `{stepId, decision}` body for the second person; the permissions `admin:zatca:manage` (finance, platform admin) and `admin:zatca:approve` (security, platform admin) are new (`security` also gets `admin:billing:read`). The docs/04 text "finance + security (two-person for credential steps)" is implemented as request (finance) and approve (a different person).
- **Only the compliance credential needs the OTP** in this contract; the production credential is requested with the compliance credential. The real rule is for the official documents to say.
- **Backoff shape.** After a failed attempt the document has an `error` row followed by a `queued` row with the delay (doubling from `ZATCA_BACKOFF_SECONDS`, default 60 s); after `ZATCA_MAX_ATTEMPTS` (default 6) it stays at `error` as a dead letter until a person retries it. `rejected` is terminal (docs/11: a rejected issued document is corrected by credit note and new invoice, never resubmitted).
- **Delivery gating** is implemented for **invoice PDFs and XML** (standard invoices only, only when `ZATCA_MODE` is on). **Credit-note PDFs are not gated yet** (a B2B credit note is also a standard document); recorded as a gap.
- **Credential renewal and key rotation are NOT built**: a completed onboarding step cannot be redone in this build (the official renewal and expiry rules are needed).
- **Automatic generation is opt-in:** the scheduler creates e-invoices only from `ZATCA_GENERATE_FROM` (unset = never), so switching the mode on cannot back-fill history.
- **platform-scope allow-list** now includes `modules/invoicing/` (the cross-tenant console reads submissions and onboarding); guard test updated.

## B. Plan and changed files
- Migration `invoicing/0331__invoicing__zatca_onboarding_submissions` (+down): `zatca_onboarding`, `zatca_credentials_refs` (tenant-less, admin scope, vault references only), `zatca_submissions` (append-only), cleared-XML columns on `zatca_documents`, the permissions, and the security-definer work-list functions (`zatca_active_credential`, `zatca_pending`, `zatca_unprocessed`). `spec/db/ownership.yaml` lists the two tenant-less tables.
- Spec: 4 operations (**112** in total), `Invoice.zatca.state` enum, `getInvoiceXml` described; SDK regenerated.
- Code (`modules/invoicing/`): `internal/zatca/{adapter,simulated-adapter,secrets,submission-log,onboarding.service,submission.service,pipeline.service}.ts`, `admin-zatca.controller.ts`, `invoices.controller.ts` (XML), `invoice.service.ts` (status overlay, PDF gate), module wiring and exports; `subscriptions/billing-scheduler.ts` (e-invoicing step); `platform-scope.spec.ts`; `.env.example`.
- Tests: `zatca-queue.int.spec.ts` (17 integration), `zatca-queue.spec.ts` (3 unit); `dunning.int.spec.ts` scheduler stub.
- Docs: `docs/runbooks/zatca-onboarding.md`, `docs/runbooks/zatca-queue-stuck.md`.

## C. Implemented features, API and screens
| Area | What exists |
|---|---|
| Onboarding | `GET/POST /v1/admin/billing/zatca/onboarding`: csr → compliance_csid → compliance_checks → production_csid, in order; credential steps by two different people (service and database refuse the requester approving); one pending request at a time; rejected requests free the slot; production and other environments refused (422); steps run against the simulated server |
| Secrets | OTP never stored or logged (tests scan onboarding results, credential rows and audit logs); credential token and secret in the vault by reference; only references reach the database and they are not even shown by the API |
| Compliance checks | three synthetic sample documents (standard, simplified, credit note), stamped and checked; never stored, never in the chain |
| Queue | append-only state rows with a database-checked state machine; claim by insert (one worker wins); backoff; dead letter; manual retry per document (idempotent; refused for decided and rejected documents) |
| Reconcile before retry | a timeout is resolved by looking the document up: a decision that exists is adopted (0 duplicate submissions, tested) |
| Gating and status | standard invoices are not delivered (PDF/XML) before clearance; `GET /v1/billing/invoices/{id}` carries `zatca {state, uuid, qr}`; `GET …/xml` returns the cleared XML (standard) or the stamped XML (simplified), 409 when there is none; cleared XML is stored once and archived |
| Reporting window | per simplified document: seconds left, alert at 50%, breach at 100% (config from the profile) |
| Pipeline | generate (from the cutover date) → stamp (once a production credential exists) → queue → submit, as a step of the billing scheduler tick |
| Console | `GET …/submissions` (filters state, org, deadLetter; pagination), `POST …/submissions/{id}/retry`; the UI screens (UI-M03-18/19) are S12 |

## D. Migrations and rollback
`invoicing/0331` as in §B; dev-only `.down.sql` exercised (rollback → migrate → `db check` OK); production is forward-fix (onboarding and submission history are compliance records, never dropped).

## E. Tests run (actual)
`pnpm verify:full` → **EXIT=0** in one run:
- lint, typecheck (19/19), build (11/11), `spec:lint`, `spec:drift` (**112** operations), `sdk:check`, `scan:secrets` 1,437 files / 0 hits, `zatca:guard` OK (the generator was not touched in S11b).
- Unit: api **301** (+3), web 38, i18n 9, db 9, ui 7, domain 6, admin 5, worker 5, sdk 4, telemetry 3. Browser E2E: 6 passed.
- `db check` OK; integration: db 43, platform 32, worker 8, **api 534** (+21) = **617**.
- Highlights: the full onboarding with two people per credential step, a wrong OTP failing and being re-requested, and no OTP or secret value anywhere in the database or audit log; documents wait for credentials, then stamp and clear; standard held until cleared, simplified reported; unavailable server → backoff (60 s) with an alert and the invoice held, then cleared on return; backoff 60/120/240/480/960 s then a dead letter, not retried automatically, retried by finance once (second retry idempotent), then not retryable once decided; timeout reconciled by lookup with 0 duplicate submissions; rejected document final (no resubmission, retry refused with the reason); 5 concurrent workers submit 3 queued documents exactly 3 times; window alert/breach; the database refuses updates, deletes, illegal transitions, gaps in sequence, a raw secret as a reference, and the requester as approver; e-invoicing off does nothing.

## F. Security, tenant isolation, billing, residency verification
- Admin realm + step-up on every mutation; finance cannot approve, security cannot request, support cannot read; customers see only their own invoices' status and XML (another organization gets 404).
- No secret values in the database, logs, audit or API responses; the vault and secret store are development implementations refused in a production profile (D-12).
- RLS forced on `zatca_submissions`; onboarding and credentials are tenant-less and admin-scope only; the runtime reads credential references and work lists through security-definer functions that expose ids and references, never other tenants' content.
- Residency: unchanged (`data_region` copied; archive is a local directory; in-Kingdom store is D-15/M04).

## G. Human gates and live checks still needed
**HG-03-03 (BLOCKED):** official ZATCA specification set, Fatoora portal access, EGS unit registration, the one-time password, real key custody (D-12), the CSR attributes, the owner's decision and evidence for production. Until then nothing is verified against ZATCA. Also HG-03-01 (registered seller entity), HG-03-04 (tax advisor: failure policy for unavailable clearance, credit-note handling), D-11, D-34.

## H. Acceptance (S11 rows)
| Row | Status |
|---|---|
| Document builders, UBL XML, hash chain, QR, signing, archive | PASS on the synthetic profile / **NOT VERIFIED vs ZATCA** (S11a) |
| Onboarding state machine with two-person credential steps | PASS (simulated server); **NOT VERIFIED vs ZATCA**; real onboarding BLOCKED (HG-03-03) |
| Submission queue/worker with backoff, DLQ, manual retry, idempotent per uuid | PASS (simulated server) |
| Clearance gating of standard invoices, reporting queue and window SLO | PASS for invoice PDF/XML (credit-note PDF not gated yet) |
| Archive of cleared XML | PASS (local WORM store); retention config and in-Kingdom store pending D-34/D-15 |
| Mock server of publicly documented behaviours | PARTIAL: simulated server of our own contract (nothing documented was supplied) |
| Official XSD/Schematron validation, golden files from ZATCA samples | BLOCKED (no artifacts) |
| Credential renewal and key rotation | NOT DONE |
| Live sandbox compliance checks (`LIVE-VERIFIED (sandbox)`) | BLOCKED (HG-03-03) |
| UI-M03-18/19 | NOT DONE (S12) |

## I. Handoff and open decisions
- **S12:** `finrec` (RC-01..RC-06; RC-05 compares ZATCA submissions with invoices, on the simulated data), revenue reports, the 21 UI screens (UI-M03-01..21 including the onboarding wizard and the submissions console), notifications, remaining runbooks, the M03 report with the **tax-advisor question list** (all [VERIFY] items) and the PSP/ZATCA live-status table, and the M03 gate review.
- **Owner:** supply the official ZATCA documents (this unblocks the pin, goldens and real validation); register the seller entity (HG-03-01); D-11; D-12; and decide the delivery-gating failure policy with the tax advisor.
