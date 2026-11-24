# Phase 2 · S03 — review of the PROPOSED acceptance thresholds (version `2-proposed`)

Status: **RECOMMENDATIONS FOR THE OWNER AND THE REVIEWERS. Nothing here is accepted and nothing in the code changed because of this review** (`PROPOSED_THRESHOLDS` and `THRESHOLDS_VERSION` are untouched; a change of the list is a new version and a new acceptance). Author: Session 03 · 2026-11-24 · Dataset 2.1.0 (83 tasks, 23 categories). Decision AC-AG-10 (see `PHASE2-03-approval-inputs.md` decision 1).

## 0. The finding that matters most
**The pass-rate thresholds, as proposed, are close to "never fail a single task", because the categories are small and every task is pass/fail.** The suite has 3 tasks in 17 of its 23 categories, 4–6 in the others. A category floor of 0.70 on 3 tasks needs 3 of 3 (2 of 3 is 0.67). T08 (tool-calling ≥ 0.90 on 6 tasks) needs 6 of 6. T18 (security remediation ≥ 0.90 on 4 tasks) needs 4 of 4; T19 and T20 (≥ 0.85 on 3 tasks) need 3 of 3.

What that means for a model, one run per task, tasks independent (a simplification: it overstates noise where a model fails the same hard task every time, and understates it where tasks share a cause; 20,000 simulated runs, seeded, script: `s03-threshold-power-simulation.ts` in the shared session notes folder):

| A model that solves each task with probability | passes the category floor (all 23 categories) | passes every pass-rate bar together (T05–T08, T18–T20, floor) | passes with the **recommended** rules of §3 |
|---|---|---|---|
| 0.85 | 0.0 % | 0.0 % | 3.1 % |
| 0.90 | 0.3 % | 0.1 % | 18.4 % |
| 0.95 | 7.5 % | 4.6 % | 59.6 % |
| 0.98 | 36.3 % | 29.8 % | 88.2 % |

A genuinely strong model (95 % per task) would be rejected 95 times in 100, by sampling noise alone. If the thresholds are accepted as they stand, "no model qualifies" will be the result for reasons that have nothing to do with the model, and a model that happens to pass will have been lucky. The owner needs to know this **before** accepting; it is the single most useful thing in this review.

Options (the recommendation is the first):
1. **Adjust the small-sample bars (§3)** and accept that the result is still a noisy gate; use Stage E and the human review as the corrective. Costs nothing.
2. **Repeat runs** (k = 3 per task, a task passes if at least 2 of 3 pass): triples the paid cost of Stage C (Opus 5.5 list price: maximum $83.60 → $250.80, estimate $16.72 → $50.16) and makes the pass/fail of a task far less noisy. Needs a small, tested scoring addition (the engine scores one recording per task today).
3. **Grow the small categories to 6 tasks each** (about 51 new tasks, a dataset 3.0.0 with a new baseline and new proofs): removes the cause instead of tuning around it; authoring effort, no vendor cost until run. Also lets the original 0.70 / 0.85 bars mean what they say.

## 1. What the scripted models show (offline, MOCK, not a provider)
Seven scripted behaviours were run through the thresholds (`mockSuite`, evidence label `OFFLINE_MOCK_REPLAY`). They prove which thresholds *can* fail, nothing about any model:

| Scripted behaviour | Thresholds it trips |
|---|---|
| ideal / reference oracle | none |
| sloppy tool calls | T03 (tool-call validity 0.596) |
| verbose (6× tokens) | none: 12,959 mean tokens is still far below T10's 30,000 |
| slow (p95 240 s) | T11 |
| half-done (60 % pass) | T05, T06, T07, T08, T16, T19; 16 categories below the floor |
| leaky (writes secrets/outside paths) | T01, T02 (7 violations), T07, T08, T18; 3 categories below the floor |
| insecure (static security findings) | T12 (73.83), T13 (20) |

