# S-AG5 — staged qualification strategy (A–E)

Status: **PLAN, offline-complete. Nothing in this document has been run live.** Owner: Session 03. Date: 2026-11-24. Code: `packages/domain/src/ai/benchmarks/stages.ts` (the tables below are generated from it, and `stages.spec.ts` checks the arithmetic against an independent sum). Dataset: `2.1.0`, 83 synthetic tasks, 23 categories. Thresholds: `2-proposed` (see `docs/parallel/sessions/PHASE2-03-threshold-review.md`).

Labels used here: **LIST PRICE** = the vendor's public pricing page, read 2026-11-24, not confirmed against any contract (inputs "to be confirmed by S02/D6"); **ASSUMPTION** = a number nobody has measured yet; **MAXIMUM** = what the budget ledger will not let the stage exceed, independent of any assumption.

## 1. Why stages
A benchmark that spends money must not discover its own cost, its own plumbing faults or its own bad thresholds at full price. Each stage is the cheapest run that can answer the question the next stage depends on:

| Stage | Question it answers | What it must not do |
|---|---|---|
| A smoke | Does the real path work end to end (capture, provenance, usage accounting, ledger, stop rules)? What do tokens and input share really look like? | claim anything about model quality (5 tasks) |
| B representative | Is there a first real signal in every one of the 23 categories? Is the cost model right? | gate a pass rate (1 task per category) |
| C qualification | Does ONE model meet the accepted thresholds on all 83 tasks? | run before B recalibrated the estimate |
| D comparison | Which of 2+ qualified candidates is better, on identical tasks? | switch a model automatically |
| E regression | Did something change silently? | run without a baseline from C |

## 2. The inputs behind every cost figure
Rates are **LIST PRICE, USD per million tokens** as printed on the vendor's pricing page on 2026-11-24 (the page shows no API model ids and no "last updated" date: both NOT STATED). They are the inputs `REFERENCE_RATE_INPUTS` in `stages.ts` and are marked `TO_BE_CONFIRMED_BY_S02_D6` in code, in the API and in the dashboard. They are **vendor cost, never a customer price**; the owner confirms them against the agreement or console (HG-09-01, D6) and Session 02 owns that confirmation. Rates are sealed into the approved budget (`set_budget` with a `price` and its `source`); without a price card the live preflight refuses.

| Model (as the page names it) | Input | Output | Note |
|---|---|---|---|
| Claude Opus 5.5 | $4 | $20 | the model the adapter is configured for (`docs/adapters/anthropic.md`, `S-AG4-PRICING.md`) |
| Claude Sonnet 5.5 | $2 | $10 | |
| Claude Fable 5.2 | $8 | $40 | |
| Claude Haiku 5.5, prompts up to 100,000 tokens | $0.10 | $0.50 | above 100,000 tokens the page prints $0.50 / $2.50; our task ceilings are far below that |

Not applied (and why): prompt caching (not enabled), Batch API 50 % discount (agent loops are multi-turn and interactive; also it would invalidate latency measurement), fast mode, server tools. If residency requires `inference_geo: "us"`, every figure below is multiplied by **1.1** (page: "1.1x pricing multiplier"). Tool-use overhead (286 input tokens per tool-using request on Opus 5.5 and Sonnet 5.5) is inside the provider-reported usage, so the ledger sees it; for a forced tool choice the page prints nothing: do not assume. Currency conversion to SAR is a finance decision (D6 / FX); everything here is USD.

### The estimate model (ASSUMPTIONS, replaced by Stage A's measurements)
- **Usage share 0.60 of each task's token ceiling.** Basis: threshold T10 proposes a mean of 30,000 tokens per task; the suite's mean ceiling is 4,180,000 / 83 = 50,361 tokens; 30,000 / 50,361 = 0.596, rounded up to 0.60.
- **Input share 0.85** of the tokens (agent loops re-send context, so input dominates). Pure assumption.
- **Wall time:** 45 s mean per task (assumption), 90 s per task as the limit (T11). Tasks run sequentially. Rate limits of the account (D5) are unknown and could lengthen this.
- Estimated cost per task = ceil(0.60 × ceiling) tokens split 85/15, priced at the input and output rate, **rounded up to a whole cent per task**.
- **MAXIMUM** per task = ceiling × the **dearer** of the two prices (all tokens billed as output), rounded up to a whole cent. Task ceilings are 40,000 tokens (40 tasks) or 60,000 (43 tasks). The ledger reserves the ceiling before a task and stops the run if actual usage exceeds the reservation or the caps. One call can overshoot a reservation by at most that call's `max_tokens` (set by Session 02's adapter configuration: to be confirmed) before the ledger sees it; that overshoot is not in the MAXIMUM.

