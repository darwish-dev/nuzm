# ADR-061: Model gateway, budgets and credit settlement

- Status: **Proposed** (D-18 model providers, D-23/D-25 credit pricing, HG-09-01 data terms are OPEN). Milestone M09 S37.

## Decisions
1. **One gateway.** Every model call goes through `GatewayService.invoke` (kill switch → outbound secret scan → candidates with a rate card → residency per provider → data-terms rule → ranking → budget reservation → call → settle). No provider is hardcoded; the registry is empty in production.
2. **A provider is enabled only with a human attestation of its data terms** (reference stored), a registered adapter, a rate card and a SECOND person; the database repeats the rules in CHECK constraints. Unknown terms mean "may retain / may train": blocked for personal, customer-content and financial classes unless an explicit policy flag says otherwise (default off). Credentials never go to a model.
3. **Credits are wallet money.** 1 credit = `AI_CREDIT_UNIT_MINOR` minor units (default 1) of the org's currency; the wallet (ledger account 2100) is the source of truth and `ai.credit_balances` is a projection minus open reservations. Each settled call posts ONE `usageChargeWallet` through `LedgerPostingService` (idempotency key per call id). The credit-denominated meter `ai.credits_consumed` is also emitted (tag `settlement=wallet`): the invoice builder must not bill it again (risk recorded for M03/M12). VAT on consumption is 0 here (HG-03-04).
4. **Pre-flight reservation under a per-organization row lock**, fitted against every level (balance, run, project, org day, org total); a retry reuses the reservation; a fallback is only another allowed candidate with its own reservation; a sweeper releases crashed calls.
5. **Rate cards are integers**: credits per million input / output tokens; cost is rounded up. No floats anywhere.
6. **Bodies are not stored** unless the org enables it with a retention (D-34), sealed with field encryption.

## Alternatives rejected
A separate credit ledger (a second source of truth for money); per-call billing outside the ledger (violates "only the billing posting service writes ledger rows").
