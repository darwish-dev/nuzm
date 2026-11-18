# M09 interface contract (for the M10, M11 and M12 sessions)

Status: **PROPOSAL published at the end of S37, extended at the end of each M09 sprint.** Nothing here is accepted by the owner. Everything below exists in the branch `claude/m09-ai-builder-a33bbe` (cut from `main` 676df74); where a section says *planned* it is not built yet. If you need something different, message the M09 session rather than editing these modules: M09 owns schemas `ai`, `builder`, `deploy` (migrations 1200–1399).

## 1. Model gateway (S37, built)
Single entry for EVERY model call in the platform. Import only from `apps/api/src/modules/ai` (`index.ts`).

```ts
GatewayService.invoke(call: GatewayCall): Promise<GatewayResult>
GatewayCall = { orgId, runId?, projectId?, runKind?, task, capability: 'chat'|'structured-output'|'long-context'|'embeddings'|'vision',
                dataClass: 'public'|'internal'|'customer-content'|'personal'|'financial'|'credentials', messages[], maxTokens, responseFormat?, callId, runBudget?, signal?, actorUserId? }
GatewayResult = { text, finishReason, tokensIn, tokensOut, estimated, credits(bigint), providerCode, modelRef, region, callId, duplicate }
```
- `callId` must be deterministic per logical call (`<runId>:<step>:<attempt>`): usage, reservation and the ledger posting dedupe on it; reusing a settled `callId` is a `409 conflict` and adds nothing.
- Order of checks: kill switch → outbound secret scan (blocks, audits `ai.secret_scan.blocked`) → candidates (enabled provider + registered adapter + **rate card entry**; no price = not offered) → residency per provider via `assertResidency` (hook `m09-model-gateway`, processor = provider code, which must be a processor of the ROPA `adapter:model` entry) → data terms (unattested ⇒ blocked for `personal`/`customer-content`/`financial`; `credentials` never) → rank (cheapest worst-case reservation, then latency) → per-candidate budget reservation → call (timeout, 2 attempts per candidate on retryable errors, same reservation) → settle.
- Errors (ProblemException codes): `ai_unavailable` 503 (kill switch), `unsupported_capability` 422 (no provider/model), `residency_denied` 403 (residency or data terms), `secret_detected` 422, `insufficient_credits` 402, `budget_exceeded` 402 (`extra.level`: run|project|orgDaily|orgTotal), `content_blocked` 422 (provider refused), `service_unavailable` 503 (providers failed), `conflict` 409 (call id reuse / cancelled).
- A fallback is only ever another already-ALLOWED candidate and needs its own reservation: it can neither cross residency nor overspend.
- `ModelAdapter` contract + deterministic mock + conformance suite: package `@nuzm/adapter-model` (`MockModelAdapter` takes a `handler(req)` script; `failNext(error,n)` injects faults; `reportUsage:false` exercises the estimate path). **No real provider exists** (D-18, HG-09-01 OPEN); `AI_LOCAL_REFERENCE=true` (never in production) registers `mock-model`.
- Provider registry `ai.model_providers` is tenant-less (admin scope). Enabling needs: registered adapter, rate card, **human-attested data terms with a reference**, a second person (dev `mock-*`/`local-*` exempt, only outside production). Region must be a region id known to the residency region registry (e.g. `sa-central`); a bare country code is "unverified" and denied.

