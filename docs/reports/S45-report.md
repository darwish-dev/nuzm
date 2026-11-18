# S45 — Sandbox runner (M10A)

Status words per CLAUDE.md §6. Branch `claude/m10a-app-builder-7cee56`.

## Implemented
`sandbox/runtime.ts` (port), `mock-runtime.ts`, `local-dev-runtime.ts` (NOT isolated, refuses production), `egress.ts` (default deny, every IP spelling, metadata, DNS pinning, redirects, approvals), `canary.ts`, `sandbox.service.ts` (quota serialised per org, residency before placement, 402/503, reaper, `ai.sandbox_cpu_seconds`, tickets), `escape-suite.ts` (≥ 60 attempts), migration 1420; review pack + threat model + D-21 comparison + runbook.

## Tests (files; results in `M10-report.md` §E)
`egress.spec.ts` (68), `sandbox.int.spec.ts` (16: 20 parallel creates admit exactly 5, reaping, canary redaction, metering reconciliation, tickets, cross-tenant, escape suite 0 escapes, local-dev runner).

## Not done / NOT VERIFIED / BLOCKED
D-21 and HG-10-02 BLOCKED/UNREVIEWED. All isolating-runtime attempts NOT VERIFIED; `isolationEvidence` is false by construction. Terminal WebSocket + ticket route not built (PA-M10-01).

Feature flag `app_builder.enabled` default OFF. Assumptions: `M10-m09-interface-assumptions.md`.
