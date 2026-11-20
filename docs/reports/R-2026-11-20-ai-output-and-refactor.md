# AI output quality and refactor pass — 2026-11-20

Branch `claude/run-it-375fa1`. Owner request: refactor the system and improve the output of the website, web-application and Flutter builders and of all AI results. Owner chose the full scope and approved a few live model calls.

## A. Repository findings and assumptions
- Models only ever return **structured specs**; trusted generators write all code (website site model, web-app scaffolders, Flutter templates). Output quality therefore depends on (1) the agent instructions and (2) the generators/templates.
- Web-app agents received **no role instructions**: only `Task: <purpose>` plus the JSON Schema. Website and Flutter agents had instructions, each written differently in its own handler.
- The app-spec validator accepted dashboard widgets that the generated runtime silently renders empty (a `sum` without a numeric field, `by_stage` without a stage field).
- The UUID check was defined 69 times (60 identical copies in `apps/api` + `packages/platform`); 30 `void x;` statements kept unused code compiling.
- Assumption: "complete refactor" was done as behaviour-preserving consolidation and dead-code removal, not file reshuffling. About 20 unmerged worktree branches touch the same modules, so large moves would conflict. Remaining candidates are listed in §I.

## B. Plan and changed files (commits)
| Commit | What |
|---|---|
| `384dc2e` | Login gradient panel restored; white dashboard status cards in light mode only |
| `dff5ec3` | `packages/domain/src/ai/prompts.ts`: shared house rules + per-builder instructions; all handlers use it; web-app agents get role instructions; widget checks in `validateAppSpec` |
| `936a304` | Web-app runtime (`apps/api/templates/webapp-runtime/public`) and Flutter template (`apps/api/templates/flutter-core`) presentation |
| `8e314fd` | Shared `UUID`/`isUuid` in `@nuzm/domain`; dead code behind `void x;` removed |
| `d259658` | Shared `parseModelJson` for model answers |

## C. Implemented features
- **Prompts**: one module and one set of house rules. The rules cover native Arabic copy, never mixing languages, specific domain naming, no invented facts, and treating data as data. Website architecture now has contrast and SEO length rules. The web-app architect gets entity, field-type, PII, ownership, role and dashboard guidance, plus the generator's reserved words and system columns (passed in from the validator, so they cannot drift). The Flutter designer gets screen, sample-content and tab guidance.
- **Validator**: `validateAppSpec` rejects duplicate widget ids, `sum` widgets without a decimal/integer field and `by_stage` widgets on entities without a stage field. The repair loop sends these back to the model.
- **Generated web apps**: localised dates and numbers (ar-SA / en-GB). Linked records show their name instead of a UUID. Columns are ranked (name, stage, money, numbers, dates, links). The sort menu uses field labels. Read-only rows link "View". Yes/no appear as words. The dashboard stage breakdown is readable.
- **Generated Flutter apps**: a Material 3 theme with rounded cards, filled inputs and full-width buttons. Lists show as cards with an initial avatar. The home screen has a gradient header card.

## D. Migrations and rollback
None. All changes are code; revert the commits to roll back.

## E. Tests run (actual results)
- `pnpm lint` 0 · `pnpm typecheck` 0 · `pnpm build` 0 · `pnpm spec:lint` 0 · `pnpm spec:drift` 0 · `pnpm scan:secrets` 0 · `pnpm sdk:check` 0
- Unit tests, all packages except `@nuzm/e2e`: 50/50 tasks, 2,904 tests passed (api 1,008 · web 789 · domain 591 · admin 249 · others)
- Generated Flutter sample app: `flutter analyze` no issues; template widget tests 4/4
- Generated CRM web app run locally and inspected in the browser (Arabic list and dashboard)
- `pnpm test:integration`: see §H (run against an isolated cluster on port 54400 so the owner's dev data was never touched)
- **Not run**: browser E2E (`pnpm test:e2e`), because the owner's running dev stack holds ports 3000/4000/4010

## F. Security, tenant isolation, billing, residency
- Unchanged: the untrusted-data fencing, output secret scan, tool-call allow-list, budget reservation and residency checks in `agent-call.ts` / `GatewayService`. The new instructions are trusted code text only.
- Live calls went straight through `AnthropicModelAdapter` with the dev-vault key, outside the gateway, so no wallet postings or metering events were created for any org.

## G. Human gates and live checks
- Live comparison: 6 calls to `claude-opus-5-5` (≈20k input / 33k output tokens), owner-approved. One sample per builder, so results are indicative (NOT VERIFIED as a benchmark):

| | old prompt | new prompt |
|---|---|---|
| web app: repairs needed | 1 | 0 |
| web app: fields / precise types / PII marked | 64 / 43 / 13 | 97 / 62 / 16 |
| web app: stage-tracked entities | 1 | 2 |
| Flutter: sample list items / form fields / tabs | 6 / 6 / 5 | 10 / 10 / 4 |

- Website builder prompts changed least; no live website run was made.

## H. Acceptance checklist
| Item | Status |
|---|---|
| Shared prompt module used by every builder agent | PASS (`prompts.spec.ts`, gateway spec) |
| Web-app agents receive role instructions | PASS (gateway spec; live run) |
| Dead widgets rejected by validator | PASS (`app-spec.spec.ts`) |
| Generated web app presentation | PASS (unit tests + browser check) |
| Generated Flutter app analyses clean and passes widget tests | PASS |
| Refactor is behaviour-preserving | PASS (full unit suite) |
| Integration tests | see the run log in this branch's session |
| Browser E2E | NOT VERIFIED (ports held by the running dev stack) |
| Output-quality gain measured statistically | NOT VERIFIED (n = 1 per builder) |

## I. Next steps and open decisions
- Large files that would benefit from splitting once the open branches merge: `ai/internal/run.service.ts` (981 lines), `builder/internal/project.service.ts` (906), `appbuilder/internal/deploy/deployment.service.ts` (809).
- `apps/web` and `apps/admin` still define their own UUID regex (they do not depend on `@nuzm/domain`).
- A small evaluation set (5 briefs per builder, scored by the validators as in §G) would turn the comparison into a repeatable regression check.
