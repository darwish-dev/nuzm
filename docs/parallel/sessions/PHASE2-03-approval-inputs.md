# Phase 2 · S03 — approval inputs for the owner and the reviewers

Author: Session 03 · 2026-11-24. These are **inputs to decisions, not decisions**. Ids match `docs/parallel/OWNER-DECISIONS.md` (AC-AG-10, BUD, REV, SEC-AG) plus four new ones (BMK-1 … BMK-4) this plan surfaced. Cost figures are vendor cost in USD at the **list price read on 2026-11-24, not confirmed against any contract** ("to be confirmed by S02/D6"); the arithmetic is in `docs/ai-intelligence/S-AG5-STAGES.md`. A cost marked MAXIMUM is a hard ceiling enforced by the budget ledger before every task; an ESTIMATE rests on stated assumptions.

**Nothing here blocks development.** All benchmark engineering that needs no approval is done and tested offline (the live runner exists, is sealed, and refuses to start). Every item below blocks **activation** of a stage, as stated per decision. Today every stage is BLOCKED, first of all by the provider verification of Session 02 (D2–D6, D9), which has not happened.

## Order of decisions
1. Before Stage A: AC-AG-10 (thresholds), BUD-A (budget for A, with its price card), REV, SEC-AG, plus Session 02's D2–D6/D9.
2. Before Stage B: BUD-B, and the owner's review of the Stage A cost calibration.
3. Before Stage C: the recalibrated threshold version (if any), BUD-C, BMK-1 (sampling), the human-review window.
4. Before D: BMK-2 (candidates). Before E: BMK-3 (cadence and monthly cap).

---

## Decision 1 — AC-AG-10: accept, change or reject the thresholds
- **Question:** which acceptance thresholds does a model have to meet before it may be used by the agent?
- **Recommendation:** accept the set in `PHASE2-03-threshold-review.md` §3 — keep T01–T07, T09–T16, T18; change T08 to 0.80, T19/T20 to 0.66, the category floor to "⌈0.70 n⌉ for n ≥ 5, one miss for n ≤ 4"; add T21 (Arabic/RTL group ≥ 0.85); mark T10, T11, T17 provisional (one recorded recalibration allowed after Stage B, before Stage C).
- **Alternatives:** (a) accept `2-proposed` unchanged; (b) the recommendation plus repeat runs (BMK-1); (c) the recommendation plus growing the small categories to 6 tasks; (d) reject and specify your own bars.
- **Evidence:** for each of the 20 thresholds, the sample size, the number of tolerated misses, what an offline scripted model does to it, the rationale and what a failure means (`PHASE2-03-threshold-review.md` §2). The key finding: as proposed, a model that solves 95 % of tasks passes every pass-rate bar together 4.6 % of the time; with the recommended rules 59.6 % (simulation, independent tasks, single run; §0 there). `2-proposed` unchanged is therefore *not safe to accept without knowing this*.
- **Cost:** none to decide. Option (b) triples Stage C (see BMK-1); option (c) is authoring work (about 51 new tasks, a dataset `3.0.0`, no vendor cost until run).
- **Impact:** decides who passes. Too strict: no model qualifies and nobody learns why. Too loose: an unreliable model reaches customers. The acceptance names the version; a later change needs a new acceptance.
- **Blocks:** activation of every live stage (the preflight refuses without an acceptance of the current version). Does not block development. Accept **before any live result exists**, so thresholds cannot be fitted to a result.
- **Engineering after acceptance:** small, tested change (new version `3-proposed`, the floor rule, T21 scope); the old list stays pinned by tests.
- **How it is recorded (built):** the console records a proposal, then a review by someone else, then the owner's acceptance or rejection (reason required) as append-only events; the acceptance names the exact version, is never set automatically, requires the accepter to differ from the proposer and from the approving reviewer, and a later rejection withdraws it (`CONTRACT-S03-5`).

