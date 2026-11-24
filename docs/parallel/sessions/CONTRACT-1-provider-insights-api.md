# CONTRACT-1 — provider administration read APIs (health, capability registry, usage report, rate card history) and `discover_models`

- **Requester:** Session 02 (AI Providers / S-AG4) · **Contract:** `spec/openapi/openapi.yaml` (+ SDK regeneration) · **Additive:** yes (four new GET paths, one new `action` value on an existing POST; no existing schema changes)
- **Why:** the services exist and are tested (`apps/api/src/modules/ai/internal/provider-insights.service.ts`, `provider.service.ts#rateCardHistory`, integration tests `provider-insights.int.spec.ts`, `rate-card-history.int.spec.ts`, `resilience.int.spec.ts`), but nothing can expose them over HTTP or in `apps/admin` until the spec has the routes (`spec:drift` would fail on an unspecified route). The admin UI work (gap G12) waits on the regenerated SDK.
- **Sessions affected:** 01 (spec + SDK), 07 (E2E/QA of the new screens later). None of the other workers.
- **Permissions:** all four GETs `admin:ai:read` (platform realm, `x-nuzm-realm: admin`), like `listAiModelProviders`. `discover_models` needs `admin:ai:manage` + MFA step-up like the other POST actions. No new permission.

## 1. Paths (proposed YAML, to add after `/v1/admin/ai/model-providers/{id}/connection-test`)
```yaml
  /v1/admin/ai/model-providers/capability-registry:
    get:
      operationId: getAiCapabilityRegistry
      tags: [ai]
      summary: 'Model capability registry'
      description: 'Every model of every configured provider with a registered adapter: limits, whether it is priced and enabled, and for each capability whether it is declared, whether the router may rely on it (effective) and why (`basis`). Unknown = unsupported: a tool-calling capability of a real provider is effective only with VERIFIED evidence for the adapter contract. Read-only. Platform permission `admin:ai:read`.'
      x-nuzm-platform-permission: admin:ai:read
      x-nuzm-realm: admin
      security: [{ sessionCookie: [], csrfHeader: [] }]
      responses:
        '200': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/AiCapabilityRegistry' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
  /v1/admin/ai/model-providers/health:
    get:
      operationId: getAiProviderHealth
      tags: [ai]
      summary: 'Model provider health (this API process)'
      description: 'Rolling five-minute window per provider and per provider/model, kept IN MEMORY by the gateway of the serving process: it starts empty after a restart and does not merge several API instances (`scope` says so). Status is derived from the success rate and the circuit breaker; latency percentiles are over successful calls. Read-only. Platform permission `admin:ai:read`.'
      x-nuzm-platform-permission: admin:ai:read
      x-nuzm-realm: admin
      security: [{ sessionCookie: [], csrfHeader: [] }]
      responses:
        '200': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/AiProviderHealth' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
  /v1/admin/ai/usage:
    get:
      operationId: getAiProviderUsageReport
      tags: [ai]
      summary: 'Provider usage report'
      description: 'Aggregates the append-only `ai.model_usage` rows across organizations (or one, with `orgId`) by provider, model or UTC day. Totals are integer strings. `costMinor` is the PROVIDER cost (our cost, in `costCurrency`), `null` with `costCurrency: MIXED` when a group mixes currencies. At most 366 days and 1000 rows (`truncated`). Read-only. Platform permission `admin:ai:read`.'
      x-nuzm-platform-permission: admin:ai:read
      x-nuzm-realm: admin
      security: [{ sessionCookie: [], csrfHeader: [] }]
      parameters:
        - { name: from, in: query, required: true, schema: { type: string, format: date-time } }
        - { name: to, in: query, required: true, schema: { type: string, format: date-time } }
        - { name: groupBy, in: query, required: false, schema: { type: string, enum: [provider, model, day], default: provider } }
        - { name: providerCode, in: query, required: false, schema: { type: string } }
        - { name: orgId, in: query, required: false, schema: { type: string, format: uuid } }
      responses:
        '200': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/AiProviderUsageReport' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
  /v1/admin/ai/model-providers/{id}/rate-card-versions:
    get:
      operationId: listAiRateCardVersions
      tags: [ai]
      summary: 'Rate card history of a model provider'
      description: 'Newest first (at most 200): every change of the card CONTENT since migration 1900, each with what it changed against the version before it. Append-only; a re-save of the same card appends nothing. Read-only. Platform permission `admin:ai:read`.'
      x-nuzm-platform-permission: admin:ai:read
      x-nuzm-realm: admin
      security: [{ sessionCookie: [], csrfHeader: [] }]
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/AiRateCardVersionList' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '404': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
```
Route order note: `/capability-registry` and `/health` must be registered before the `:id` routes in the controller (they are literal segments).

