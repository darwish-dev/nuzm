# S44 — Frontend agents, scaffold assembly, evaluation harness (M10A)

Status words per CLAUDE.md §6. Branch `claude/m10a-app-builder-7cee56`.

## Implemented
Metadata-driven runtime (`apps/api/templates/webapp-runtime`: http, store, memory/pg stores, auth (scrypt, signed tokens), CSV with formula-injection guard, audit trail with PII redaction, RTL/EN single-page UI); `agents/webapp-agents.ts`; `eval/evaluation.ts` + migration 1410 (`ai.evaluations`, rows carry `mock_model`).

## Tests (files; results in `M10-report.md` §E)
`webapp-pipeline.int.spec.ts` (real agents on the CRM fixture, semantic repair, destructive-migration approval parks the run, generated CRM type-checks and passes its tests).

## Not done / NOT VERIFIED / BLOCKED
`spec/reference/crm-spec.md` is a DRAFT (owner freezes; no sha256 file). The CRM spec used in tests is a development fixture, not the frozen spec. Evaluation scores are structural, mock-labelled.

Feature flag `app_builder.enabled` default OFF. Assumptions: `M10-m09-interface-assumptions.md`.
