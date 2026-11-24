# CONTRACT-S05-P2-2 — O-9 policy `builder.billing_admin_content_access`

- Requester: Session 05 (Phase 2) · Contract: `spec/openapi/openapi.yaml` · Status: ACCEPTED, REVISED and applied by the Master 2026-11-24 (revision: the PUT is session-only, an API key is refused 403 even with `org:update`, in the OpenAPI security and in the controller; the controller was renamed from `.pending`, registered, SDK regenerated; spec:lint, spec:drift 527 routes, sdk:check pass). Additive: yes (one path, two operations, two schemas).
- Decision status: O-9 is PROPOSED, NOT DECIDED. **The default is today's behaviour (`allow`)**; nothing changes until an owner or admin sets `deny` for their own organization, and the proposed policy becomes the default only by an owner decision recorded in `OWNER-APPROVAL-PACK.md`.
- What the setting does: with `deny`, a member whose role is `billing_admin` gets 403 on the five content reads of the builder tools: `GET /v1/builder/projects/{projectId}/review | symbols | import-analysis | components | memory`. Every other role is unaffected (they keep exactly what their permissions give). Every denial is audited (`builder.content.access_denied`, with the operation). A stored value that is present but not understood reads as `deny` (never wider than intended).
- Storage: the organization's own row in `platform.feature_flags` (key `builder.billing_admin_content_access`, value `{"mode":"allow"|"deny"}`; RLS `flags_org_write` already restricts writes to that organization). **No migration.**
- Implemented and tested: `ContentAccessService` (`internal/changes/content-access.service.ts`), enforcement in `builder-insight.controller.ts` (registered, active now), pure policy `builderTools.lifecycle.decideContentAccess`; tests for BOTH settings over HTTP (`builder-lifecycle.int.spec.ts`, describe "O-9": default allow for frank/alice/dave/carol on all five reads; deny → frank 403 ×5 with 5 audit events, alice/dave/carol 200; allow restores; malformed setting 422; garbage value reads as deny).
- The route to read and change it is PARKED (spec:drift fails on an undeclared route): `apps/api/src/modules/appbuilder/pending-contracts/builder-policy.controller.ts.pending`. To apply: add the path below, rename the file to `…/appbuilder/builder-policy.controller.ts`, add `BuilderPolicyController` to the `controllers` array of `appbuilder.module.ts` (the `ContentAccessService` provider is already registered), then `pnpm sdk:generate`. Until then the service is reachable only in code and tests.

## Proposed OpenAPI
```yaml
  /v1/builder/policies/content-access:
    get:
      operationId: getBuilderContentAccessPolicy
      tags: [builder]
      summary: 'Whether a billing administrator may read project content through the builder tools'
      description: 'Answers {mode: allow|deny, default: allow}. allow (the default) = today: a billing administrator reads the review, symbols, import analysis, components and memory of a project. Permission org:read.'
      x-nuzm-permission: org:read
      x-nuzm-org-scoped: true
      security: [{ sessionCookie: [], csrfHeader: [] }, { apiKey: [] }]
      parameters: [{ $ref: '#/components/parameters/OrgHeader' }]
      responses:
        '200': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/BuilderContentAccessPolicy' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
    put:
      operationId: setBuilderContentAccessPolicy
      tags: [builder]
      summary: 'Allow or deny billing administrators project content (owners and admins)'
      description: 'Body {mode: allow|deny}. deny makes the five content reads of the builder tools answer 403 for the billing_admin role of this organization only. Audited (builder.policy.content_access_changed, with before and after). Permission org:update.'
      x-nuzm-permission: org:update
      x-nuzm-org-scoped: true
      security: [{ sessionCookie: [], csrfHeader: [] }, { apiKey: [] }]
      parameters: [{ $ref: '#/components/parameters/OrgHeader' }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/BuilderContentAccessPolicyInput' }
      responses:
        '200': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/BuilderContentAccessPolicy' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
# components/schemas
    BuilderContentAccessPolicy:
      type: object
      additionalProperties: false
      required: [mode, default]
      properties:
        mode: { type: string, enum: [allow, deny] }
        default: { type: string, enum: [allow] }
    BuilderContentAccessPolicyInput:
      type: object
      additionalProperties: false
      required: [mode]
      properties:
        mode: { type: string, enum: [allow, deny] }
```