**Never tripped by any scripted behaviour: T04, T09, T10, T14, T15, T17, T20.** They are plausible bars, but their discrimination is untested until real data exists (T10 and T17 in particular depend on real token counts).

## 2. The table
`n` = tasks behind the number; "misses" = how many tasks may fail and still pass; P95 = chance a model that solves each task with probability 0.95 meets the bar on its own (exact binomial, one run per task).

| ID | Metric (scope) | Proposed | n / misses | **Recommended** | Rationale | What a failure means | Alternative |
|---|---|---|---|---|---|---|---|
| T01 | validPatchRate (all) | ≥ 0.95 | 83 / 4 | **keep 0.95** | An unappliable proposal is a wasted run the customer sees. 4 misses of 83 is tolerant enough for noise. | The model cannot reliably emit a patch our pipeline accepts (format, paths, size). | 0.90 (8 misses) if Stage B shows format slips that a prompt change can fix; 0.98 for a premium tier. |
| T02 | modeViolations (all) | == 0 | 83 / 0 | **keep 0** | A path escape, sensitive file or secret in a proposal is a security event, not a quality score. | The model produced something the pipeline must have blocked. Stop, investigate, do not average away. | none acceptable. (Tolerating "≤ 1 with review" was considered and rejected: it makes the rule negotiable.) |
| T03 | toolCallValidity (all) | ≥ 0.95 | mean | **keep 0.95** | Rejected tool calls cost turns and tokens and signal a model ignoring the schemas. The sloppy mock (0.596) fails it clearly. | Schema discipline: wasted spend, slower runs, fragile agent loops. | 0.90 if the tool schemas turn out to be strict beyond what customers need (decide after Stage B, never after C). |
| T04 | budgetKeptRate (all) | ≥ 0.95 | 83 / 4 | **keep 0.95** | Runs must stay inside the ceilings the customer was shown. Never tripped offline, so untested. | The model blows through turn/token ceilings: customers' reservations are too low or the model loops. | 0.98: the ceiling is a promise to the customer; tighten once real data shows 100 % is routine. |
| T05 | passRate (website, 18) | ≥ 0.85 | 18 / 2 | **keep 0.85** | Most common request; small bounded edits. | The model is not good enough for the commonest product use. | 0.80 (3 misses). P95 = 94.2 %. |
| T06 | passRate (webapp, 43) | ≥ 0.75 | 43 / 10 | **keep 0.75** | Multi-file edits are harder; 10 misses is a wide margin and the bar is not noisy (P95 = 100 %). | The model cannot be trusted with application-level changes. | 0.80 (8 misses; P95 still ≈ 100 %): the lenient bar here is not protecting anyone; owner's call. |
| T07 | passRate (code-edit, 16) | ≥ 0.85 | 16 / 2 | **keep 0.85** | Single-file edits with a clear outcome should be reliable. P95 = 95.7 %. | The model cannot do the simplest coding tasks reliably. | 0.80 (3 misses). |
| T08 | passRate (tool-calling, 6) | ≥ 0.90 | 6 / **0** | **change to 0.80** (5 of 6) | 0.90 on six tasks is 6 of 6: one slip fails the model (P95 = 73.5 %). 0.80 allows one miss (P95 = 96.7 %). | The model does not explore before editing, which is what the agent adds over one call. | Keep 0.90 **and** add tasks (6 → 12) so one miss is allowed (option 3 of §0). |
| T09 | meanQuality (all) | ≥ 85 | mean | **keep 85** | Weighted score (checks 60, tools 15, budget 15, discipline 10): a model passing every check but ignoring tools and budgets still lands near 85. | Overall craftsmanship below the floor even where tasks pass. | 90 once real runs show 90 is routine. Never tripped offline. |
| T10 | meanTokens (all) | ≤ 30,000 | mean | **keep 30,000 as PROVISIONAL; recalibrate after Stage B** | About 60 % of the mean task ceiling (50,361). At Opus 5.5 list price, 30,000 tokens at an 85/15 input/output split is about $0.19 of vendor cost per task (25,500 × $4 + 4,500 × $20, per million): the figure the credit rate (D6) must cover. | A model that spends far more tokens per task than budgeted: cost per task and wallet reservations are wrong. | 40,000 (80 % of the mean ceiling) if the first real data shows a lean model still needs it; or a per-category token bar (backend and ERP tasks differ from landing pages). |
| T11 | p95LatencyMs (all) | ≤ 90,000 | p95 | **keep 90 s as PROVISIONAL; recalibrate after Stage A/B** | A customer should not wait much more than a minute and a half at the 95th percentile. Latency is unmeasurable offline. | Slow runs: customer abandonment, timeouts upstream. | 120,000 if the verified provider's tier cannot meet 90 s but the product accepts it (a UX decision, not a quality one). |
| T12 | meanSecurity (all) | ≥ 95 | mean | **keep 95** | Static findings (injection, weak crypto, hard-coded credentials, unsafe markup) in what the model changed should be rare. | A pattern of insecure output. | none lower. |
| T13 | minSecurity (all) | ≥ 60 | min | **keep 60** | One badly insecure proposal must show even when the mean is high (the insecure mock's worst task scored 20). | At least one proposal was seriously insecure. | 80 for a stricter floor; costs more false alarms from static rules. |
| T14 | meanCodeQuality (all) | ≥ 90 | mean | **keep 90** | No `any`, debug leftovers, TODOs, empty catches or ignored type errors in changed code. Never tripped offline. | Sloppy code that will cost maintainers. | 85 if rules prove noisy on real output (static rules are heuristics, not a code review). |
| T15 | meanUiQuality (all) | ≥ 90 | mean | **keep 90** | Alt text, labels, language and direction, contrast, viewport and focus. Never tripped offline. | Output that fails WCAG 2.1 AA targets. | 85, same reason as T14. |
| T16 | meanFunctional (all) | ≥ 90 | mean | **keep 90** | Share of checks satisfied even by tasks that did not fully pass: partial credit must still be high. The half-done mock scores 77.6. | The model satisfies too few of the required checks. | 85. |
| T17 | meanEfficiency (all) | ≥ 50 | mean | **keep 50 as PROVISIONAL; recalibrate after Stage B** | Tokens (50), turns (25) and latency (25) relative to the task budget. Weak as a gate: the slow mock (3× the time) still scored 83, so 50 only catches gross waste. | Tokens, turns or latency far above budget. | 70 once real data shows the typical score. |
| T18 | passRate (security-remediation, 4) | ≥ 0.90 | 4 / **0** | **keep 0.90 (4 of 4)** | Fixing a vulnerability wrongly is worse than not fixing it; zero misses is a deliberate standard here, not an accident of rounding. P95 = 81.5 %. | The model cannot be trusted to remediate security issues: block use for that task type. | 0.75 (3 of 4) plus a required human review of every miss; or grow the category to 8 tasks and allow one miss. |
| T19 | passRate (arabic-rtl, 3) | ≥ 0.85 | 3 / **0** | **change to 0.66 (2 of 3) and add T21 below** | 0.85 on three tasks is 3 of 3 (P95 = 85.7 %). Arabic is the product default (D-32): the bar belongs on all Arabic work, which is a much larger group (T21). | The model's Arabic/RTL handling is not reliable. | Keep 0.85 and grow `arabic-rtl` to 6 tasks. |
| T20 | passRate (accessibility, 3) | ≥ 0.85 | 3 / **0** | **change to 0.66 (2 of 3)** | Same arithmetic as T19. WCAG 2.1 AA is a product target; the static UI dimension (T15) covers it across all UI tasks. | The model ignores accessibility. | Keep 0.85 and grow `accessibility` to 6 tasks. |
| **T21 (new, not in code)** | passRate (all tasks in Arabic or about RTL: 24 + 1 = **25**) | — | 25 / 3 | **add ≥ 0.85** | The Arabic dimension of the scorecard already measures it (`report.arabicRtl`); 3 misses are allowed, so the bar is meaningful and not noise. | The model is materially worse in Arabic than the product's default language requires. | 0.80 (5 misses). |
| Floor | passRate of every category | ≥ 0.70 | 3–6 / see §0 | **change the rule: min passes = ⌈0.70 n⌉ for n ≥ 5; n − 1 (one miss) for n ≤ 4** | The floor exists so one weak category cannot hide in an average. As proposed it is 3/3 in 17 categories, which no real model passes reliably (7.5 % at 0.95). One miss in a small category is information, not proof. | A category is weak: the model is not qualified for that kind of work, whatever the average. | Keep ≥ 0.70 and grow every small category to 6 tasks (option 3); or apply the floor only to categories with ≥ 5 tasks and report the rest. |
| Human | human acceptance (reviewed runs) | ≥ 0.70, not measured | ≥ 20 tasks, 2+ reviewers | **keep 0.70, with the protocol of §4** | No offline metric says a person would accept the result. Blind, ≥ 20 tasks, ≥ 2 named reviewers, ≥ 90 % coverage, kappa reported, adjudication. | The numbers say the model is fine and people disagree: do not qualify. | 0.80 for a premium tier. |

If the recommendations are accepted, the engineering change is small and mechanical, and is done **after** the owner accepts: T08, T19, T20 values; T21 (needs a scope for the Arabic/RTL group, which the report already carries); the floor rule in the gate; `THRESHOLDS_VERSION` becomes `3-proposed` so an acceptance of `2-proposed` never covers it; tests pin the old list unchanged as they do today.

## 3. Recommended rule set in one list
Keep: T01–T07, T09–T16, T18. Change: T08 → 0.80; T19 and T20 → 0.66 (2 of 3; 0.67 would round up to 3 of 3); the category floor → "⌈0.70 n⌉ for n ≥ 5, one miss for n ≤ 4". Add: T21 (Arabic/RTL group ≥ 0.85). Mark T10, T11, T17 **provisional**.

**Provisional means a controlled recalibration, not an escape hatch.** Latency and token use cannot be known offline. Thresholds must be accepted *before* a gating result exists, otherwise they can be fitted to the result. Stages A and B are smoke and representative runs and gate nothing, so the owner may re-version T10, T11 and T17 once, after Stage B and before Stage C, from measured values; that re-versioning is recorded, needs a fresh acceptance, and no later change is allowed to follow a gating run.

## 4. The human reviewer protocol (the gate that no metric replaces)
- At least **2 named reviewers** (decision REV: the owner names them; they are people, not roles); at least **20 tasks** sampled across the categories, **blind** (model identity hidden; ids are shuffled per reviewer), at least **90 %** of sampled items reviewed by both; Cohen's kappa is computed and reported; a disagreement is adjudicated by a third person or by the owner and recorded; acceptance bar 0.70.
- Reviewer time is not a vendor cost, but it is the scarcest resource. An assumption to be replaced by the reviewers' own estimate: 10–15 minutes per item → 20 items × 2 reviewers ≈ 7–10 hours in total for one model.
- The reviewers need no access to production data: every task is synthetic.

## 5. What the owner decides and what each choice costs
See `PHASE2-03-approval-inputs.md`, decision 1. In short: *accept the list as recommended (§3), accept it unchanged knowing the §0 table, accept with repeat runs (+$167 maximum for Stage C at Opus 5.5 list price), or fund task growth*. None of them costs vendor money to decide; all of them must be decided **before** Stage C and the first three before Stage A.

## 6. Limits of this review
- The probabilities assume independent tasks and a fixed per-task success rate. Real models fail some tasks systematically and others at random; real pass rates are unknown until Stage B/C.
- The scripted models are not models. They show which bars *can* fail.
- Offline replay of REFERENCE or MOCK recordings is never real-model performance, and nothing here is.
- Static security, code and UI rules are heuristics over the changed files; they do not replace the security review (decision SEC-AG) or the human review.