Worked example, Opus 5.5, Stage A (5 tasks: ceilings 40k, 60k, 40k, 40k, 40k = 220,000 tokens):
- MAXIMUM: per task 40,000 × $20 / 1,000,000 = $0.80 (four tasks) and 60,000 × $20 / 1,000,000 = $1.20 (one task): 4 × $0.80 + $1.20 = **$4.40**.
- ESTIMATE: 220,000 × 0.60 = 132,000 tokens = 112,200 in + 19,800 out. 112,200 × $4 / 1M = $0.4488; 19,800 × $20 / 1M = $0.396; sum $0.8448; with the per-task round-up to the cent: **$0.88**.

## 3. The stages
Full cost tables for all four reference models are in §4. Task lists: `selectStageTasks` in `stages.ts` (deterministic: the same dataset always selects the same tasks).

### Stage A — minimal synthetic smoke
- **Selection rule:** for each of the 4 kinds the task with the smallest token ceiling (ties: lowest id), plus the lowest-id Arabic task of the category `arabic-rtl` (distinct): **5 tasks** — `a11y-01-img-alt`, `api-01-version-endpoint`, `bug-02-empty-average`, `rtl-01-direction`, `tool-01-find-constant`. One run each, one model.
- **Cost (Opus 5.5 list price):** estimated **$0.88**, maximum **$4.40**; 132,000 tokens expected, 220,000 ceiling; 30 requests at most.
- **Duration:** about 4 minutes expected, 8 minutes at the limit.
- **Must be true before it starts:** every prerequisite in §5 (the live runner's preflight already enforces them for ANY live run; there is no cheaper "unchecked" path).
- **Exit criteria:** status COMPLETED; 5/5 recorded, none rejected for provenance or dataset version; no uncertain outcome; actual cost, tokens and requests within the maximum and equal to what the provider reported; zero mode violations (T02); measured usage share and input share recorded and fed to `calibrateAssumptions` for B–E.
- **If it fails:** stop. A refused or uncertain run is reconciled before any retry (CLAUDE.md §4). Nothing proceeds to B.

### Stage B — representative subset
- **Selection rule:** one task per category (23). Categories at an odd position of the category list take their lowest-id **Arabic** task, the others their lowest-id **English** task (fallback: lowest id), so both languages are represented — the product default is Arabic (D-32): **11 Arabic and 12 English tasks**. One run each.
- **Cost (Opus 5.5):** estimated **$4.72**, maximum **$23.60** (1,180,000-token ceiling; 138 requests).
- **Duration:** about 18 minutes expected, 35 at the limit.
- **Before it starts:** Stage A exited for the same model, dataset version and thresholds version; the budget covers B's maximum.
- **Exit criteria:** COMPLETED, 23/23 recorded; actual within the maximum and within 1.25 × the (calibrated) estimate; zero mode violations; any category whose static security score is below the proposed floor (T13) explained in writing; the recomputed estimate for C is shown to the owner **before C starts**. Pass rates are reported but **not gated** (one task per category supports no pass-rate claim).

### Stage C — full qualification suite
- **Selection rule:** every task of the dataset version in force: **83 tasks**, 23 categories, both languages. One run each, **one** model.
- **Cost (Opus 5.5):** estimated **$16.72**, maximum **$83.60** (4,180,000-token ceiling; 498 requests).
- **Duration:** about 63 minutes expected, 125 at the limit.
- **Before it starts:** B exited; the owner has seen the recalibrated estimate and approved a budget at or above C's maximum; **thresholds accepted before any live result exists** (otherwise the thresholds can be fitted to the result); reviewers named and the human review window agreed.
- **Exit criteria:** COMPLETED; 83/83 recorded; evidence label `OFFLINE_REPLAY_OF_RECORDED_RUN`; every threshold (T01–T20 and the category floor) evaluated; the rollout gate decision recorded with its failed checks (a failed gate is a valid outcome — it just does not qualify the model); the human review plan created (blind, at least 20 tasks) and the qualification record moved to EVIDENCE_ATTACHED; the report becomes the model's baseline for E only if the gate passed.

### Stage D — comparative model evaluation
- **Selection rule:** the full 83 tasks for each of 2–4 candidate models, identical tasks and dataset version. A candidate's Stage C run may be reused while its model version, the dataset and the thresholds are unchanged.
- **Cost:** a full run per candidate (list prices; illustrative candidate sets — the real set is the owner's decision):

| Candidates | ESTIMATED | MAXIMUM |
|---|---|---|
| Opus 5.5 + Sonnet 5.5 | $16.72 + $8.36 = **$25.08** | $83.60 + $41.80 = **$125.40** |
| Opus 5.5 + Sonnet 5.5 + Fable 5.2 | $25.08 + $32.61 = **$57.69** | $125.40 + $167.20 = **$292.60** |
| Opus 5.5 twice (planning figure used by `planStage('D')`) | $33.44 | $167.20 |

- **Duration:** about 63 minutes expected and 125 at the limit **per candidate**.
- **Before it starts:** each candidate individually verified by Session 02 (a candidate that is not a verified provider/model cannot be captured at all) and each has its own approved rate.
- **Exit criteria:** every candidate ran the full suite; the comparison is `comparable`; every row carries its evidence label; pairwise sign tests are reported. The output is a **recommendation**; the owner decides, and no model is switched automatically. A difference that is not significant is reported as such.

### Stage E — continuous regression
- **Selection rule:** the 24 core tasks, on a schedule (proposed: weekly) and on every relevant change (model version, system prompt, tool schema, adapter, dataset version); the full suite monthly. One model.
- **Cost (Opus 5.5):** core run estimated **$4.32**, maximum **$21.60**; per month (4 core + 1 full) estimated **$34.00**, maximum **$170.00** (8,500,000 tokens).
- **Duration:** about 18 minutes per core run (36 at the limit).
- **Before it starts:** a Stage C baseline of the same dataset version exists and the model is QUALIFIED (or the owner explicitly accepted a first run without baseline); a monthly cap approved.
- **Exit criteria:** completed within the monthly cap; no blocking regression (`detectRegressions`); a blocking regression suspends the qualification and opens an incident; a dataset or thresholds version change expires the baseline (next run is a Stage C).

## 4. Cost tables (generated from `planStage`, LIST PRICE, ASSUMPTIONS as in §2)
"Max tokens" is the sum of the task ceilings; "Estimated tokens" is 0.60 of it. Durations are sequential. Each row of D uses two candidates at the same rate.

### Claude Opus 5.5 — $4 / $20 per MTok
| Stage | Tasks | Runs | Max tokens | Max requests | Estimated tokens (in / out) | ESTIMATED cost | MAXIMUM cost | Est. duration | Max duration |
|---|---|---|---|---|---|---|---|---|---|
| A | 5 | 5 | 220,000 | 30 | 132,000 (112,200 / 19,800) | $0.88 | $4.40 | 4 min | 8 min |
| B | 23 | 23 | 1,180,000 | 138 | 708,000 (601,800 / 106,200) | $4.72 | $23.60 | 18 min | 35 min |
| C | 83 | 83 | 4,180,000 | 498 | 2,508,000 (2,131,800 / 376,200) | $16.72 | $83.60 | 63 min | 125 min |
| D (2 candidates) | 83 | 166 | 8,360,000 | 996 | 5,016,000 (4,263,600 / 752,400) | $33.44 | $167.20 | 125 min | 249 min |
| E (one core run) | 24 | 24 | 1,080,000 | 144 | 648,000 (550,800 / 97,200) | $4.32 | $21.60 | 18 min | 36 min |
| E per month (4 core + 1 full) | 24 + 83 | 179 | 8,500,000 | — | — | $34.00 | $170.00 | — | — |

Programme (A + B + C once, D with 3 candidates at this rate, 3 months of E): estimated **$174.48**, maximum **$872.40**.

### Claude Sonnet 5.5 — $2 / $10 per MTok
| Stage | ESTIMATED | MAXIMUM |
|---|---|---|
| A | $0.44 | $2.20 |
| B | $2.36 | $11.80 |
| C | $8.36 | $41.80 |
| D (2 candidates, same rate) | $16.72 | $83.60 |
| E one core run / per month | $2.16 / $17.00 | $10.80 / $85.00 |

### Claude Fable 5.2 — $8 / $40 per MTok
| Stage | ESTIMATED | MAXIMUM |
|---|---|---|
| A | $1.71 | $8.80 |
| B | $9.21 | $47.20 |
| C | $32.61 | $167.20 |
| D (2 candidates, same rate) | $65.22 | $334.40 |
| E one core run / per month | $8.40 / $66.21 | $43.20 / $340.00 |

### Claude Haiku 5.5 (prompts ≤ 100,000 tokens) — $0.10 / $0.50 per MTok
| Stage | ESTIMATED | MAXIMUM |
|---|---|---|
| A | $0.05 | $0.11 |
| B | $0.23 | $0.59 |
| C | $0.83 | $2.09 |
| E per month | $1.79 | $4.25 |

**Reading the numbers.** The MAXIMUM is the number to approve: it is a hard ceiling enforced before every task. The ESTIMATE is what the owner should expect to pay if the assumptions hold. The recommended budgets (§6) are stage maxima, so the preflight accepts the stage and the owner never signs a number the engine could exceed.

## 5. What must be true before ANY live stage (enforced, not advisory)
The live runner's `livePreflight` already refuses unless all of these hold; `evaluateStageEntry` reports each missing one with its owner, and the admin dashboard and `attempt_live_run` show them.

| Prerequisite | Provided by | Evidence the engine needs |
|---|---|---|
| `BENCHMARK_LIVE_ENABLED` on | owner | environment |
| live-provider gate open | owner (D9) | `AI_LIVE_PROVIDERS` |
| named non-production environment | owner | environment name |
| provider and model verified | Session 02 (D2–D5, D9) | an evidence reference; the capture source must be exactly that provider and model |
| a real `CaptureSource` | Session 02 / integration | built and tested against mocks (none exists today; `attempt_live_run` always reports `NO_CAPTURE_SOURCE`) |
| confirmed price card | owner (D6) / Session 02 | `set_budget` with `price` and its `source` (a zero or missing price is refused) |
| vendor-side monthly spend cap | owner (D4) | set in the vendor console at or above the stage maximum |
| thresholds accepted (this version) | owner (AC-AG-10) | a dated acceptance, **before** any live result |
| budget approved for the stage | owner (BUD) | caps ≥ the stage maximum |
| ≥ 2 named reviewers | owner (REV) | roster |
| agent security review passed | owner (SEC-AG) | a reference |
| previous stage exited (B–E); baseline (E) | this engine | stage outcome |

Today none of the rows from "provider verified" down is satisfied, so **every stage is BLOCKED**, and the dashboard says so. The stages are ready the moment the inputs arrive.

## 6. Budget recommendation (details in `PHASE2-03-approval-inputs.md`)
Approve **per stage**, at the stage maximum, after the previous stage exited: A **$4.40**, B **$23.60**, C **$83.60** (Opus 5.5 list price). The vendor-side cap (D4) is set to the largest single-stage maximum planned for the month plus 20 % headroom. Total exposure of the full programme for one model is the programme line in §4, and is bounded by the ledger.

## 7. Limits of this plan (stated, not hidden)
- Offline replay of REFERENCE or MOCK recordings proves the machinery, never a model. No stage above has produced a number about any model.
- One run per task is a single sample of a stochastic system. See the threshold review (§ "what the thresholds can and cannot tell you") for what that means for the category floor.
- Build, visual and runtime validation of generated apps (D-21, Session 04) is not part of any stage; tasks check structure, static rules and tool use.
- Latency of a real provider and real rate limits are unknown until Stage A.