## 2. Schemas (to add under `components/schemas`)
```yaml
    AiCapabilityRegistry:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            type: object
            required: [providerCode, modelId, providerEnabled, priced, contextTokens, maxOutputTokens, latencyClass, capabilities, effective, pending]
            properties:
              providerCode: { type: string }
              modelId: { type: string }
              providerEnabled: { type: boolean }
              priced: { type: boolean, description: 'has a rate card entry; without one the router never offers the model' }
              contextTokens: { type: integer }
              maxOutputTokens: { type: integer }
              latencyClass: { type: string, enum: [low, medium, high] }
              effective: { type: array, items: { type: string }, description: 'capabilities the router may rely on' }
              pending: { type: array, items: { type: string }, description: 'declared but not effective (evidence or contract missing)' }
              capabilities:
                type: array
                items:
                  type: object
                  required: [capability, declared, effective, basis]
                  properties:
                    capability: { type: string }
                    declared: { type: boolean }
                    effective: { type: boolean }
                    basis: { type: string, enum: [adapter_declared, dev_reference, evidence_verified, not_declared, contract_too_old, needs_tool_use, no_evidence, evidence_other_contract] }
    AiProviderHealth:
      type: object
      required: [scope, items]
      properties:
        scope: { type: string, enum: [process] }
        items:
          type: array
          items:
            type: object
            required: [key, status, samples, successPerMille, p50LatencyMs, p95LatencyMs, lastErrorCode, lastErrorAt, lastSuccessAt, breaker]
            properties:
              key: { type: string, description: '`provider` or `provider/model`' }
              status: { type: string, enum: [unknown, healthy, degraded, unhealthy] }
              samples: { type: integer }
              successPerMille: { type: [integer, 'null'] }
              p50LatencyMs: { type: [integer, 'null'] }
              p95LatencyMs: { type: [integer, 'null'] }
              lastErrorCode: { type: [string, 'null'] }
              lastErrorAt: { type: [integer, 'null'], description: 'epoch milliseconds' }
              lastSuccessAt: { type: [integer, 'null'], description: 'epoch milliseconds' }
              breaker: { type: string, enum: [closed, open, half_open] }
    AiProviderUsageReport:
      type: object
      required: [from, to, groupBy, rows, truncated]
      properties:
        from: { type: string, format: date-time }
        to: { type: string, format: date-time }
        groupBy: { type: string, enum: [provider, model, day] }
        truncated: { type: boolean }
        rows:
          type: array
          items:
            type: object
            required: [providerCode, modelRef, day, calls, okCalls, errorCalls, estimatedCalls, tokensIn, tokensOut, credits, costMinor, costCurrency, p50LatencyMs, p95LatencyMs]
            properties:
              providerCode: { type: string }
              modelRef: { type: [string, 'null'] }
              day: { type: [string, 'null'] }
              calls: { type: integer }
              okCalls: { type: integer }
              errorCalls: { type: integer }
              estimatedCalls: { type: integer }
              tokensIn: { type: string }
              tokensOut: { type: string }
              credits: { type: string }
              costMinor: { type: [string, 'null'] }
              costCurrency: { type: [string, 'null'] }
              p50LatencyMs: { type: [integer, 'null'] }
              p95LatencyMs: { type: [integer, 'null'] }
    AiRateCardVersionList:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            type: object
            required: [id, version, recordedBy, recordedAt, models, changes]
            properties:
              id: { type: string }
              version: { type: string }
              recordedBy: { type: string }
              recordedAt: { type: string, format: date-time }
              models: { type: object, additionalProperties: { type: object, required: [creditsPerMillionInput, creditsPerMillionOutput], properties: { creditsPerMillionInput: { type: string }, creditsPerMillionOutput: { type: string } } } }
              changes:
                type: array
                items:
                  type: object
                  required: [modelId, change]
                  properties:
                    modelId: { type: string }
                    change: { type: string, enum: [added, removed, changed] }
                    before: { type: object, additionalProperties: { type: string } }
                    after: { type: object, additionalProperties: { type: string } }
```
(Use the repo's existing nullable convention if it differs from `type: [x, 'null']`.)

## 3. New `action` value on `actOnAiModelProvider`
Add `discover_models` to the enum of `AiModelProviderAction.action` and to the `description` list: `discover_models` (admin:ai:manage; body `id`) asks the provider which models its key can see (a LIVE, read-only request, no prompt, nothing billed) and reconciles with the adapter: `{providerCode, live: true, checkedAt, confirmed[], unlistedByVendor[], notDeclared[{modelId, displayName?, createdAt?}]}`. 422 `unsupported_capability` unless `AI_LIVE_PROVIDERS` lists the provider (D3), in production (D-12), or for a provider without discovery. A model the adapter does not declare is reported and **never offered**. Audited (`ai.provider.models_discovered`). The result is not capability evidence. The response schema of this action is a new `AiModelDiscovery` object; if a single response schema per operation is required, return it under the existing `AiModelProvider` envelope as `discovery` instead (tell Session 02 which).

## 4. Controller code to add (Session 02 will add it as soon as the Master confirms the spec; it is in `apps/api/src/modules/ai/admin-ai-providers.controller.ts`)
```ts
  @RequirePlatformPermission('admin:ai:read') @Get('capability-registry') registry() { return this.insights.capabilityRegistry(); }
  @RequirePlatformPermission('admin:ai:read') @Get('health') health() { return this.insights.health(); }
  @RequirePlatformPermission('admin:ai:read') @Get(':id/rate-card-versions') versions(@Param('id') id: string) { return this.providers.rateCardHistory(id); }
  // separate controller @Controller('v1/admin/ai/usage'): GET → this.insights.usageReport({ from: new Date(q.from), to: new Date(q.to), groupBy: q.groupBy ?? 'provider', providerCode: q.providerCode, orgId: q.orgId })
  // in act(): case 'discover_models': need('admin:ai:manage'); return this.insights.discoverModels(who.userId, id);
```
Also add the four paths to `spec/openapi/planned-paths.yaml` only if the repo convention requires it for admin paths.

## 5. Tests added (already green on branch `feature/ai-providers`)
`provider-insights.int.spec.ts` (10), `rate-card-history.int.spec.ts` (5), `resilience.int.spec.ts` (15). Contract tests for the new routes (status codes, permission, step-up on the action, no credential in any answer) follow with the controller.
