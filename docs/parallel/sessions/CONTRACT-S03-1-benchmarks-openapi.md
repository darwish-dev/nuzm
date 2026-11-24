# CONTRACT-S03-1 — OpenAPI paths for the benchmark admin API

- **Requester:** Session 03 (Benchmarks / S-AG5) · **Status:** REQUESTED (Master answers ACCEPTED / REVISED / REFUSED here)
- **Contract:** `spec/openapi/openapi.yaml` (+ SDK regeneration `pnpm sdk:generate`)
- **Current text:** no `/v1/admin/ai/benchmarks*` path exists (`spec/openapi/openapi.yaml` has `/v1/admin/ai/quality` at line ~8717 as the nearest sibling).
- **Why:** the benchmark dashboard (apps/admin) and the governance workflows (thresholds acceptance, budget, reviewers, qualification) need an API. The controller exists and is tested: `apps/api/src/modules/benchmarks/admin-benchmarks.controller.ts` (not registered until the Master merges `BenchmarksModule`, see CONTRACT-S03-3).
- **Additive?** Yes: three new operations on two new paths; no existing path or schema changes.
- **Sessions affected:** 01 (applies the patch), 07 (e2e), 02 (reads nothing from here).

## Proposed YAML (insert after `/v1/admin/ai/quality`)
```yaml
  /v1/admin/ai/benchmarks:
    get:
      operationId: getAiBenchmarks
      tags: [ai]
      summary: 'Benchmark dashboard data'
      description: 'Golden dataset (version, hash, tasks per category), the acceptance thresholds with their status (PROPOSED until the owner accepts the exact version), the recorded benchmark runs with their evidence label, the model qualification records, the approved live-benchmark budget, the named reviewers, the agent security review and whether the live runner is available (it is not). Every run states what kind of evidence it is: a reference oracle, a scripted mock, or an offline replay of a recorded run; none is real-model performance. Feature flag `ai.benchmarks` (default OFF): when off the answer is `{ enabled: false }`. Platform permission `admin:ai:read`.'
      x-nuzm-platform-permission: admin:ai:read
      x-nuzm-realm: admin
      security: [{ sessionCookie: [], csrfHeader: [] }]
      responses:
        '200':
          description: 'Success'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AiBenchmarksOverview' }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
    post:
      operationId: actOnAiBenchmarks
      tags: [ai]
      summary: 'Record a benchmark run, accept thresholds, set the budget, review, qualify'
      description: "Body {action, requestId (UUID chosen by the caller; a repeated request returns the stored result), ...}. Actions: run_offline (admin:ai:manage; source `reference` or `mock:<profile>`; replays the golden dataset offline, calls no model, stores the report; any other source is 422), compare (admin:ai:read; ids of 2 to 6 runs), accept_thresholds (admin:ai:approve; version must equal the thresholds in force), set_budget (admin:ai:approve; ref, currency, maxCostMinor, maxTokens, maxRequests), record_security_review (admin:ai:approve; ref, reviewedBy, passed), set_reviewers (admin:ai:manage; named reviewers), create_review_plan (admin:ai:manage; runId; the reviewer view hides the model identity), submit_review (admin:ai:manage; scores 1-5, accept), evaluate_gate (admin:ai:manage; runId, optional baselineRunId; the strict rollout gate, fails closed), propose_qualification and qualification_event (admin:ai:manage; approve needs admin:ai:approve and a person other than the proposer), attempt_live_run (admin:ai:approve; evaluates the preconditions and records the refused attempt: the live runner has no capture source in this build and ALWAYS answers started=false with the list of refusals). Needs a recent MFA verification. Audited (`ai.benchmark.*`). 422 `kind_not_available` while the feature flag is off; 422 `validation_failed` for an invalid body."
      x-nuzm-platform-permission: admin:ai:read
      x-nuzm-realm: admin
      security: [{ sessionCookie: [], csrfHeader: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/AiBenchmarksAction' }
      responses:
        '200':
          description: 'Success'
          content:
            application/json:
              schema: { type: object, additionalProperties: true }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '404': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
  /v1/admin/ai/benchmarks/runs/{id}:
    get:
      operationId: getAiBenchmarkRun
      tags: [ai]
      summary: 'A stored benchmark run'
      description: 'The full report (by kind, by category, dimensions, cost, findings, evidence label and disclaimer), its fingerprint and a markdown rendering. Platform permission `admin:ai:read`.'
      x-nuzm-platform-permission: admin:ai:read
      x-nuzm-realm: admin
      security: [{ sessionCookie: [], csrfHeader: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          description: 'Success'
          content:
            application/json:
              schema: { type: object, additionalProperties: true }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '404': { $ref: '#/components/responses/Problem' }
```
Schemas (`components/schemas`): `AiBenchmarksOverview` (object, `enabled: boolean` required; the remaining members as returned by `BenchmarksService.overview()`: `dataset`, `thresholds`, `budget`, `securityReview`, `reviewers`, `runs`, `qualifications`, `live`) and `AiBenchmarksAction` (object with `action` enum run_offline | compare | accept_thresholds | set_budget | record_security_review | set_reviewers | create_review_plan | submit_review | evaluate_gate | propose_qualification | qualification_event | attempt_live_run, and `requestId` uuid; other members per action, `additionalProperties: true`). The exact TypeScript shapes are in `apps/api/src/modules/benchmarks/internal/benchmarks.service.ts` and `packages/domain/src/ai/benchmarks/`.

## Tests added
`apps/api/src/modules/benchmarks/internal/benchmarks.service.spec.ts` (11), `benchmarks.int.spec.ts` (4, real Postgres, RLS and append-only), admin `lib/benchmarks.spec.ts` and `components/benchmarks-dashboard.spec.tsx`. After applying: `pnpm spec:lint`, `pnpm spec:drift`, `pnpm sdk:generate && pnpm sdk:check`. The admin page reads the overview through `apiDownload` today and can switch to the typed client afterwards (a one-line change, listed in REPORT-03).

## Applied (Session 03, on the Master's temporary authorization, after merging integration/ai-engine)
Applied on feature/ai-benchmarks; sdk was NOT regenerated (Master does that once). See REPORT-03 "Integration batch 2" for the checks seen.
