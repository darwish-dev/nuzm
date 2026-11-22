# S-AG4 decision review — final approval checklist (D1–D12)

Date: 2026-11-22 · Status: **PARTLY APPROVED. On 2026-11-22 the owner approved D7, D8, D10 and D11 (§5). Every other row is still PENDING and nothing live is enabled.**

## 0. What is and is not assumed
- The technical direction below was supplied by the owner on 2026-11-22 as a **proposal**: Claude first; provider-neutral architecture preserved for OpenAI and Gemini; a dedicated non-production credential with strict spending limits; live model calls disabled until terms, residency and security approvals are complete; `AI_ALLOW_UNATTESTED_SENSITIVE=false`; production and executable tools disabled; the bounded probe prepared and not executed.
- **Not assumed, and not done by the agent:** that Anthropic's terms are accepted (accepting terms is a human act); that any agreement, order form or data-processing addendum exists; that any international transfer of customer data is approved (no assessment, policy or counsel memo exists); that a credential exists or was created; that any rate is confirmed (list prices were only *read*, `S-AG4-PRICING.md`); that any capability is verified.
- Default behaviour until the owner decides otherwise (all enforced in code and tested): **no customer content can reach any external provider** (the Claude provider row has region `unspecified`, which the residency evaluation never treats as in-Kingdom; no attestation exists, so the provider cannot be enabled; the live gate `AI_LIVE_PROVIDERS` is empty).
- Categories used below: **TECH** (an engineering/security approval the owner can give now), **LEGAL** (counsel or compliance), **CONTRACT** (agreement or terms), **CRED** (a credential or vendor-account action only the owner can perform), **COMM** (commercial/pricing).

## 1. The checklist
Legend for "Can be approved now?": **Yes** = a technical approval that is safe to give today and does not enable anything live; **Partly** = the mechanism can be approved now, the act is gated; **No** = depends on a legal, contractual or credential step outside engineering.

| ID | Decision | Category | Proposed direction | Can be approved now? | Approver | Evidence required to close | Unblocks | Status |
|---|---|---|---|---|---|---|---|---|
| **D1** | D-18: residency option for Claude (A in-Kingdom only, B external API with transfer assessment, C hybrid) and whether Claude may receive `customer-content` or `personal` data at all | **LEGAL** | Your direction keeps live calls off until residency is approved. Engineering recommends B per organization and class only after counsel, otherwise `public`/`internal` content only. **No international transfer of customer data is approved by this document.** | **No** | Owner + counsel (HG-04-01, D-14, D-16) | Counsel memo; per-class transfer assessment approved and unexpired; organization policy permitting the country; ROPA entry | Any customer-content call; the agent on customer projects | OPEN |
| **D2** | HG-09-01: Claude API agreement and data terms; record the attestation reference and the flags (`retainsPrompts`, `trainsOnData`, region, sub-processors, DPA, deletion, breach notice) | **CONTRACT** (+ LEGAL review) | Sign or accept only after legal review; attest only what the contract states, `unknown` otherwise | **No** | Owner (a human accepts the terms) | The agreement reference; the nine answers of `S-AG4-PREP.md` §1; `attest` recorded with a reference | Enabling the provider; any live request, including the probe | OPEN, terms **not accepted** |
| **D3** | Open the live gate (`AI_LIVE_PROVIDERS=claude`) in a named non-production environment; and whether the key-validating connection test (model listing, no customer data) may precede model calls | **TECH** (act gated by D2, D4) | The mechanism and its default (closed) are approved now; opening is the **last** step; connection test first, model calls only after D1/D2 as applicable | **Partly** | Owner | Written approval naming the environment and date; D2 and D4 done | Any live request | Mechanism built; gate CLOSED |
| **D4** | Credential: a dedicated non-production vendor key with a vendor-side monthly spend cap; who creates, stores (admin console only), rotates and revokes it | **CRED** | As proposed: dedicated, non-production, strict limits; platform caps are a second line | **No** (only the owner can create it) | Owner | Key exists (never shared in chat or files); cap set in the vendor console (amount recorded); owner and rotation date named; stored with `save_claude_key` | Connection test; probe | OPEN, no credential exists |
| **D5** | Region statement for the provider row and the ROPA processor entry for `claude` (data classes, region, purpose) | **LEGAL / CONTRACT** | State only what the contract says. The public pricing page mentions only `global` and `us` inference geography (1.1x for `us`); it does not state an in-Kingdom option (absence on a page is not a statement) | **No** | Owner + counsel | Region and sub-processors from the agreement; ROPA entry saved | Residency "allow" for any class | OPEN, region `unspecified` |
| **D6** | Customer rate card for `claude-opus-5-5` (credits per million input and output tokens), currency conversion and VAT treatment | **COMM** | Set above cost with the owner's margin; version it. Inputs: list price read 2026-11-22 ($4 / $20 per MTok), to be confirmed against the agreement | **No** | Owner (+ finance) | Confirmed vendor price; signed-off rate card version | Enabling the provider | OPEN, no rate invented |
| **D7** | Accept the OpenAPI delta of SCR-K-11 (items 1–4) and choose the form of item 1 | **TECH** | Variant B: one boolean `supportsTools` instead of three new capability strings; provider fields `contractVersion`, `liveCallsApproved`; actions `record_capability_evidence` and `probe_tool_use`. **Validated** (§2) | **Yes** | Owner | This validation; your acceptance | Implementing the evidence table and admin actions | **APPROVED 2026-11-22**; applied (§5) |
| **D8** | Declare tool calling for Claude only from recorded probe evidence (replace the interim `AI_CLAUDE_CONTRACT` switch) | **TECH** | Yes | **Yes** (design); the evidence arrives with D9 | Owner | Evidence table implemented; a `VERIFIED` row | The agent loop on Claude | **APPROVED 2026-11-22**; implemented without the probe (§5) |
| **D9** | Approve the live probe plan: scope, worst case, the dedicated internal "platform probe" organization, who runs it | **TECH + COST** (execution gated by D2, D3, D4) | Approve the **plan** now; execution later. Worst case 11,716 tokens, about USD 0.08 at list price (bound USD 0.24) | **Partly** | Owner | The approval record of `S-AG4-PROBE-PLAN.md` §6 | LIVE-VERIFIED capability record (AC-AG-09) | Plan prepared, NOT executed |
| **D10** | Keep `AI_ALLOW_UNATTESTED_SENSITIVE=false`; production closed; executable tools closed | **TECH / security** | Confirm | **Yes** | Owner | Your confirmation | — | **CONFIRMED 2026-11-22** |
| **D11** | OpenAI and Gemini: sequencing | **TECH** (each needs its own D1/D2/D4/D5/D6 equivalent) | Preserve the neutral contract (it is: the probe, conformance kit and gateway are provider-neutral); no adapter work until Claude is verified | **Yes** | Owner | Your sequencing decision | Their own S-AG4 sub-slices | **APPROVED 2026-11-22** (sequencing) |
| **D12** | Still open, unchanged: D-12 (production vault), D-21 (execution isolation), D-42 (production rollout), AC-AG-10 thresholds, D-38 | **LEGAL / TECH / security** | Keep closed | n/a | Owner | See §3 | Production, executable tools, benchmarks | OPEN |

