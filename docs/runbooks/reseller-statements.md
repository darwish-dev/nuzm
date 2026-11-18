# Runbook — reseller statements, price rules and the issuer model (M11)

Owner: finance operations. Status: DRAFT. **D-24 (issuer-of-record model) is OPEN and HG-03-04 (tax advisor sign-off) is PENDING: no retail invoice for a sub-organization exists, and none can be enabled by configuration.**

## What a statement is
Per sub-organization and meter: wholesale cost (the platform's own rating of that organization's usage), retail (the price rule in force at the end of the period applied to it), margin, a PROVISIONAL VAT estimate, and the ledger figure for the same organizations (`ledger.wholesaleMinor`) with the variance. A closed period is stored once (`programs.reseller_statements`, immutable). The open month is computed on demand (`provisional: true`). CSV: `GET /v1/resellers/{id}/statements?period=YYYY-MM&format=csv` (cells starting with `= + - @` are neutralized).

## Month-end checks (RC-05/RC-06 handoff to M12)
1. For each reseller: statement `ledger.varianceMinor` must be `0`. A non-zero variance means a sub-organization usage invoice was not (yet) closed from the same rating: run `InvoiceService.periodClose` for the sub-organization, then re-read.
2. `totals.marginMinor = retailMinor − wholesaleMinor`; the sum of line retail equals `totals.retailMinor`.
3. Rule history: `GET …/price-rules` (`history`) — each PUT is a new version (append-only); the rule in force at period end is recorded per line (`ruleSetVersion`).
4. Issuer banner must read `disabled` (or BLOCKED with the reason). If it reads anything else, stop: the code constant `APPROVED_ISSUER_MODEL` was changed — that must be traceable to a reviewed commit after the D-24 decision and the advisor's sign-off.

## Price rules
- PUT needs `If-Match` = current version; effective date ≥ now + 1 day; negative markups are `below_cost` (422). Percent: `retail = wholesale + floor(wholesale × bps / 10000)`; fixed: `retail = wholesale + round-half-up(amountMinor × billable quantity)` (exact decimals). All money is integer minor units.
- A rule can never make a customer pay less than wholesale; there is no discount mechanism (marketing credits are M02).

## Scenario pack for the tax advisor (HG-03-04)
`StatementService.scenarios(statement)` produces a dry-run set of document lines for: wholesale (platform → reseller), retail (reseller → sub-organization + platform → reseller), refund (credit notes both ways) and marketplace (principal assumed). It creates no document. Give it to the advisor with real figures from a closed period; record their answer in docs/07 (D-24, HG-03-04) — the agent must not mark either decided.

## Sub-organization isolation
A reseller sees ids, names (active links only), meters and amounts. It never reads sub-organization content; there is no endpoint that could. Creating a sub-organization is not implemented (SCR-M11-08).
