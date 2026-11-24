# CONTRACT-1 — builder change tools (preview, version diff, rollback, revert)

- Requester: Session 05 · Contract: `spec/openapi/openapi.yaml` (+ SDK regeneration, `spec/db/ownership.yaml` unaffected: no migration) · Status: PROPOSED
- Current text: web-app rollback has no endpoint (`POST …/versions/{vid}/restoration` is website-only, its text says a web-app restore "is a patch set through POST …/changes"); there is no dry-run and no version diff.
- Why: priority 1 of SESSION-05 (patch / diff / preview / rollback). Implemented and unit-tested: `apps/api/src/modules/appbuilder/internal/changes/change-tools.service.ts` (+ spec, 8 tests) over the pure domain code `packages/domain/src/ai/agent-tools/builder/**` (diff engine, previews, restore/revert plans; 19 + existing tests).
- Additive? Yes: four new operations, no existing schema changes. All behind flag `builder_tools.enabled` (default OFF, 404 when off), permission `builder:read` (preview, diff) / `builder:write` (rollback, revert), org-scoped, audited (`builder.change.rolled_back`, `builder.change.reverted`; previews are read-only and store nothing).
- Apply together: the controller is parked as `apps/api/src/modules/appbuilder/pending-contracts/change-tools.controller.ts.pending` because `pnpm spec:drift` fails on an undeclared route. In the batch that applies this patch: rename it to `…/appbuilder/change-tools.controller.ts` and add `ChangeToolsController` to the `controllers` array of `appbuilder.module.ts` (the `ChangeToolsService` provider is already registered). Then `pnpm sdk:generate`.

## Proposed OpenAPI (YAML, under `paths:`)
```yaml
  /v1/builder/projects/{id}/change-previews:
    post:
      operationId: previewBuilderChange
      tags: [builder]
      summary: 'Dry-run a change set or a unified diff'
      description: 'Body {baseVersion?, patches[] | diff}: exactly one of `patches` (whole-file ops add|modify|delete|rename, the shape of the web-app change set) or `diff` (a unified diff). Nothing is stored. Answers the per-file unified diffs, totals, risks, `approval.required` (many deletions, applied migrations, pipeline files, very large change) and the whole-file ops a diff turned into. 409 `base_mismatch` when baseVersion is not the head, 422 `change_rejected` for a diff that does not apply. Web-app and mobile projects only. Permission `builder:read`. Flag `builder_tools.enabled` (404 when off).'
      x-nuzm-permission: builder:read
      x-nuzm-org-scoped: true
      security: [{ sessionCookie: [], csrfHeader: [] }, { apiKey: [] }]
      parameters:
        - { $ref: '#/components/parameters/OrgHeader' }
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/BuilderChangePreviewInput' }
      responses:
        '200': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/BuilderChangePreview' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '404': { $ref: '#/components/responses/Problem' }
        '409': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
  /v1/builder/projects/{id}/version-diff:
    get:
      operationId: diffBuilderVersions
      tags: [builder]
      summary: 'Diff two versions of a web-app project'
      description: 'Query from, to (version ids). Same view as a preview: per-file unified diffs from `from` to `to`. Permission `builder:read`. Flag `builder_tools.enabled`.'
      x-nuzm-permission: builder:read
      x-nuzm-org-scoped: true
      security: [{ sessionCookie: [], csrfHeader: [] }, { apiKey: [] }]
      parameters:
        - { $ref: '#/components/parameters/OrgHeader' }
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: from, in: query, required: true, schema: { type: string } }
        - { name: to, in: query, required: true, schema: { type: string } }
      responses:
        '200': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/BuilderChangePreview' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '404': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
  /v1/builder/projects/{id}/rollbacks:
    post:
      operationId: rollbackBuilderProject
      tags: [builder]
      summary: 'Roll a web-app project back to an older version'
      description: 'Body {targetVersion, baseVersion?, confirmed?}. Creates a NEW head version (`source: restore`) whose files equal the target; history is never rewritten. Every safety check of the change pipeline runs again. 409 `conflict` when the target is the head or equals it, 409 `base_mismatch` when baseVersion is stale, 422 `change_rejected` when the change needs a human confirmation and `confirmed` is not true. Audited (`builder.change.rolled_back`). Permission `builder:write`. Flag `builder_tools.enabled`.'
      x-nuzm-permission: builder:write
      x-nuzm-org-scoped: true
      security: [{ sessionCookie: [], csrfHeader: [] }, { apiKey: [] }]
      parameters:
        - { $ref: '#/components/parameters/OrgHeader' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/BuilderRollbackInput' }
      responses:
        '201': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/BuilderRollbackResult' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '404': { $ref: '#/components/responses/Problem' }
        '409': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
  /v1/builder/projects/{id}/reverts:
    post:
      operationId: revertBuilderChange
      tags: [builder]
      summary: 'Undo one earlier change, keeping later work'
      description: 'Body {versionId, baseVersion?, confirmed?}: undoes `versionId` against its parent; files edited since are LEFT ALONE and returned in `conflicts`. 409 `conflict` when nothing can be reverted safely. Audited (`builder.change.reverted`). Permission `builder:write`. Flag `builder_tools.enabled`.'
      x-nuzm-permission: builder:write
      x-nuzm-org-scoped: true
      security: [{ sessionCookie: [], csrfHeader: [] }, { apiKey: [] }]
      parameters:
        - { $ref: '#/components/parameters/OrgHeader' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/BuilderRevertInput' }
      responses:
        '201': { description: 'Success', content: { application/json: { schema: { $ref: '#/components/schemas/BuilderRevertResult' } } } }
        '401': { $ref: '#/components/responses/Problem' }
        '403': { $ref: '#/components/responses/Problem' }
        '404': { $ref: '#/components/responses/Problem' }
        '409': { $ref: '#/components/responses/Problem' }
        '422': { $ref: '#/components/responses/Problem' }
```
Note: the two POST writes carry `IdempotencyKey`; the controller must then use the existing `@Idempotent()` decorator (add it when applying, as `studio-instructions.controller.ts` does).