**Approvable today without enabling anything live: D7, D8 (design), D10, D11 and the plan part of D3 and D9.** **Cannot be approved by engineering, and are not assumed: D1, D2, D4, D5, D6.**

## 2. Validation done for D7 (OpenAPI delta)
- `scripts/scr-k-11-draft.ts` builds the proposal from the current spec into two **draft** documents (never into `spec/`): `draft-enum` (three new capability strings) and `draft-flag` (one boolean).
- **Spectral** (`spec:lint` rules, fail on warn): both drafts pass.
- **Backward-compatibility check** (`scripts/openapi-compat.ts`, rules in `packages/sdk/src/compat.ts`, 5 tests): `draft-flag` **0 breaking, 0 warnings**; `draft-enum` 0 breaking and **1 warning** (a value added to a RESPONSE enum: a client with a closed enum or exhaustive switch may need regeneration). Recommendation: variant B.
- **SDK generation** from both drafts succeeds; the generated types differ from the current ones only by additions (one existing line, the action union, is extended). **`apps/web`, `apps/admin` and `apps/api` typecheck cleanly** against the generated types of both drafts (the committed SDK was restored afterwards).
- Unchanged by the proposal: paths, operation ids, status codes, required fields of existing request bodies, auth, tenancy and idempotency. Not covered: runtime behaviour of third-party generated clients.

