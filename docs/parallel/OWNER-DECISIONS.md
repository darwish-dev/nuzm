# Owner decisions (one checklist; no session stops for these)

Detailed approval rows with references live in `docs/ai-intelligence/OWNER-APPROVAL-CHECKLIST.md`; this table adds the fields the parallel phase requires. "Continues" = other implementation proceeds meanwhile (always yes).

| ID | Description | Recommended | Alternatives | Technical impact | Financial impact | Security impact | Evidence required | Milestone | Continues |
|---|---|---|---|---|---|---|---|---|---|
| D1 | Residency for customer data sent to Claude | (A) in-Kingdom only until a transfer assessment exists | (B) external API with assessment; (C) hybrid | gates customer-content routing | none direct | highest: data transfer | approved assessment / option record | S-AG4 | yes |
| D2 | Claude agreement and data terms (HG-09-01) | review, then attest with a reference | decline: provider stays disabled | `attest` action | none | contractual protections | agreement reference, flags | S-AG4 | yes |
| D3 | Open live gate in a named non-production environment | after D2, D4, D5, D6 | keep closed | `AI_LIVE_PROVIDERS` | enables paid calls | opens network egress to vendor | environment name | S-AG4 | yes |
| D4 | Dedicated non-production key with vendor-side monthly cap | dedicated key, low cap | none acceptable | `save_claude_key` | cap amount | credential custody | owner-created key, cap record | S-AG4 | yes |
| D5 | Region statement and ROPA entry for `claude` | state only what the contract says | — | provider row + ROPA | none | compliance record | contract text | S-AG4 | yes |
| D6 | Customer rate card and currency/VAT treatment | list price + margin, versioned | other margin | rate card config | revenue/cost | none | the numbers, effective date | S-AG4 | yes |
| D9 | Approve the bounded probe (≤ 8 requests, ≤ 11,716 tokens, ≈ USD 0.08, bound 0.24) | approve after D2–D6 | defer | `AI_PROBE_APPROVALS` | ≤ USD 0.24 | public content only | approval record | S-AG4 | yes |
| D11 | OpenAI/Gemini sequencing | after Claude is verified | build in parallel | adapters | per provider | per provider | decision | S-AG4 | yes (contracts and fixtures only) |
| D12 | D-12 production vault, D-38, thresholds | decide separately | — | vault | cost | key custody | decisions | S-AG4/5/6 | yes |
| AC-AG-10 | Accept/change the 11 PROPOSED thresholds (and any session 03 additions) | accept after review | adjust | rollout gate | none | none | dated acceptance | S-AG5 | yes |
| REV | Named human reviewers + acceptance bar | name two | none | reviewer workflow | reviewer time | none | names | S-AG5 | yes |
| BUD | Benchmark spend budget | small fixed cap | none | budget enforcement | the cap | none | the number | S-AG5 | yes |
| SEC-AG | Agent security review (named reviewer) | schedule after S-AG4 | — | review | reviewer time | high | report | S-AG5 | yes |
| D-21 / HG-10-02 | Isolation technology and review | gVisor or Firecracker on dedicated nodes (see Session 04 recommendation when delivered) | Kata | runtime | nodes | highest | review report | S-AG6 | yes |
| ADR-067 | Accept the Execution Gateway design | accept after Session 04 hardening | amend | gateway | none | high | acceptance | S-AG6 | yes |
| LEGAL-EXEC | Terms/liability for customer-code execution | legal review | disallow | none | legal | high | sign-off | S-AG6 | yes |
| D-42 | Production rollout | after all above | — | flags | — | high | sign-off | all | yes |
| HG-05/06 | Real hosting target for deployment verification | provide a sandbox target | stay simulated | deploy verification | hosting cost | medium | target and credentials by the owner | deployment | yes |
Workers append newly found decisions to their report; the Master merges them here.
