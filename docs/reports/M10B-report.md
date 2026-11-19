# M10 report — M10B section (S48–S50: Flutter mobile app builder)

Status: **M10B implemented as far as it can be without the human items; NOT signed.** Branch `claude/m10b-flutter-97131d` (cut from main `7d0d7b0`; no merge into main, no push). Per-sprint detail: `S48-report.md`, `S49-report.md`, `S50-report.md`; gate review (prepared, NOT SIGNED): `M10-gate-review.md`; spec change requests (BLOCKED, owner approval needed): `M10B-spec-change-requests.md`; runbook draft `docs/runbooks/mobile-signing.md`; demo guide `docs/runbooks/demo-m10b.md`.

## Owner exception (ordering waiver)
The M10 prompt says M10B may not start before the M10A gate review is signed. **On 2026-11-19 the owner waived that ordering** ("Both now, in parallel"), so M10B was built while another session (`m10a-finish`) completes M10A. The waiver changes only the order of work: it does not sign the M10A gate, does not pre-accept any M10A risk, and the M10A gate review (`M10A-gate-review.md`) is still PREPARED, NOT SIGNED. Also recorded in `M10-report.md`.

## A. Repository findings and assumptions
- Main contains the real M09 (gateway, `ai.runs`, `RunKindRegistry`, builder projects/versions/files). M10A's web-app work still runs on stand-in ports and does not touch `builder.projects.type`: the CHECK list was `('website')`. M10B therefore adds migration 1510 widening it to `('website','webapp','mobile')` (idempotent if M10A adds the same).
- **Design decision**: model output is data (structured spec), a trusted deterministic renderer writes Dart (every string escaped), the same pattern M10A used for web apps. A mobile project's Flutter source lives in `builder.project_files` versions; the version's model column holds a small manifest (`MobileProjectService`, in the builder module, which M10 may extend per the ownership manifest). Site-model operations and previews refuse mobile projects.
- M09 files touched (3 lines): `KINDS_NOW` gains `'mobile'`, `AgentTask` gains `'mobile_design'`; `ProjectService` delegates `type=mobile` and guards website-only operations; `PreviewService` refuses mobile (details in the notes folder hand-over and `M10B-spec-change-requests.md`).
- Interpretations and SCRs: `M10B-spec-change-requests.md` (revocation, owner approval/read-by-id/export, web preview, artifact download). No endpoint outside docs/04 §2.10 exists.
- **Pinned toolchain**: Flutter 3.35.7, Dart 3.9.2, template set `nuzm-flutter-core@1.0.0`.

## B. Plan and changed files
`apps/api/src/modules/mobile/**` (module, controllers, `internal/{flutter,policy,builds,signing,releases,fixtures}`), `apps/api/templates/flutter-core/**` (static Dart), `apps/api/src/modules/builder/internal/mobile-project.service.ts` (+ small guarded edits in `project.service.ts`, `preview.service.ts`, `builder.module.ts`, `index.ts`), `apps/api/src/modules/ai/internal/{run-kinds,run.service}.ts` (2 lines), migrations `mobile/1500–1502`, `builder/1510`, append-only shared files `spec/openapi/{openapi,errors}.yaml`, `apps/api/src/common/errors.ts`, `spec/db/ownership.yaml`, `spec/compliance/residency-hooks.yaml`, `apps/api/src/app.module.ts`, regenerated `packages/sdk/src/schema.ts`, web (§C), docs.

## C. Implemented features, API and UI
API (all behind `mobile_builder.enabled`, default OFF; 404 when off): `POST /v1/builder/projects {type:mobile}`; run kind `mobile`; `POST/GET /v1/mobile/builds`, `GET …/{id}`, `GET …/{id}/artifacts`; `POST/GET /v1/mobile/signing-credentials`; `POST/GET /v1/mobile/releases`. Service-level only (no route, SCR): owner approval, submission-preparation export, revocation. UI: see §C-UI below.