## 3. Exact prerequisites
### S-AG4 completion (AC-AG-09: capabilities LIVE-VERIFIED with evidence or NOT VERIFIED; data terms and residency attested before use; no claim without evidence)
1. D2 done: agreement reference exists, `attest` recorded with the contract's flags (terms accepted by a human).
2. D4 done: dedicated key stored with `save_claude_key`; vendor-side cap recorded.
3. D5 done: region stated; ROPA entry for `claude`.
4. D6 done: confirmed price and a versioned rate card (needed to enable the provider; the probe runs through the gateway and needs a rate card).
5. D7 accepted and implemented as a separate slice (S-AG4b): evidence table (expand-only migration), admin actions, audited probe wrapper through the gateway, the internal probe organization, provider DTO fields; tests; OpenAPI and SDK updated.
6. D3: `AI_LIVE_PROVIDERS=claude` in the named environment; connection test `ok`; two-person enable.
7. D9: approval record filled; probe run once; report stored; evidence rows `VERIFIED` or `NOT VERIFIED`; AC-AG-09 recorded in the S-AG4 report with the evidence links (`LIVE-VERIFIED` only with evidence).
8. D8: tool declaration moved to the evidence rows (**done 2026-11-22**; rows appear only after the probe).
9. **OpenAI and Google adapters are part of the S-AG4 definition (SCR-K-10 §8).** Either each is built with its own D1/D2/D4/D5/D6/probe cycle, or their deferral is recorded as an approved change-log entry (§6 status vocabulary: `DEFERRED`). S-AG4 is `DONE` only when every row is PASS or the non-critical rows are listed and signed.
10. Not required for S-AG4: any customer content (D1) — the probe uses `public` content only.

### S-AG5 benchmarks (AC-AG-10: golden suite, harness, thresholds proposed → accepted → met on a verified provider; regressions block)
1. S-AG4 closed for Claude (`VERIFIED` tool-use), so the loop can run on a verified provider.
2. S-K8 quality evidence (static part can start now; build and visual validation wait for D-21).
3. A **golden task suite** built from synthetic or owner-authored projects and templates only (no customer data; templates only if their AI-processing permission, D-49, allows), with expected outcomes; an offline replay mode (recorded fixtures) for CI so regressions block without live calls.
4. **Thresholds proposed by engineering and accepted by the owner** before any run: valid-patch rate, mode-rule violations, tool-call and token cost per task, latency, human acceptance rate; a rule that a regression blocks rollout.
5. Named human reviewers and a protocol for the "human acceptance" measure; a **benchmark spend budget** (cap in tokens and credits) approved in advance; vendor cap sized for it.
6. The agent security review (injection, tenant isolation, secret handling, tool abuse) with a named reviewer and a report.
7. D1 only if golden tasks use customer content (they should not).

### S-AG6 execution tools (AC-AG-12: Execution Gateway in an `isolated` runtime that passed the escape suite, own ADR, approvals, tests)
1. **D-21 decided** (gVisor, Firecracker or Kata on dedicated nodes) after the **sandbox isolation security review (HG-10-02)** by a named reviewer; the review pack is prepared but UNREVIEWED.
2. The escape suite run against a **real isolating runtime** and passing (today only the mock runtime ran; every isolating-runtime attempt is NOT VERIFIED); dedicated nodes and their budget.
3. A new ADR for the Execution Gateway (what may run, as whom, with which egress, quotas, canaries, approvals for destructive or paid actions); the model can never supply a command line.
4. Implementation of `ai.agent.exec_tools` behind that gateway (today a name only), human approval gates, audit, metering, kill switch, runbook (`sandbox-fleet`), tests including escape and cost.
5. S-AG5 thresholds met on a verified provider; legal review of running customer-supplied code (terms of use, liability).
6. D-42 and owner sign-off before any production use. Nothing in S-AG6 may start while D-21 is open.

## 4. Records updated by this review
`docs/07-open-decisions-and-blockers.md`: D-18 and HG-09-01 carry a dated note pointing here; their status remains **OPEN**. No decision is marked decided.

## 5. Approvals recorded
On 2026-11-22 the owner approved, in the chat, **D7, D8, D10 and D11** exactly as proposed above. Consequences carried out the same day (report `docs/reports/AG-S4b-report.md`):
- **D7:** SCR-K-11 items 1–4 were applied in the form of **variant B** (a boolean `supportsTools`, not three new capability strings): `supportsTools` on `AiModel`; `contractVersion`, `liveCallsApproved` and `capabilityEvidence` on `AiModelProvider`; the admin actions `record_capability_evidence` and `probe_tool_use`. Compatibility against the previous spec: 0 breaking, 0 warnings.
- **D8:** migration 1870 `ai.model_capability_evidence` (append-only); a real provider's tool-calling capability counts only while the latest row is VERIFIED for the adapter's current contract (dev-reference providers exempt); `AI_CLAUDE_CONTRACT` removed. Nothing is verified, so **no tool is offered to any real provider**.
- **D10:** confirmed and now pinned by a configuration test (only the exact string `true` enables it; default false); production and executable tools stay closed.
- **D11:** sequencing recorded: no OpenAI or Gemini adapter work until Claude is verified; the neutral contract is unchanged.
- **Not approved, not changed:** D1, D2, D4, D5, D6 and D12 remain pending; D3 and D9 are approved only as mechanisms/plans (the gate is closed; `probe_tool_use` answers 422 until D9 is approved for execution and its wrapper is built).
