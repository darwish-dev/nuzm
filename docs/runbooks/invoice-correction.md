# Runbook: invoice correction (credit note path) and period close

Status: implemented in S08b and exercised in `invoices.int.spec.ts`. Sandbox only: the seller entity is `PLACEHOLDER-NOT-REGISTERED` (HG-03-01) and every document is stamped `sandbox`. Tax treatment is [VERIFY] with the tax advisor (HG-03-04); ZATCA submission arrives in S11.

## Rules
- An issued invoice is a legal document. Nothing but `status`, `paid_minor` and the ledger link can change, and the database refuses every other edit (also for the table owner). A correction is **always** a credit note (or, later, a debit note), never an edit, a delete or a renumbering.
- Numbers are gapless per entity and series (credit notes use the invoice series plus `C`). A number is taken inside the issuing transaction, so a failed issue gives it back.
- A rated meter, an order item or a subscription charge is billed once, ever (unique source id on the line). Corrections to an already invoiced period go through credit notes, not through re-issuing the period.

## Period close (one idempotent operation per organization, period and entity)
`InvoiceService.periodClose(orgId, 'YYYY-MM-01')`: rating run → lines (rated usage grouped by meter; order items not yet invoiced; zero-priced usage stays on the usage statement) → per-line tax → issue (number, rows, audit, `invoice.issued` event) → ledger posting (`invoice:<id>`). Running it again returns the same invoice and creates nothing (tested: no invoice, line, ledger row, event or rating run). Unpriced usage is reported in the result, never dropped. There is no HTTP trigger and no scheduler yet (the renewal worker of S10 will own the schedule).

If the process died between the commit and the ledger posting, `ledgerPosted` is `false` on the invoice; call the close again and it posts exactly once (idempotent key) and links it. RC-02 (S12) reports any invoice without a ledger link.

## Issuing a credit note
`CreditNoteService.issue(orgId, actor, {invoiceId, reasonCode, reason, sourceKey, lines?})`. Omit `lines` to credit everything still creditable. A part of a line is taxed at the line's rate; crediting what is left of a line takes its exact remaining tax (no rounding drift). It can never exceed what is left on any line or the invoice total (a trigger under the invoice row lock backs this up against races). `sourceKey` makes a repeat return the same credit note. Void invoices cannot be credited.

## Where a correction shows
Customer: `GET /v1/billing/credit-notes?invoice=<id>`; the credit note posts its own ledger transaction (Dr revenue + VAT, Cr receivable) and never touches the invoice postings. Refunds (S10) will call this service.

## Not yet
Debit notes, voiding an invoice through an endpoint, payment application (S09/S10), ZATCA XML/QR/stamp (S11).
