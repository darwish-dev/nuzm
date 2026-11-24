# PHASE2-02 — owner-approval inputs for D1–D9 (for the Master's OWNER-APPROVAL-PACK)

Author: Session 02 · Date: 2026-11-24 · **Nothing here is decided.** Each block is written so the owner can answer in one line and the Master can paste it. "Blocks development" = engineering cannot proceed without it (none do: everything below is built and tested offline); "blocks activation" = a live call, a customer-data transfer or a paid action cannot happen until it is answered. Sources: `docs/ai-intelligence/S-AG4-DECISIONS.md`, `S-AG4-PRICING.md` §5, `S-AG4-SPEND-CAPS.md`, `docs/parallel/LIVE-PROVIDER-PLAN.md`, `OWNER-DECISIONS.md`. Costs are hard maxima at the **public list price read 2026-11-24** ($4 input / $20 output per million tokens, Claude Opus 5.5), not a quote.

**Order the owner answers in (each unlocks the next):** D2 → D5 → D6 → D4 → D3 → D9. D1 is independent (only customer content needs it). D7 and D8 are already approved (recorded 2026-11-22); they are listed so the pack is complete.

Evidence the runner reads: one row per decision `{decision, ref, recordedBy, recordedAt, provider: "claude", environment: "non-production", outcome}`. The owner supplies the **reference** (a signed-document id, ticket or dated message), never a secret.

