# AI Agent Engine — owner approval checklist (one page)

Date: 2026-11-24 · Source of each row: `S-AG4-DECISIONS.md`, `S-AG4-PROBE-PLAN.md`, `S-AG4-PRICING.md`, ADR-066, ADR-069 (proposed). **Nothing here is decided; no live provider, customer-data transfer or executable tool is enabled.** Tick a row only with a reference (ticket, signed document, dated message).

## A. Needed to run the one bounded live probe (S-AG4 close-out) — all must be YES before anyone sets `AI_LIVE_PROVIDERS`
| # | Decision | Who | You provide | What engineering does next (already built) |
|---|---|---|---|---|
| D2 / HG-09-01 | Accept the Claude API agreement and data terms (retention, training use, region, sub-processors, DPA, deletion, breach notice) | owner + legal | agreement reference; the flags as the contract states them | admin `attest` with that reference |
| D4 | A **dedicated non-production** key with a vendor-side monthly spend cap; who creates, stores, rotates, revokes | owner | the key, entered only in the admin console (`save_claude_key`); the cap amount | the key is sealed in the secret store; never logged |
| D5 | Region statement for the provider row and the ROPA processor entry for `claude` (state only what the contract says) | legal | region text, data classes, purpose | configure + ROPA entry |
| D6 | Customer rate card for `claude-opus-5-5` (credits per million input / output tokens), currency, VAT | commercial | the two numbers + effective date (list price read 2026-11-22: $4 / $20 per MTok) | versioned rate card; the provider cannot be enabled without it |
| D3 | Open the live gate in one named non-production environment (`AI_LIVE_PROVIDERS=claude`); the key-validating connection test may precede model calls | owner (tech) | environment name; yes/no for the connection test | two-person enable (a second platform admin) |
| D9 | Approve the bounded probe: ≤ 8 requests, ≤ 11,716 tokens (about USD 0.08, upper bound USD 0.24), public content only | owner | an approval record: `ref`, `approvedBy`, caps — set as `AI_PROBE_APPROVALS` (JSON) in that environment only | `probe_tool_use` runs once and records `VERIFIED`/`NOT VERIFIED` evidence rows |
Not needed for the probe: D1 (it sends only public constants).

## B. Needed before any customer content reaches a model
| # | Decision | You provide |
|---|---|---|
| D1 / D-18 | Residency option for Claude: (A) in-Kingdom only, (B) external API with a transfer assessment, (C) hybrid; whether `customer-content` / `personal` may be sent at all | the option and, for B/C, the approved transfer assessment |
| D-31 (proposal) | Usage reconciliation tolerance (proposed 1 %) | accept or change |

## C. S-AG5 (benchmarks and rollout gates) — can be accepted now, run later
| # | Decision | You provide |
|---|---|---|
| AC-AG-10 thresholds | Accept, change or reject the 11 PROPOSED thresholds in `S-AG5-BENCHMARKS.md` §4 (version `1-proposed`) | a dated acceptance |
| Human acceptance | Named reviewers and a protocol; proposed bar 0.70 accepted | names; protocol |
| Benchmark spend | A token/credit budget and the vendor cap sized for it (the offline suite costs nothing) | the numbers |
| Agent security review | A named reviewer for injection, tenant isolation, secrets, tool abuse | the name and date |

## D. S-AG6 (execution tools) — stays BLOCKED until all are YES
| # | Decision | You provide |
|---|---|---|
| D-21 | Isolation technology (gVisor, Firecracker or Kata on dedicated nodes) after the sandbox isolation security review (HG-10-02) | the decision and the reviewer's report |
| ADR-069 | Accept the Execution Gateway design (proposed) or change it | acceptance |
| Escape suite | Run on the real runtime; every isolating attempt BLOCKED | the run report (an owner-supplied sandbox environment) |
| Legal | Terms/liability for running customer-supplied code | legal sign-off |
| D-42 | Production rollout | decision + sign-off |
| D12 | D-12 production vault, D-38, AC-AG-10 thresholds | decisions |

## E. OpenAI and Google adapters (S-AG4 definition)
Either each gets its own D1/D2/D4/D5/D6/probe cycle (D11: after Claude is verified), or record `DEFERRED` as an approved change-log entry. Your call.
