# Runbook — Correcting an invoice (credit-note path), M03

An **issued invoice is a legal document and never changes** (database trigger). A mistake is corrected with a **credit note** and, when the customer still owes something, a **new invoice**. Never edit invoice, ledger, payment or e-invoice rows.

## 1. Decide what went wrong
| Situation | Correction |
|---|---|
| Wrong amount, wrong quantity, a charge that should not have been made | Credit note for the affected lines (all or part), then a new correct invoice if something is still owed |
| The customer paid and is owed money back | Credit note **and** a refund (`zatca-queue-stuck.md` and `refund-procedure.md`); link the credit note on the refund so it becomes `refunded` |
| The buyer's tax data was wrong (VAT number, legal name) | Credit note for the whole invoice, fix the tax profile, new invoice: the issued document keeps the data it was issued with |
| Usage was rated wrong | Re-rating adds correction deltas (never edits); the next period's invoice carries them, or credit the invoice (RC-03 shows the difference) |
| The e-invoice was **rejected** | A rejected document is final: credit note and a new invoice, never a resubmission of an altered document (`zatca-queue-stuck.md`) |
| Provider/ledger posting is wrong but the invoice is right | Manual adjustment with two-person approval (`reversing-adjustment.md`); never touch the invoice |

## 2. How
1. **Credit note:** issue it against the invoice and its lines (it can never exceed what is left on a line or on the invoice; it gets its own gapless number and its own ledger entry that reverses the effect, never editing the invoice's postings).
2. **Refund** (if money goes back): finance requests it with the payment and the credit note id (`refund-procedure.md`).
3. **New invoice** (if the customer still owes the corrected amount): it is issued through the normal flows (period close, subscription charge); there is no manual "re-issue".
4. **Check:** the next reconciliation (RC-02 invoices and credit notes vs the ledger, RC-05 e-invoices) must show no new break for these documents.

## 3. Things that look like fixes and are not
- Voiding a paid invoice: not possible; use credit note and refund.
- Changing a customer's invoice PDF: the PDF is rendered from the immutable snapshot, so a reprint is identical.
- Deleting the e-invoice or its submission rows: refused by the database; a dead letter is retried, a rejected document is replaced by the credit-note path.

## 4. Tax-advisor items
Credit-note treatment of VAT, partial credits, the line mapping used for credit-note e-invoices, and wallet VAT are on the HG-03-04 question list (the M03 report).
