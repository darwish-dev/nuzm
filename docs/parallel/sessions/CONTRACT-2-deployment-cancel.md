# CONTRACT-2 — cancel a deployment, `cancelled` state, `simulated` flag

- Requester: Session 06 (Deployment) · Status: PROPOSED (Master answers ACCEPTED / REVISED / REFUSED here)
- Contract: OpenAPI `/v1/deployments/{id}/cancel` (new), schema `Deployment` (`state` enum + `simulated`), `spec/db/ownership.yaml` (no new table or column), SDK regeneration (`pnpm sdk:generate`).
- Code already in the branch: `apps/api/src/modules/deploy/deployments.controller.ts` (`@Post(':id/cancel')`), `internal/deploy.service.ts` (`cancel`, checkpoints, `recoverOrphan`), migration `packages/db/migrations/deploy/1980__deploy__deployment_cancelled.sql` (+ `.down.sql`). `pnpm spec:drift` reports the new route until the patch below is applied.

## Proposed OpenAPI patch
Under `paths`, after `/v1/deployments/{id}/rollback`:
```yaml
  /v1/deployments/{id}/cancel:
    post:
      operationId: cancelDeployment
      tags: [deploy]
      summary: 'Cancel a queued or running deployment'
      description: 'A queued deployment is cancelled at once (state `cancelled`). A running one is flagged and stops at its next checkpoint (before the build, before staging, before the switch): the staged upload is discarded and the live site is never touched. Once the site has been switched the request is accepted but has no effect (the deployment ends `succeeded`; use rollback). 409 `invalid_state` for a finished deployment. 422 `unsupported_capability` for a web-app deployment (the app builder pipeline has no cancel yet). Audit: `deploy.deployment.cancelled`.'
      x-nuzm-permission: deploy:write
      x-nuzm-org-scoped: true
      security: [{ sessionCookie: [], csrfHeader: [] }, { apiKey: [] }]
      parameters:
        - { $ref: '#/components/parameters/OrgHeader' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '202':
          description: 'Success'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Deployment' }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '404': { $ref: '#/components/responses/Problem' }
        '409': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
```
Schema `Deployment` (additive): `state` enum gains `cancelled`; new optional property
`simulated: { type: boolean, description: 'true: published through the local in-memory stand-in (SIMULATED, nothing reached a hosting node); false is reserved for a live-verified real publisher' }`.

## Why
Customers could not stop a deployment they started by mistake (queued behind another one, or running); the platform had no recovery for a deployment whose worker died after its operation was cancelled. `simulated` makes the local stand-in visible to API clients and to the console (HG-05/HG-06: nothing real is deployed).

## Compatibility
Additive: new route, new enum member, new optional field. Existing clients that switch on `state` should treat an unknown terminal state as finished (the console already shows unknown states by their raw name). Migration 1980 only widens a CHECK constraint and the transition guard (documented reversal: dev-only `.down.sql`; production is forward-fix).

## Tests added
`apps/api/src/modules/deploy/deploy-s06.int.spec.ts` (cancel queued, cancel running at the checkpoint, too late after the switch, 401/403/404, recovery by the tick). See REPORT-06 for the actual results.

## Sessions affected
01 (spec, SDK), 05 (reads `Deployment.state` for builder screens only: no change needed).

## Master answer
(pending)
