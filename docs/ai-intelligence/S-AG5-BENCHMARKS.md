# S-AG5 — benchmarks and rollout gates (OFFLINE PREPARATION)

Status: **the offline machinery exists and is tested; nothing has been measured on a model.** Code: `packages/domain/src/ai/benchmarks/` (`benchmarks.spec.ts`). Nothing in it calls a model, a network or a clock.

## 1. What exists
- **Golden task dataset:** 24 synthetic tasks (6 website, 6 web app, 6 code edit, 6 tool-calling), Arabic and English prompts, each with a fixture project, structural checks, tool expectations, a budget and a **reference solution**. No customer data, no template content; data class `public`. The spec proves every task is satisfiable (its reference passes) and none is vacuous (an empty proposal fails every one).
- **Offline replay engine:** a recording (tool calls and patch per turn, with usage and latency) is replayed against the fixture: every recorded tool call goes through the gateway's own validator against the declared read-only tools; the patch is applied to a copy only if it has no mode violation (path outside the project, sensitive file, secret) and the run ended with a proposal.
- **Scoring:** per task `passed` and `quality` 0–100 (checks 60, tool use 15, budget 15, discipline 10); quality is 0 for any violation or refused patch.
- **Reports:** per kind and overall (pass rate, valid-patch rate, quality, tool-call validity, violations, tokens, calls, p95 latency, budget kept) and an estimated credit cost at a given rate card (integer math); markdown rendering.
- **Regression detection** against a stored baseline report, and the **rollout gate** `rolloutDecision`.
- **Reference recordings** (`origin: REFERENCE`): produced by this repository's oracle, not by a model. They prove the machinery and are the baseline; they say nothing about any real model, and the gate never allows a rollout on them (status NOT VERIFIED).

## 2. Categories covered (what each measures)
Code generation (code-edit), website generation (website), application generation (webapp), tool calling (tool-calling: required read-only tools, no undeclared tool), cost and tokens (mean tokens, estimated credits, budget kept), quality scoring (the weighted score), reporting (tables, thresholds, regressions).

## 3. What cannot be done offline
Recordings of a real model (needs S-AG4: the probe first, then recorded runs); human acceptance; real latency; cost at the real rate card (D6); build and visual validation of generated apps (needs D-21).

## 4. PROPOSED acceptance thresholds (status PROPOSED; the owner accepts, changes or rejects; version `1-proposed`)
| ID | Scope | Metric | Bar | Why |
|---|---|---|---|---|
| T01 | all | valid-patch rate | ≥ 0.95 | an unappliable proposal is a wasted run |
| T02 | all | mode violations | = 0 | a path escape, sensitive file or secret is never acceptable |
| T03 | all | tool-call validity | ≥ 0.95 | rejected calls cost turns and tokens |
| T04 | all | budget kept | ≥ 0.95 | runs stay inside the ceilings the customer was shown |
| T05 | website | pass rate | ≥ 0.85 | small, bounded edits |
| T06 | web app | pass rate | ≥ 0.75 | multi-file edits are harder |
| T07 | code edit | pass rate | ≥ 0.85 | single-file edits, clear outcome |
| T08 | tool calling | pass rate | ≥ 0.90 | exploring before editing is what the agent adds |
| T09 | all | mean quality | ≥ 85 | weighted score |
| T10 | all | mean tokens per task | ≤ 30,000 | cost per task |
| T11 | all | p95 latency | ≤ 90 s | a customer waits about a minute and a half at most |
| — | human review | acceptance rate | ≥ 0.70 | NOT MEASURED until reviewers exist |
**Regression rule:** a fall of more than 0.02 in a rate (0.02 × 100 in quality), any rise in violations, or mean tokens up more than 10 % against the stored baseline blocks rollout regardless of the absolute bars.

## 5. Next steps
1. Owner accepts or changes the thresholds (checklist §C). 2. After S-AG4 closes for Claude: record each golden task through the real adapter (origin `RECORDED`), store the recordings and a baseline report, run the gate. 3. Add golden tasks from owner-authored projects (never customer data). 4. Name the reviewers, run the human-acceptance protocol. 5. Agent security review.
