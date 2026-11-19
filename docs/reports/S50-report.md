# S50 — Release preparation (M10B)

Status words per CLAUDE.md §6. Branch `claude/m10b-flutter-97131d`.

## Implemented
- `POST/GET /v1/mobile/releases` (`ReleaseService`): a record of version name/code, store (`google_play|app_store`), build ref, listing metadata, and the checklist: **privacy-policy https URL, permission declarations (must equal the app's declared permissions, each with a justification), screenshots (reference + sha256, ≥2 per project locale), compliance items (data safety, age rating, content rights, export compliance, in-app-purchase policy `not_applicable` or an assessment reference)**. `draft` keeps what is entered and returns `missing`; `prepared` needs everything **and a signed, succeeded build of the right platform** (422 `release_checklist_incomplete` naming each item). Duplicate store + version code → 409.
- **Owner approval**: `ReleaseService.ownerApprove` — owner role only, bound to `scopeHash` (a hash of the exact content), stale hash 409, idempotent, the approved row is immutable by DB trigger, audit `release.owner.approved`. **No HTTP route**: it needs a path docs/04 does not have (SCR-M10B-02); reachable in tests only.
- **Submission preparation export**: `ReleaseService.submissionExport` refuses before owner approval (409 `owner_approval_required`) and only assembles the manifest a human would use. **There is no store-submission action anywhere in the code, the API or the UI**; the test asserts no submission/approval route answers.
- **Copy lint** (`copy-lint.ts`, EN + AR rules): applied to every free-text member of a release record (422) and, in `copy-lint.spec.ts`, to the Flutter templates, the `mobile.` console messages and the M10B documents. Every record returns `notices`: Nuzm does not submit to any store and cannot predict a store review.

## Tests
`mobile.int.spec.ts` S50 block: draft with missing items, debug build never preparable, per-item 422, copy promise 422 (EN + AR), store/platform mismatch, unknown members, prepared record with a **FIXTURE signed build** (a row inserted by the test: no signing stage exists, labelled in the spec), non-owner 403, stale hash 409, approval idempotent, immutability and no-delete by DB, export refused before approval, no store route, cross-tenant and viewer checks. `copy-lint.spec.ts`: forbidden and allowed phrase cases (EN + AR) and the corpus scan.

## NOT VERIFIED / BLOCKED
- A real `prepared` record needs a signed build: **BLOCKED (HG-10-01)**. The owner-approval route and read-by-id: **BLOCKED (SCR-M10B-02)**. AC-M10-17 (IAP/external-checkout assessment): **BLOCKED (legal)**. Screenshots are references with a sha256: the images are not stored or inspected (NOT VERIFIED).
- Store submission is a human gate and is not implemented. Nothing here predicts a store review outcome.