## Decision 2 — BUD: the benchmark budget (and the price card it is sized with)
- **Question:** how much vendor money may the benchmark programme spend, per stage, and on what price?
- **Recommendation:** approve **per stage**, each at that stage's MAXIMUM, after the previous stage exited: **BUD-A $4.40**, **BUD-B $23.60**, **BUD-C $83.60** (Opus 5.5, one model, list price). Enter each with its price card and source (`set_budget` carries `price` and `source`; without a price the preflight refuses). Set the vendor-side monthly cap (D4) at the largest single-stage maximum planned that month plus 20 %: **$100** for the month Stage C runs at Opus 5.5.
- **Alternatives:** (a) one programme budget, $111.60 for A+B+C (simpler, no re-approval, but the owner does not see Stage A's calibration before committing C's); (b) approve A only now and decide the rest later (recommended in practice: the decision order above); (c) a different first model (Sonnet 5.5: A $2.20, B $11.80, C $41.80 maximum).
- **Evidence:** the stage table. Opus 5.5 / Sonnet 5.5 / Fable 5.2 / Haiku 5.5:

| Stage | Opus 5.5 est. / **max** | Sonnet 5.5 est. / **max** | Fable 5.2 est. / **max** | Haiku 5.5 est. / **max** |
|---|---|---|---|---|
| A (5 tasks) | $0.88 / **$4.40** | $0.44 / **$2.20** | $1.71 / **$8.80** | $0.05 / **$0.11** |
| B (23 tasks) | $4.72 / **$23.60** | $2.36 / **$11.80** | $9.21 / **$47.20** | $0.23 / **$0.59** |
| C (83 tasks) | $16.72 / **$83.60** | $8.36 / **$41.80** | $32.61 / **$167.20** | $0.83 / **$2.09** |

  Assumptions behind estimates: 60 % of each task's token ceiling is used, 85 % of it input; replaced by Stage A's measurement. Prices per MTok (input / output): Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Fable 5.2 $8 / $40, Haiku 5.5 $0.10 / $0.50.
- **Cost:** the maximum above, per stage. Programme (A+B+C once, D with 3 candidates, 3 months of E), Opus 5.5: estimate $174.48, maximum $872.40. If residency requires `inference_geo: "us"`, every figure is × 1.1 (vendor page). A call can overshoot its reservation by at most that call's `max_tokens` before the ledger stops the run.
- **Impact:** caps the exposure; the ledger refuses a task whose ceiling does not fit what is left and stops on any overrun. FX to SAR is a finance decision (D6).
- **Blocks:** activation of the stage the budget is for. Requires D6 (confirmed price), D4 (vendor cap) and S02's provider verification first.

