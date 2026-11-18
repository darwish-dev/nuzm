# M09 stand-in routes (DELETE ON INTEGRATION)

`stubs.controller.ts` implements the M09-owned paths that the M10A screens and tests need before M09 is on main: `POST/GET /v1/builder/projects`, `GET /v1/builder/projects/{id}`,
`GET …/files`, `GET …/files/content`, `POST/GET /v1/ai/runs…`, `GET /v1/ai/budgets`. They sit on the in-memory M09 ports, are served only when the flag
`app_builder.m09_stubs` is on, and answer 404 in production. When M09 lands, delete this directory, remove `M09StubsController` from `appbuilder.module.ts`, keep the
paths of M09 in `spec/openapi/openapi.yaml` (they are marked `x-nuzm-m09-stub: true` here) and wire `M09_PORT_PROVIDERS` to the real services (docs/reports/M10-m09-interface-assumptions.md).