### C-UI (apps/web, written by a UI sub-session of this work; browser behaviour NOT VERIFIED)
Routes under `app/[locale]/(console)/mobile/`: `new` (UI-M10-12: name, languages, description -> project, session and `mobile` run, retry reuses the project and session), `[id]/preview` (UI-M10-13: the "preview is not a guarantee of device behaviour" notice, the honest "web preview not available yet" state, the screens of the manifest, link to the run for approval), `[id]/builds` (UI-M10-14: requests, 3 s polling, notices, artifact checksums without a download link, redacted log, explained 503/422 states for iOS and signing), `[id]/signing` (UI-M10-15: platform, label and `vault://` only; no key or password field; pasted key material is refused in the browser; **no revoke control**, SCR-M10B-01 stated), `[id]/releases` and `[id]/releases/new` (UI-M10-16/17: four-step wizard, "Save as draft" / "Mark as prepared", missing items named, the owner-approval step shown with the statement that it has no endpoint yet (SCR-M10B-02) and that Nuzm never submits to a store; **no submit button**). Nav item and dashboard card only when `mobile_builder.enabled`. About 220 `mobile.*` ar/en keys appended to `packages/i18n/src/messages.ts` (checked by the copy lint). Each screen has loading, empty, error and forbidden states. Known gaps: `GET /v1/mobile/releases` always returns `missing: []` (the list cannot show the missing items; only the create response does); API `notices` and `signing_unavailable` texts are English (four known notices are localized in the UI); no read-by-id for releases or credentials.