## Proposed schemas (`components.schemas`)
```yaml
    BuilderChangePreviewInput:
      type: object
      properties:
        baseVersion: { type: [string, 'null'] }
        patches: { type: array, items: { $ref: '#/components/schemas/BuilderFilePatch' } }
        diff: { type: string }
    BuilderFilePatch:
      type: object
      required: [op, path]
      properties:
        op: { type: string, enum: [add, modify, delete, rename] }
        path: { type: string }
        content: { type: string }
        from: { type: string }
        expectedHash: { type: string }
    BuilderChangePreview:
      type: object
      required: [ok, errors, files, totals, risks, approval, baseVersion, headVersion, drift, ops]
      properties:
        ok: { type: boolean }
        errors: { type: array, items: { type: object, required: [at, code, message], properties: { at: { type: string }, code: { type: string }, message: { type: string } } } }
        files:
          type: array
          items:
            type: object
            required: [op, path, bytesBefore, bytesAfter, added, removed, diff, diffTruncated, hashBefore]
            properties:
              op: { type: string, enum: [add, modify, delete, rename] }
              path: { type: string }
              from: { type: string }
              bytesBefore: { type: integer }
              bytesAfter: { type: integer }
              added: { type: integer }
              removed: { type: integer }
              diff: { type: string }
              diffTruncated: { type: boolean }
              hashBefore: { type: [string, 'null'] }
        totals: { type: object, required: [files, added, removed], properties: { files: { type: integer }, added: { type: integer }, removed: { type: integer } } }
        risks: { type: array, items: { type: object, required: [code, message], properties: { code: { type: string }, message: { type: string } } } }
        approval: { type: object, required: [required, reasons], properties: { required: { type: boolean }, reasons: { type: array, items: { type: string } } } }
        baseVersion: { type: [string, 'null'] }
        headVersion: { type: [string, 'null'] }
        drift: { type: integer }
        ops: { type: array, items: { $ref: '#/components/schemas/BuilderFilePatch' } }
    BuilderRollbackInput:
      type: object
      required: [targetVersion]
      properties: { targetVersion: { type: string }, baseVersion: { type: string }, confirmed: { type: boolean } }
    BuilderRevertInput:
      type: object
      required: [versionId]
      properties: { versionId: { type: string }, baseVersion: { type: string }, confirmed: { type: boolean } }
    BuilderRollbackResult:
      type: object
      required: [versionId, commit, branch, diff, risks, restoredFrom]
      properties:
        versionId: { type: string }
        commit: { type: string }
        branch: { type: string }
        diff: { type: object }
        risks: { type: array, items: { type: object } }
        restoredFrom: { type: string }
    BuilderRevertResult:
      type: object
      required: [versionId, commit, branch, diff, risks, revertedVersion, conflicts]
      properties:
        versionId: { type: string }
        commit: { type: string }
        branch: { type: string }
        diff: { type: object }
        risks: { type: array, items: { type: object } }
        revertedVersion: { type: string }
        conflicts: { type: array, items: { type: string } }
```
Also: the flag `builder_tools.enabled` must be listed wherever feature flags are registered/seeded (Master's call; default off).

## Tests added
Domain `changeset.spec.ts` (19), API `change-tools.service.spec.ts` (8). Integration (real `ChangeService`, DB, git) is NOT yet written: heavy-run request in REPORT-05.

## Master answer
(pending)