## 2. Budgets, credits, metering (S37, built)
- Credits are wallet money: `1 credit = AI_CREDIT_UNIT_MINOR minor units` (default 1; D-23 OPEN) of the org's `AI_CREDIT_CURRENCY` (SAR). `ai.credit_balances` = projection (wallet − open reservations); the wallet (ledger account 2100) is the source of truth. Settlement is one `recipes.usageChargeWallet` posting per call through `LedgerPostingService`, idempotency key `ai:call:<orgId>:<callId>`. **Risk for M03/M12:** `ai.credits_consumed` is ALSO emitted as a usage event (tag `settlement=wallet`) for visibility; the invoice builder must not bill it a second time. VAT on consumption is posted as 0 here (policy open, HG-03-04).
- Reservation = worst case (`estimateTokens(prompt) + maxTokens` at the rate card, rounded up) held under a per-org row lock; it must fit EVERY level (balance, run caps, project totals, org daily, org total). `ai.reservations` rows are `held → settled|released`; a sweeper (`BudgetService.sweepExpired`) releases crashed calls after `AI_RESERVATION_TTL_SECONDS`.
- `ai.model_usage` is append-only, unique `(org_id, call_id)`; `estimated=true` when the provider reported no counts. Meters emitted in the settle transaction (outbox): `ai.tokens_input`, `ai.tokens_output` (dims `model_id`,`region`), `ai.credits_consumed` (dim `run_kind`); deterministic ids from `(org, meter, callId, reservation time)`. Quantity-0 events are not emitted.
- API: `GET /v1/ai/models|credits|budgets`, `PUT /v1/ai/budgets` (If-Match), admin `GET/POST /v1/admin/ai/model-providers` (actions configure|attest|request_enable|enable|disable|kill_switch). Feature flag `ai.enabled` gates ALL customer routes of ai, builder and deploy (404 when off); `ai.killswitch` (global or per org row) stops all calls on the next call.

## 3. `ai.runs`, sessions, approvals (S38, *planned — shapes final unless noted*)
- One run table; `kind` ∈ website|edit|chat now, webapp|mobile|test-fix reserved for M10 (`422 unsupported_kind` until a handler is registered). States `queued → running → waiting_approval → succeeded|failed|cancelled|budget_exceeded` (DB trigger enforces transitions). A run executes in **segments**, each a `platform.operations` row of kind `ai.run`; `checkpoint jsonb` is the resume state; approvals start the next segment.
- `ai.run_events (run_id, seq, type, data)` is the persisted event log behind SSE (`Last-Event-ID` = last `seq`).
- M10 extension point (planned): a `RunKindRegistry` in the ai module; M10 registers `{kind, tools, execute(ctx)}` and adds `ai.run_steps` / `ai.tool_calls`. The M09 website/edit/chat handlers use the same registry.
- Approvals `ai.approvals`: kinds plan|apply_changes|publish|delete|spend|auto_apply; bound to run + SHA-256 of the exact action; 24 h expiry; approver = human member with `ai:write`.

## 4. `builder.*` and the site model (S38–S40, *planned*)
- `builder.projects.type` is a CHECK list; M10 extends it with webapp|mobile in its own migration. A project head is `builder.project_versions` (`site_model jsonb`, schema versioned); rendered output is `builder.project_files` (one file store, unique `(version_id, path)`). The site model, renderer, templates and editor ops are pure code in `packages/domain` (not `packages/contracts`, which has no package yet).

## 5. `deploy.*` (S39–S41, *planned*)
- `POST /v1/deployments {projectId, target:{hostingSiteId}, environment}` → `deploy.deployments` + `platform.operations`. The M06 `HostingAdapter` has **no deploy/upload method** (it manages sites, domains, certs, backups only). M09 therefore defines a port `SiteArtifactPublisher` (publish artifact, smoke, switch, rollback) with a fake implementation; the real implementation needs a node-agent command added to M06's allow-list — recorded as an open item, live publish stays BLOCKED (HG-05-01/02, HG-06-01). M10 extends `deploy.deployments.target_kind` with compute targets.

## 6. For M11 (workflows, marketplace)
- AI run and deployment events are audit events (`ai.run.*`, `deployment.*`) and outbox topics will be named `ai.run.<state>` / `deployment.<state>` (planned). Site-model templates live in `packages/domain/src/builder/templates` as versioned fragments (planned) for the marketplace to consume.

## 7. For M12
- Runbooks `ai-budget-incident`, `ai-provider-outage`, `preview-isolation`, `deploy-rollback` (planned). Alerts on reservation sweeps, kill-switch toggles and `ai.secret_scan.blocked` are audit-event based.