## D. Migrations and rollback
`mobile/1500` (builds, artifacts + permissions `mobile:build|signing|release|release:approve`), `1501` (signing_credential_refs), `1502` (releases), `builder/1510` (projects type CHECK). Range 1400–1599 (M10); numbers from 1500 up to leave 1400–1499 to M10A. Forward-only; each has a `.down.sql` for dev/staging only (production = forward fix; `mobile.*` may be dropped only before first data). Applied on a fresh database (own cluster, port 54356; a database that already applied main's 17xx migrations refuses 1500 because the runner is forward-only). RLS forced on all four tables; deletes and edits of evidence rows are blocked by triggers.

## E. Tests run (real results, this branch)
- `pnpm install --frozen-lockfile` OK; fresh database on port 54356: `pnpm db:migrate` OK (includes 1500-1502, 1510), `db:dev-logins`.
- `pnpm db:test-rls` PASS; `compliance:classification-coverage` PASS (2,945 columns, 232 tables); `compliance:residency-hooks`, `compliance:ropa-coverage`, `compliance:claims-guard` PASS; `spec:lint` PASS (0 warnings); `spec:drift` PASS (414 routes); `sdk:check` PASS; `scan:secrets` PASS (0 hits; test fixtures build key-like strings at run time).
- `pnpm typecheck` PASS (50 tasks); `pnpm build` PASS (27 tasks, web included); `pnpm lint`: eslint clean; prettier reports only `spec/openapi/openapi.yaml` and `packages/i18n/src/messages.ts`, both already unformatted on main (not reformatted here to avoid diff noise).
- API unit (`apps/api`): 57 files, 955 tests PASS (mobile: 38 in 4 files). Web unit: 29 files, 453 tests PASS; i18n 9 PASS.
- Mobile integration `mobile.int.spec.ts`: 20 PASS (re-run after the last change). Local Flutter evidence `flutter-local.int.spec.ts` (`MOBILE_FLUTTER_LOCAL=1`): 2 PASS (345 s).
- Full `pnpm --filter @nuzm/api test:integration`: first run 80 files, 1,796 passed, 5 failed: three were M10B's own follow-ups and are fixed (the `ai/runs` test listed `mobile` as unsupported; the generated cross-tenant matrix needed a fixture for `/v1/mobile/builds/{id}` plus a global flag, so org B's 404 is isolation; `mobile.int` failed once while its file was edited during the run and passes alone). After the fix, `cross-tenant`, `ai/runs`, `mobile.int` PASS (517 tests in the four files re-run). **One remaining failure, not touched by this work: `invoicing/zatca-queue.int.spec.ts` "exponential backoff…" (expected `reported`, got `queued`; date-based; no invoicing file differs from main). Not verified on main: recorded as FAIL / open.** The complete suite was NOT re-run after the fixes.
- Browser E2E (`pnpm test:e2e`, `e2e/tests/10b-mobile.spec.ts`): **NOT RUN** (ports 3000/3001/4000/4010/54329 belong to the owner's running app). No screenshots, no axe.
- Not run: `pnpm verify:full`; load/chaos.

## F. Security, tenant isolation, billing, residency
- **Tenant isolation**: RLS forced; org-B 404 on project, build, artifacts, list, signing, releases (`mobile.int.spec.ts`); `db:test-rls` PASS.
- **Secrets**: signing references only (closed body, key-like values 422 `raw_secret_rejected`, never echoed); build process gets an allow-listed environment only; logs are line-redacted; AC-M10-13 scan test with planted canaries: 0 hits.
- **Untrusted code**: the control plane never executes project code; the only execution is the LOCAL dev runner (a child process on the API host: UNSIGNED, NOT ISOLATED, labelled in every build record; refused in production). **No isolation evidence is claimed.**
- **Supply chain**: pub allow-list, lockfile gate before compiling, typosquat check, package cap, advisory hook (no live feed).
- **Billing**: `mobile.build_minutes` metered once per build (deterministic event id, dimension `platform`, same transaction as the result); no payment work.
- **Residency**: hook `m10-mobile-artifacts` (artifact write evaluated before storage), tables listed, `data_region` on every table; `residency-hooks`, `ropa-coverage`, classification coverage PASS.
- **Audit**: `mobile.build.requested|finished`, `signing.credential.authorized`, `mobile.release.created`, `release.owner.approved`. `signing.credential.used` is NOT emitted (no signing stage).
- **Feature flag** `mobile_builder.enabled` default OFF.

## G. Human gates and live checks still needed
HG-10-01 (Apple Developer / Google Play accounts, owner-authorized signing material, macOS capacity), D-22 (macOS capacity), D-21 (sandbox technology for isolated Android builds), HG-10-02 (security review: the build worker is part of the sandbox-class scope), HG-09-01/D-18 (model quality), D-34 (retention), the legal assessment of in-app-purchase / external-checkout policies (AC-M10-17; no HG id yet: add one before S50), SCR-M10B-01..04, a CI runner for AC-M10-10, native-speaker review of the Arabic copy, a live advisory feed and scanning pub mirror.

## H. Acceptance checklist
| ID | Status | Evidence |
|---|---|---|
| AC-M10-10 Android debug builds in CI | NOT VERIFIED | built locally (`S49-report.md`): analyze 0 issues, test passed, APK 151,721,417 B; not CI |
| AC-M10-11 Android release signed + verified | BLOCKED (HG-10-01) | 422/503 honest answers; no signing material or stage |
| AC-M10-12 iOS built and signed | BLOCKED (D-22, HG-10-01) | 503 `no_macos_capacity` |
| AC-M10-13 no signing material in logs/artifacts/sandboxes | PASS (implemented surface); real signing stage NOT VERIFIED | `mobile.int.spec.ts` scan |
| AC-M10-14 copy lint | PASS | `copy-lint.spec.ts` |
| AC-M10-15 screens AR+EN, 4 states, axe | NOT VERIFIED | Playwright NOT RUN; no screenshots/axe |
| AC-M10-16 dependency policy | PASS (feed NOT VERIFIED) | `pub-policy.spec.ts`, `mobile.int.spec.ts` |
| AC-M10-17 IAP/external-checkout assessment | BLOCKED (legal) | none |
| AC-M10-08 cross-tenant (mobile endpoints) | PASS | `mobile.int.spec.ts` |
| AC-M10-09 metering dedupe (`mobile.build_minutes`) | PASS (local/mock numbers) | parallel-claim test: one event; minutes billed = metered quantity |
| S48.4 web preview | NOT IMPLEMENTED (SCR-M10B-03) | 422 `unsupported_capability` |

## I. Next-milestone handoff and open decisions
M11/M12: workflows may call `/v1/ai/runs kind=mobile`; the build worker joins the M12 sandbox pen-test scope once D-21 is decided; store-release rows go to the GA checklist as BLOCKED. Open: HG-10-01, D-21, D-22, D-34, SCR-M10B-01..04, legal HG for AC-M10-17, owner signature of this gate and of the M10A gate. Integration notes for the integrator (conflicts with `m10a-finish`): see the hand-over note in the session notes folder (`KINDS_NOW`, `AgentTask`, migration 1510, builder module, shared spec blocks).
