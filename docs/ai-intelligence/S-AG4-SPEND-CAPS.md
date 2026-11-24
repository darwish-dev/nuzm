# S-AG4 — spending caps: the vendor-side monthly cap and the platform-side caps (procedure)

Date: 2026-11-24 · Status: **PROCEDURE WRITTEN, NOT EXECUTED. No vendor console was opened, no cap set, no key exists.** Setting the vendor-side cap is a human act in the vendor's console (D4). Everything below about the platform side is built and tested offline (mock vendor).

## 1. Two lines, in this order
1. **First line, ours (platform):** every call reserves credits before it is sent and is refused when a cap cannot cover it. These caps are sized to stop calls **before** the vendor-side cap is reached.
2. **Second line, the vendor's:** a monthly spend limit on the dedicated key's workspace. It protects against a defect in line 1 (a bug, a misconfigured budget, a leaked key used elsewhere). It is not the mechanism we expect to trigger.
Rule: **platform cap ≤ 80% of the vendor cap**, so the platform stops first with a margin for tokens the vendor counts and we do not (cancelled streams, the 30% tokenizer uncertainty, a late usage report).

## 2. Vendor side — the owner does this (D4); nothing here is automatable by the agent
Facts read on 2026-11-24 from the vendor's public documentation (`S-AG4-PRICING.md` §5.4): the organization has an automatic tier cap (Start USD 500, Build USD 1,000 per month, higher tiers above); the owner may set **their own, lower** limit at the organization level (Console → Settings → "Spend limits") and **per workspace** ("Workspace limits"); a workspace limit cannot exceed the organization's; spend limits cannot be set on the Default Workspace and may not count some usage there. **Who may set a limit: NOT STATED.**
Procedure for the owner (record each step's result as an evidence row, never a screenshot of a key):
1. In the vendor Console create a **dedicated workspace** for non-production use of Nuzm (not the Default Workspace). Record its name.
2. Create the **dedicated key inside that workspace** (the key is shown once: put it straight into the Nuzm admin console, `Save Claude key`; never into chat, a file, a ticket or a screenshot).
3. Under Spend limits → Workspace limits set the **monthly limit for that workspace** to the figure in §4 (start at the amount of the first approved run, e.g. USD 5; raise it only by a dated decision).
4. Optionally set the same or a lower **organization** limit while only this workspace is in use.
5. Record: workspace name, cap amount and currency, date, who set it, key owner, rotation date (suggest 90 days), and who may revoke (the Console key list). These are the D4 evidence fields.
6. Confirm the cap works **without spending**: the Console shows the limit; do **not** test it by exceeding it. (Exceeding it is what the offline mock does for us.)
What the vendor does at a limit (documented): an owner-set organization or workspace limit answers HTTP 400 `invalid_request_error` ("You have reached your specified …"); the automatic tier cap answers HTTP 429 `rate_limit_error` with `enforced_spend_limit_reached` and no retry hint; access returns at 00:00 UTC on the first day of the next month unless the limit is raised.

## 3. Platform side — what is built (all enforced in the gateway before the vendor is reached)
| Line | Where | What it does |
|---|---|---|
| Kill switch | admin action `kill_switch` | every call refused |
| Wallet balance | `BudgetService.reserve` | `insufficient_credits` (402) when the balance cannot cover the reservation; nothing is sent |
| Organization daily credits | `PUT /v1/ai/budgets` `org.dailyCredits` | `budget_exceeded` when today's spend plus the reservation passes the cap |
| Per-run credits / tokens | run budget (`runBudget.maxCredits`, `maxTokens`) | stops a run, not the organization |
| Project and total budgets | `PUT /v1/ai/budgets` | same, per project / lifetime |
| Per-call ceiling | `max_tokens` on every request | no request can use more than it declared; thinking tokens count inside it |
| Probe / verification caps | `AI_PROBE_APPROVALS`, suite approval | requests, tokens **and** money ceilings; refused before sending when below the worst case; a running total stops the run before a request that could pass the cap |
| Vendor spending-limit answer | `AnthropicModelAdapter` | the documented limit answers are **not retried**; the provider's other models (same account, same limit) are **not tried** (fixed 2026-11-24) |
The platform's money unit: credits (integers) at the rate card; the vendor's cost: `cost_minor` in the vendor's currency (`ai.model_usage`). The usage report (`GET /v1/admin/ai/usage`) shows our cost per provider so the operator can compare it with the vendor console.

## 4. Sizing the caps (the owner decides the numbers; D4/BUD)
- **Probe / verification run:** hard maximum **USD 0.116720** for the whole nine-check suite (probe alone USD 0.080720), `S-AG4-PRICING.md` §5.2–5.3. A vendor cap of **USD 5** for the dedicated workspace covers dozens of such runs and bounds any mistake to USD 5.
- **Platform daily cap** for the non-production organization used for live checks: at the rate card `R` credits per million tokens, a daily cap of `C` credits allows about `C / R × 1,000,000` tokens per day. Choose `C` so that its USD equivalent at cost is **≤ 80% of the vendor cap divided by the number of days you want it to last**.
- **Benchmarks (S-AG5)** need their own, larger budget (BUD) and a vendor cap sized for it: not part of this procedure.
Worked example (synthetic numbers, not a decision): vendor cap USD 5 / month; platform daily cap equivalent to USD 0.50 / day at cost → at most USD 15 a month if never raised, so also set the organization **total** budget to the equivalent of USD 4 (80% of 5). The first of the two caps reached stops the calls.

## 5. Tests that prove the order (offline, mock vendor)
`apps/api/src/modules/ai/spend-caps.int.spec.ts` (5 tests): (1) a daily credit cap below the vendor cap ends the calls with `budget_exceeded`, the vendor mock is **never** refused and is **not called again** after the denial, and the charged credits never pass the cap; (2) a wallet that cannot cover the reservation stops the call before any vendor request; (3) a one-credit daily cap stops the call before the adapter is reached and holds no reservation; (4) a per-run credit cap stops the run and the vendor sees only the calls the cap allowed; (5) when the **vendor** cap is the lower one, the refusal is not retried (exactly one refused request), the provider's other models are not tried, nothing is charged for the failed call and no reservation stays held. Adapter level: `anthropic.spec.ts` maps the documented 429 and 400 spending-limit shapes to non-retryable `rate_limited` and leaves ordinary 429/400 answers unchanged.
**NOT VERIFIED (needs the live vendor):** that the real vendor answers with exactly the documented shapes at its limit (the mapping follows the documentation; it was never exercised against the real service, and must not be: exceeding a real cap is not a test we run).

## 6. Operating rules
- A change of either cap is a dated decision with a reference; raise the platform cap only after checking the vendor cap still exceeds it by the margin.
- When the vendor console shows spend above what `GET /v1/admin/ai/usage` reports for the same window, stop and investigate (the usage reconciliation check of the live suite compares them; a gap is a defect in accounting or a key used elsewhere).
- Rotating or revoking the key (vendor console, then `Clear credential` in the admin console) is the emergency stop for the vendor side; the kill switch is the emergency stop for the platform side.