## Decision 3 — REV: named reviewers and the acceptance bar
- **Question:** who are the human reviewers, and what share of reviewed results must they accept?
- **Recommendation:** name **three** people (two are the minimum; a third adjudicates disagreements and covers absence), at least one fluent in Arabic and in front-end accessibility, none of them the author of the run. Bar 0.70 of reviewed items accepted; blind; at least 20 tasks sampled across categories; at least 90 % of items reviewed by two people; kappa reported.
- **Alternatives:** two reviewers with the owner adjudicating; bar 0.80 for a premium tier; more tasks (30–40) for tighter confidence.
- **Evidence:** the engine implements the protocol (blind ids, coverage, kappa, adjudication, a human-acceptance result the gate requires). Reviewer effort is an **assumption**: 10–15 minutes per item → 20 items × 2 reviewers ≈ 7–10 hours per model (to be replaced by the reviewers' own estimate).
- **Cost:** no vendor cost; reviewer time only.
- **Impact:** the gate refuses to qualify without a measured human acceptance; there is no offline substitute.
- **Blocks:** activation of every live stage (the preflight needs at least two named reviewers) and of qualification after Stage C. Does not block development.

## Decision 4 — SEC-AG: the agent security review (named reviewer)
- **Question:** who reviews the agent's security, what is in scope, and when?
- **Recommendation:** a named reviewer other than the author, scoped to: the capture runner (what leaves the platform, what is recorded, secret handling), the prompt-injection resistance of the agent on the synthetic tasks, and the model's output handling (path and secret rules, T02). Record a reference and `passed`. Schedule it **after** Session 02's provider verification and **before** Stage A, because the preflight requires it for any live run.
- **Alternatives:** (a) a narrower review for Stage A only (the 5 synthetic tasks, no customer data, no secrets in scope) with the full review required before C — needs a small change to the preflight (a stage-specific rule) and is not recommended without the reviewer's agreement; (b) an external reviewer.
- **Evidence:** every task is synthetic and public-class; no customer data, credential or customer code is involved in any stage; sealed runner refuses without the record. QA findings from Session 07 are the starting material.
- **Cost:** reviewer time; unknown.
- **Impact:** high; a pass is a precondition of using a qualified model. The review is not replaceable by static checks.
- **Blocks:** activation of every live stage and of qualification. Does not block development.

## BMK-1 — sampling strategy: one run per task, repeated runs, or more tasks
- **Question:** how do we make a pass/fail verdict on 83 tasks trustworthy?
- **Recommendation:** start with **one run per task** and the recommended thresholds (Decision 1), and let Stage E measure stability: a second Stage C only if the first result is within one miss of a bar. This costs nothing extra up front.
- **Alternatives:** (a) 3 runs per task, majority pass: Stage C × 3 (Opus 5.5 list price: estimate $50.16, maximum $250.80), needs a small tested scoring addition; (b) grow the 17 three-task categories to 6 tasks (dataset 3.0.0, authoring effort); (c) both.
- **Evidence:** the simulation table in `PHASE2-03-threshold-review.md` §0 (single-run noise alone rejects 40 % of 95 %-per-task models even under the recommended rules).
- **Cost:** (a) +$167.20 maximum at Stage C; (b) none vendor-side.
- **Impact:** determines how often a good model is rejected by luck, and how often a mediocre one passes.
- **Blocks:** activation of Stage C only. Does not block development.

## BMK-2 — which models are candidates (Stage D) and which is qualified first (Stage C)
- **Question:** which model goes through Stage C first, and which are compared in Stage D?
- **Recommendation:** qualify the model the platform is configured for (Opus 5.5; the adapter and the probe plan target it); consider Sonnet 5.5 as the cost-efficient candidate for D. Decide D only after C.
- **Alternatives:** Sonnet 5.5 first (half the cost of C: maximum $41.80); Fable 5.2 as an upper-quality reference (C maximum $167.20); Haiku 5.5 as a very cheap tier (C maximum $2.09 at ≤ 100,000-token prompts).
- **Evidence:** list prices above; the dataset is model-agnostic; a candidate can only be run if it is a verified provider and model (Session 02), and Opus 5.5 is the only one in the adapter today (OpenAI/Gemini adapters are decision D11).
- **Cost:** D for Opus 5.5 + Sonnet 5.5: estimate $25.08, maximum $125.40 (the Opus run of C may be reused).
- **Impact:** which model customers get, and the price/quality trade-off.
- **Blocks:** activation of D. Does not block development.

## BMK-3 — continuous regression cadence and monthly cap (Stage E)
- **Question:** how often do we re-test a qualified model, and what is the monthly ceiling?
- **Recommendation:** the 24 core tasks weekly and on every relevant change; the full suite monthly; a monthly cap equal to the maximum: **$170** at Opus 5.5 (4 core runs $21.60 each + one full run $83.60). Estimated actual spend about $34.
- **Alternatives:** core runs only on change (cheaper, slower to notice a silent provider change); fortnightly core runs (half the cost).
- **Evidence:** `planContinuousMonth`; the regression detector (blocking and warning, per-category tolerance 0.20) and the suspend event are implemented and tested.
- **Cost:** per month, Opus 5.5: estimate $34.00 / maximum $170.00; Sonnet 5.5: $17.00 / $85.00.
- **Impact:** a blocking regression suspends the qualification and opens an incident.
- **Blocks:** activation of E (needs a QUALIFIED model and a stage C baseline).

## BMK-4 — written authorization per live stage
- **Question:** who gives the explicit "run Stage X now" and where is it recorded?
- **Recommendation:** one recorded approval event per stage (stage, model, dataset version, thresholds version, budget reference, approver, time), by the owner; the engine records it as the budget reference plus the stage entry check. No stage starts on a standing approval.
- **Alternatives:** a single approval covering A–B (the cheap stages).
- **Evidence:** `PHASE-2-PLAN.md` §5: each live event is "a separate recorded event with its approval reference".
- **Cost:** none.
- **Impact:** keeps every paid run attributable.
- **Blocks:** nothing in development; each stage's activation.

---

## What is not an owner decision
Dataset content, scorers, regression detection, comparison, reviewer workflow, qualification state machine, budget ledger, the sealed live runner and the dashboard are engineering, done and tested offline. The only genuinely missing engineering piece is an adapter-backed `CaptureSource`, which is built against a verified provider (Session 02); it cannot be built to the standard "tested against the real thing" until D2–D6 and D9 exist, and is therefore listed as a dependency, not a decision.

---

## Reconciliation with Session 02's inputs (read 2026-11-24: `PHASE2-02-approval-inputs.md`, `LIVE-PROVIDER-PLAN.md`, `S-AG4-SPEND-CAPS.md`)
| Item | Session 02 | Session 03 | Reconciled |
|---|---|---|---|
| Vendor price used | Claude Opus 5.5 list price $4 input / $20 output per million tokens, "to be confirmed against the agreement or the console (HG-09-01)" | the same figures, same date, same status `TO_BE_CONFIRMED_BY_S02_D6` | **identical**; the benchmark plan reads the price from the approved budget's price card once D6 confirms it |
| Verification run (not a benchmark) | hard maximum **USD 0.197440** for all live steps (the suite alone USD 0.116720) | not part of any stage | stage A ($4.40 maximum) is about 22 times that; the two are separate spends |
| D4 vendor cap | **USD 5 per month to start**, "sized for verification"; states that "benchmarks need their own, larger budget (BUD) and a vendor cap sized for it" | recommends the cap at the largest single-stage maximum of the month plus 20 % | **differs, deliberately**: $5 covers the verification run but **not even stage A plus its headroom once other spend is counted** ($4.40 maximum, leaving $0.60) and not B ($23.60). Recommended cap schedule for the dedicated workspace: verification month $5 (S02's figure); month with stage A: **$10**; month with stage B: **$30**; month with stage C: **$100**; a month of stage D (2 candidates): **$200**. The owner raises the cap before each stage and records it; the benchmark budget BUD is approved per stage at that stage's maximum |
| Platform daily cap | credits cap at 80 % of the vendor cap divided by days | not specified | the benchmark runs outside the customer wallet (our cost, not a customer charge): its own budget ledger is the platform-side cap, and the vendor cap is the second line |
| Per-call ceiling | `max_tokens` on every request; thinking tokens count inside it | the stage MAXIMUM excludes the overshoot of one call past a reservation | open input from S02: the adapter's per-call `max_tokens` for benchmark calls (to be confirmed); until then the maximum is a ledger ceiling plus at most one call |
| Tool-use overhead for a forced tool choice | NOT STATED on the vendor page | not assumed; inside provider-reported usage | consistent |
| Customer rate card (D6) | credits per million, FX and margin are the owner's; illustrative only | vendor cost only; no credits in the benchmark | consistent: the benchmark never uses the customer rate |

## Running a stage (what exists today)
Command (from the repository root; simulated by default):
```bash
pnpm exec tsx packages/domain/src/ai/benchmarks/cli/qualify.ts --stage A
```
It prints the stage plan with its **hard maximum cost first**, then a scorecard marked SIMULATED (a scripted mock model) and the evidence record. `--mode live` refuses (exit 3, nothing loaded or called) unless every approval above exists as a reference in the environment; then it needs the confirmation gate (`NUZM_BENCH_APPROVAL_REF` and `--confirm-max <the printed maximum in minor units>`) and a capture source module (`NUZM_BENCH_CAPTURE_SOURCE_MODULE`, S02's adapter-backed implementation, which does not exist yet). Details and the evidence record are in `docs/ai-intelligence/S-AG5-STAGES.md` §8.
