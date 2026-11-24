# CONTRACT-5 — deployment policy switches (O-1, O-2), rollback approval body

- Requester: Session 06 (Deployment), Phase 2 · Status: PROPOSED (Master answers ACCEPTED / REVISED / REFUSED here)
- Contract surface: OpenAPI (two new operations on `/v1/deployments/policy`, an optional request body on `/v1/deployments/{id}/rollback`, a new schema `DeploymentPolicy`), `spec/db/ownership.yaml` (new table `deploy.org_policies`, migration range 2180-2199), SDK regeneration (`pnpm sdk:generate`, Master only).
- Code already in the branch: `apps/api/src/modules/deploy/deployments.controller.ts` (`GET`/`PUT policy`, rollback body), `internal/policy.service.ts`, `internal/deploy.service.ts` (`rollbackApproval`, role check), migration `packages/db/migrations/deploy/2180__deploy__org_policies.sql` (+ `.down.sql`). `pnpm spec:drift` reports the two new routes until the patch below is applied.
- Defaults equal the behaviour before this change (no row = `owner, admin, developer` may confirm a production publish; a rollback reuses the earlier approval). Nothing changes for any organization until an owner/admin sets a value.

## Proposed `spec/db/ownership.yaml` patch (REQUIRED: the migration runner refuses ordinal 2180 without the range)
I ran my integration tests with the first three hunks applied LOCALLY and UNCOMMITTED in my worktree, then reverted them.
```yaml
# schemas.deploy
    extended_by:
      - M10
      - S06-DEPLOY
      - S06-DEPLOY2 # phase 2 policy table, migration 2180
    tables:
      # … existing …
      - org_policies
# migration_ranges
  S06-DEPLOY2: "2180-2199"
# classification (every column; none is personal data: a user id is the actor reference, classed like the other `created_by` columns)
    deploy.org_policies:
      org_id: internal
      production_publish_roles: internal
      rollback_requires_own_approval: internal
      updated_by: internal
      created_at: internal
      updated_at: internal
      version: internal
```
Tenant safety: `org_id` primary key, RLS `FORCE`, `org_isolation` policy on `app.org_id`, platform read policy, grants to `nuzm_app`/`nuzm_worker` (SELECT, INSERT, UPDATE) and `nuzm_readonly_reporting` (SELECT). No cross-schema foreign key. No `data_region` column: the row holds no customer content and is not region-bearing.

## Proposed OpenAPI patch
Under `paths`, after `/v1/deployments`:
```yaml
  /v1/deployments/policy:
    get:
      operationId: getDeploymentPolicy
      tags: [deploy]
      summary: 'Read the deployment policy of the organization'
      description: 'The switches for owner decisions O-1 (`productionPublishRoles`: who may confirm a production publish of a website) and O-2 (`rollbackRequiresOwnApproval`). `source` is `default` when the organization never set one (the defaults equal the behaviour before the switches existed).'
      x-nuzm-permission: deploy:read
      x-nuzm-org-scoped: true
      security: [{ sessionCookie: [], csrfHeader: [] }, { apiKey: [] }]
      parameters:
        - { $ref: '#/components/parameters/OrgHeader' }
      responses:
        '200':
          description: 'Success'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/DeploymentPolicy' }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
    put:
      operationId: setDeploymentPolicy
      tags: [deploy]
      summary: 'Change the deployment policy (owner or admin, signed in as a person)'
      description: 'Send one or both settings. `productionPublishRoles` is a non-empty list of distinct roles from owner, admin, developer and must contain owner. `expectedVersion` makes a concurrent edit a 409. An API key is refused (403) even with the permission. Audit: `deploy.policy.updated` with before and after.'
      x-nuzm-permission: org:security
      x-nuzm-org-scoped: true
      security: [{ sessionCookie: [], csrfHeader: [] }]
      parameters:
        - { $ref: '#/components/parameters/OrgHeader' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                productionPublishRoles:
                  type: array
                  minItems: 1
                  maxItems: 3
                  uniqueItems: true
                  items: { type: string, enum: [owner, admin, developer] }
                rollbackRequiresOwnApproval: { type: boolean }
                expectedVersion: { type: integer, minimum: 0 }
      responses:
        '200':
          description: 'Success'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/DeploymentPolicy' }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '409': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
```
On `/v1/deployments/{id}/rollback` (`post`): add an OPTIONAL request body and describe the new answers.
```yaml
      description: '… (existing text) … When the organization policy `rollbackRequiresOwnApproval` is on, a PRODUCTION rollback answers 403 `approval_required` with an `approvalId`; repeat the request with that id in the body (a signed-in person whose role is in `productionPublishRoles`) to confirm it. The approval is bound to this rollback and single use.'
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              properties:
                approvalId: { type: string, format: uuid }
```
On `/v1/deployments` (`post`) description: add "A production publish is confirmed by a role in `productionPublishRoles` (default owner, admin, developer); another role gets 403 `forbidden` with `policy` and `allowedRoles` and the approval stays pending for an allowed role to confirm."

Schema, under `components.schemas`:
```yaml
    DeploymentPolicy:
      type: object
      required: [productionPublishRoles, rollbackRequiresOwnApproval, source, version]
      properties:
        productionPublishRoles:
          type: array
          items: { type: string, enum: [owner, admin, developer] }
        rollbackRequiresOwnApproval: { type: boolean }
        source: { type: string, enum: [default, organization] }
        version: { type: integer }
        updatedAt: { type: string, format: date-time, nullable: true }
        updatedBy: { type: string, format: uuid, nullable: true }
```
Problem extension members used (RFC 9457 `extra`): `policy`, `allowedRoles` (on 403 `forbidden`), `policy` (on 403 `approval_required` for a rollback). No new error code.

## Why
QA findings O-1 (a developer confirms a production publish alone) and O-2 (a rollback reuses the earlier approval) are owner decisions. The Phase 2 plan asks for them as audited policy switches whose default is today's behaviour, so the decision can be taken later without a code change.

## Compatibility
Additive. A client that never sends a rollback body or reads the policy is unaffected. With the default policy no response changes. A client that treats 403 `approval_required` on rollback as unexpected only meets it after an owner turns the switch on.

## Tests added
`deploy-policy.int.spec.ts` (14), `deploy-releases.int.spec.ts` (5), unit specs for targets, previews, SSL, env refs, hosting target and rehearsal. Results are in REPORT-06 "Phase 2".

## Sessions affected
01 (spec, SDK, ownership manifest), 07 (matrix tests for developer self-publish and rollback authorization; use `GET/PUT /v1/deployments/policy` to set the state), 05 (none: web-app approvals use the app builder's own policy).

## Master answer
(pending)
