# Runbook: tax configuration and invoice numbering

Status: written against S08a (`invoicing` foundations); exercised in `invoicing.int.spec.ts`. Every rate and format below is a **[VERIFY]** item for the tax advisor (HG-03-04); nothing here is tax advice.

## Tax rates (configuration, not code)
- Rates live in `invoicing.tax_rates` (effective-dated: `valid_from` inclusive, `valid_to` exclusive; an exclusion constraint forbids two rates for the same jurisdiction and scope at any date). They are written **only by migrations** (no runtime role can change them; docs/04 defines no admin endpoint).
- Seed: `SA-VAT-STD` 1500 bps (domestic), and `SA-VAT-ZERO`, `SA-VAT-EXEMPT`, `SA-VAT-EXPORT` at 0 bps, all flagged `verify = true`.
- To change a rate: ship a forward migration that closes the old row (`valid_to`) and inserts the new one from the new date. Never edit a past rate: invoices already issued reference the rate in force on their date.
- Unknown cases are never silently zero-rated: no configured scope, a buyer outside the jurisdiction, or a scope without a configured rate use the standard rate **and** set `reviewRequired` with reasons (`scope_not_configured`, `buyer_outside_jurisdiction`, `no_rate_for_scope_<scope>`). A date with no rate at all is an error (503), not a zero.
- Rounding: per line at minor-unit precision, half-up by default (`TAX_ROUNDING=half_even` switches); the document total is the sum of the lines, so totals never disagree with lines.

## Buyer tax profile
`GET/PUT /v1/billing/tax-profile` (owner/billing admin). Format rules (VAT number, CR number, postal code, building number) are configuration (`TAX_*_REGEX`, defaults marked [VERIFY]). A b2b buyer needs a VAT number and a full address. The audit trail records which kind of profile changed, never the personal values.

## Billing entities
`invoicing.billing_entities` holds the seller. The seeded entity is `PLACEHOLDER-NOT-REGISTERED` (a table constraint forbids registration numbers on a placeholder). Loading the real entity (HG-03-01) is a migration by the owner's data; until then issuing outside sandbox is refused (S08b).

## Invoice numbers (gapless)
- `invoicing.allocate_number(entity, series)` is the only writer of `invoice_sequences`. Call it **inside the issuing transaction**: concurrent issuers queue on the row lock, numbers ascend by one, and a rollback gives the number back (tested: 200 parallel allocations → exactly 1..200; a rolled-back issue leaves no gap).
- Never allocate a number outside the transaction that stores the invoice, and never "fix" a counter by hand: a gap in a legal numbering series is an incident for the tax advisor. Corrections are credit notes, not renumbering.