---
## D1 — Residency for customer data sent to Claude (D-18)
- **Question:** May customer data (`customer-content`, `personal`) be sent to Claude at all, and under which option: (A) in-Kingdom processing only, (B) the external API with an approved transfer assessment per organization and data class, (C) hybrid?
- **Recommended:** **A until a transfer assessment exists**; until then Claude receives `public` and `internal` content only (the probe and the live suite send constants of public text).
- **Alternatives:** B (requires counsel's memo, a per-class assessment, an organization policy permitting the destination country, a ROPA entry); C.
- **Evidence to close:** the option chosen; for B/C the approved, unexpired assessment and counsel memo; ROPA entry.
- **Cost:** none direct.
- **Security / legal impact:** the highest of all rows: an international transfer of customer data. The vendor's public pages mention only `global` and `us` inference geography (1.1x for `us`) and no in-Kingdom option (**absence on a page is not a statement**).
- **Blocks development:** no. **Blocks activation:** any customer-content call and the agent on customer projects. **Not needed** for the probe or the live suite.

## D2 — Claude API agreement and data terms (HG-09-01)
- **Question:** Has the owner (a human) reviewed and accepted the vendor's agreement and data terms, and what do they state for: retention of prompts, training on data, processing region, sub-processors, DPA, deletion, breach notification?
- **Recommended:** accept only after legal review; **attest only what the contract states, `unknown` otherwise** (the admin `attest` action takes a reference and the flags).
- **Alternatives:** decline; the provider stays disabled (no live path).
- **Evidence to close:** the agreement reference; the nine answers of `S-AG4-PREP.md` §1; `attest` recorded. The terms of use on consumer credentials (this plan uses API keys only) should be part of the review.
- **Cost:** none (accepting terms is not a charge; usage is billed separately).
- **Security / legal impact:** contractual protections for everything sent; decides what may ever be sent.
- **Blocks development:** no. **Blocks activation:** enabling the provider; any live request including the probe. **The agent never accepts terms.**

## D3 — Open the live gate in one named non-production environment
- **Question:** In which named non-production environment may `AI_LIVE_PROVIDERS=claude` be set, from when, and may the key-validating connection test (model listing, no prompt, nothing billed) come before any model call?
- **Recommended:** open it **last**, after D2, D4, D5, D6, in one environment, with the connection test first; close it again after the verification run.
- **Alternatives:** keep it closed (everything stays offline).
- **Evidence to close:** written approval naming the environment and date; D2 and D4 done.
- **Cost:** enables paid calls (bounded by D4/D9).
- **Security / legal impact:** opens network egress from that environment to the vendor's fixed host (the host is fixed in code, never from configuration). A second lock exists inside the adapter.
- **Blocks development:** no. **Blocks activation:** every live request.

## D4 — Dedicated non-production key with a vendor-side monthly cap
- **Question:** Who creates the key, in which vendor workspace, with what **monthly spend cap**; who stores it (admin console only), rotates it (suggested 90 days) and may revoke it?
- **Recommended:** a **dedicated workspace** (not the Default Workspace: limits there may not count some usage), a dedicated key inside it, a workspace cap of **USD 5 per month** to start (`S-AG4-SPEND-CAPS.md` §2, §4), the platform cap at ≤ 80% of it. The owner types the key into the admin console (`Save Claude key`); it is sealed in the non-production vault; only `vault://dev/ai-claude` is stored or shown. **The key is never pasted into chat, code, a file, a report or a screenshot** (tests prove it never appears in responses, audit events, any database column, or process output: `credential-leak.int.spec.ts`).
- **Alternatives:** none acceptable (a shared or personal key would defeat the cap and the audit).
- **Evidence to close:** workspace name; cap amount and currency; date; who set it; key owner; rotation date. **No key.**
- **Cost:** the cap amount is the worst-case spend; the planned verification costs at most **USD 0.197440** in total (`LIVE-PROVIDER-PLAN.md` §6).
- **Security / legal impact:** credential custody. Production custody (the production vault) is **D-12, a separate, open decision**: nothing here stores a key in production (the admin action refuses).
- **Blocks development:** no. **Blocks activation:** the connection test, the probe and the suite.

## D5 — Region statement and ROPA entry for `claude`
- **Question:** What region and sub-processors does the contract state for Claude, and which data classes and purpose go into the ROPA processor entry?
- **Recommended:** state **only what the contract says**; leave the region `unspecified` (which residency never treats as in-Kingdom) until it says otherwise.
- **Alternatives:** none (an invented region would be a false compliance record).
- **Evidence to close:** region and sub-processors from the agreement; ROPA entry saved.
- **Cost:** none. **Security / legal impact:** a compliance record; decides residency "allow" for any class.
- **Blocks development:** no. **Blocks activation:** residency "allow" for any class (public-only runs still need the provider to be enabled, which needs this record).

## D6 — Customer rate card, currency and VAT treatment
- **Question:** What do customers pay per million input and output tokens of `claude-opus-5-5` (credits per million), in which currency, with which FX source and rounding, and what VAT treatment?
- **Recommended:** list price plus the owner's margin, **versioned** (the platform keeps every version append-only: `GET /v1/admin/ai/model-providers/{id}/rate-card-versions`); integer credits; round **up**; an explicit FX source with a stale-rate refusal (`StaticFxRateSource`, `deriveRateCard` gives a preview, never a default). Inputs available: vendor cost $4 / $20 per MTok (**to be confirmed against the agreement or the console**, HG-09-01).
- **Illustrative arithmetic only (synthetic FX and margin, NOT a proposal):** at an illustrative 3.75 SAR per USD and a 20% margin, $4.00 → 1,500 halalas → 1,800; $20.00 → 7,500 → 9,000 credits per million at 1 credit = 1 halala. The owner supplies the real FX policy, margin (basis points), credit unit and VAT.
- **Alternatives:** a different margin or tiering.
- **Evidence to close:** confirmed vendor price; the signed-off rate card version with its effective date.
- **Cost / revenue:** sets revenue and margin. The platform never computes a margin by itself.
- **Security impact:** none. **Blocks development:** no. **Blocks activation:** enabling the provider (the gateway refuses a model with no rate-card entry).

## D7 — OpenAPI delta of SCR-K-11 (**approved 2026-11-22**, applied)
Variant B (one boolean `supportsTools`, provider fields `contractVersion`, `liveCallsApproved`, actions `record_capability_evidence` and `probe_tool_use`). Nothing further is asked. Recorded in `S-AG4-DECISIONS.md` §5.

## D8 — Declare tool calling only from recorded probe evidence (**approved 2026-11-22**, implemented)
Evidence table `ai.model_capability_evidence` (migration 1870); a real provider's tool calling counts only while the latest row is `VERIFIED` for the adapter's current contract. Nothing is verified yet, so **no tool is offered to any real provider**. The rows come from the probe (L11 of `LIVE-PROVIDER-PLAN.md`). Nothing further is asked.

## D9 — Approve the bounded verification run (the probe and the nine-check suite)
- **Question:** Approve the run described below, in one named non-production environment, for execution once D2–D6 are recorded?
- **Recommended:** **approve after D2–D6**; the first run is a **dry run** the owner reads (it prints the plan and the worst-case cost and sends nothing).
- **Scope and bounds (computed, not typed: `probeCost()`, `liveSuiteCost()`):**
  | Instrument | Requests (max) | Tokens (max) | Hard maximum | Ceiling (all tokens as output) |
  |---|---|---|---|---|
  | `probe_tool_use` (writes the D8 evidence rows) | 8 | 11,716 | **USD 0.080720** | USD 0.234320 (**under the earlier USD 0.24 bound**) |
  | Nine-check suite (includes the whole probe) | 13 | 14,716 | **USD 0.116720** | USD 0.294320 |
  | Both | 21 | 26,432 | **USD 0.197440** | USD 0.528640 |
  No retries (adapter `maxRetries: 0`, the harness never repeats a request); thinking tokens are billed as output inside each request's `max_tokens`; the contents are constants of public text (no customer, organization or project data); nothing a model returns is executed.
- **Approval record to fill (becomes `AI_PROBE_APPROVALS` and `approval.json`):** `ref`, `approvedBy`, `environment: non-production`, `maxRequests` ≥ 13 (suite) / 8 (probe), `maxTotalTokens` ≥ 14,716 / 11,716, `maxCostNano` ≥ **116,720,000** (nano-USD; the runner refuses a lower figure).
- **Evidence to close:** the approval record; the report file; the reconciliation against the vendor figure.
- **Alternatives:** defer (the provider stays unverified; the router never offers tools on Claude).
- **Security / legal impact:** public content only; the live gate and the vendor cap bound it; the run never reads the key until every gate holds.
- **Blocks development:** no. **Blocks activation:** the verification itself (and therefore every LIVE-VERIFIED claim).

---
## What the owner will see in the pack (one line each)
D1 option? · D2 agreement reference and flags? · D3 environment and date? · D4 workspace, cap, key owner, rotation? · D5 region and ROPA text? · D6 the numbers and VAT? · D9 approve the bounded run (≤ USD 0.197440)? · D7/D8 already approved.
## Still open and **not** part of this package
D10 confirmed 2026-11-22 · D11 sequencing approved (OpenAI/Gemini contracts and fixtures only) · D12 (production vault D-12, D-21, D-42, thresholds) stays closed · the OpenAI and Gemini adapters (each would need its own D1/D2/D4/D5/D6/probe cycle, or an approved `DEFERRED` entry).
