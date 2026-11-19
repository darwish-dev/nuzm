# M10 gate review (S50) — PREPARED, NOT SIGNED

Gate (M10 prompt): **M10 Gate (S50): M10B acceptance rows PASS or explicitly BLOCKED (HG-10-01 / D-22) per this gate review.** The M10A gate (independent CRM suite, escape suite) is a separate review: `M10A-gate-review.md` (NOT SIGNED, and the M10A work is still being finished by another session).

**Owner exception (recorded):** the M10 prompt says M10B may not start before the M10A gate review is signed. On **2026-11-19 the owner waived that ordering** ("Both now, in parallel") for the M10B implementation. The waiver changes only the order of work. It does **not** sign or pre-approve the M10A gate; this review does not claim M10A passed. Recorded in `M10-report.md` and `M10B-report.md`.

| M10B acceptance row | Status | Evidence / reason |
|---|---|---|
| AC-M10-10 Android debug artifact builds from the generated Flutter template, **in CI** | **NOT VERIFIED** (built locally; no CI) | Local only: `flutter analyze` (0 issues), `flutter test` (4 passed), `flutter build apk --debug` OK, 151,721,417-byte APK, sha256 in `S49-report.md`. A local build is not CI evidence; the local runner is UNSIGNED and NOT ISOLATED |
| AC-M10-11 Android **release** artifact signed with owner-authorized credentials, signature verified | **BLOCKED (HG-10-01)** | no signing material, no vault, no signing stage; API answers 422 `signing_not_authorized` / 503 `signing_unavailable` |
| AC-M10-12 iOS artifact built and signed on macOS capacity | **BLOCKED (D-22, HG-10-01)** | no macOS capacity; API answers 503 `no_macos_capacity`; nothing simulates a success |
| AC-M10-13 signing material absent from logs, artifacts, sandboxes (scan 0 hits) | **PASS for the implemented surface** (NOT VERIFIED for a real signing stage) | `mobile.int.spec.ts`: log line redaction, minimal build environment, scan of audit events and stored artifacts with planted canaries: 0 hits. A real signing stage does not exist, so the material-in-worker path is NOT VERIFIED |
| AC-M10-14 copy lint: 0 UI/doc strings promising store approval or review bypass | **PASS** | `copy-lint.spec.ts` over the Flutter templates, the `mobile.` console messages and the M10B documents; rules in `copy-lint.ts` (EN + AR) |
| AC-M10-15 all §8 screens AR-RTL + EN screenshots, 4 states, axe | **NOT VERIFIED** | UI-M10-12..17 implemented (see `M10B-report.md` §C); Playwright spec written, **NOT RUN**; no screenshots, no axe run (ports of the owner's running app in use) |
| AC-M10-16 no generated-app dependency outside the allow-list / with a high advisory reaches deploy | **PASS for the pub ecosystem gate** (advisory feed NOT VERIFIED) | `pub-policy.spec.ts`, `mobile.int.spec.ts` (build blocked on a git-sourced lockfile). No live advisory feed, no scanning mirror connected |
| AC-M10-17 written assessment of Apple/Google in-app-purchase and external-checkout policies | **BLOCKED (legal; HG to be added before S50)** | no document, no legal sign-off. The template has no checkout flow; the release checklist item `compliance.iapPolicy` requires `not_applicable` or an assessment reference |
| AC-M10-08 (mobile endpoints) cross-tenant 404 | PASS | `mobile.int.spec.ts` |
| FR-APP-09 Flutter generation | PASS (scripted model; quality NOT VERIFIED) | run kind `mobile`, approval, template renderer, analysis gate |
| FR-APP-10 signed builds / release preparation | PARTIAL: release preparation PASS; signed builds BLOCKED | see rows 11/12 |

Other M10B facts the reviewer should know
- S48.4 web preview through `/previews`: **not implemented** (422 `unsupported_capability`, SCR-M10B-03). The "preview ≠ device guarantee" statement is shown in the console and the generated README.
- Android builds "in sandbox-class isolation" (S49.1): **BLOCKED (D-21)**. The local dev runner is labelled non-isolated in every build record.
- Artifact retention sweeper (D-34 proposal) not built; the dates are recorded. Artifact bytes live in a dev directory (production: no store; M08 bucket not connected).
- The owner-approval step of a release record, revocation of a credential and artifact download have **no HTTP path** until the SCRs of `M10B-spec-change-requests.md` are approved.
- Model quality NOT VERIFIED (scripted adapter; HG-09-01 / D-18).

Sections A–I of CLAUDE.md §10: `M10B-report.md`. Owner signature: ______  Date: ______
