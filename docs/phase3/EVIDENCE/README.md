# Phase 3 evidence (owner: P3-S08)

One JSON file per real or simulated run, at `docs/phase3/EVIDENCE/<track>/<YYYY-MM-DD>-<id>.json`. `<track>` is one of `provider`, `tool-calling`, `codegen`, `runtime`, `build-repair`, `preview`, `deploy`, `benchmark`, `mobile`, `website`, `fullstack`, `security`. The file name's date is the date part of `recordedAt` and `<id>` equals the record's `id`.

## For sessions that write evidence
1. Produce the record in the envelope `nuzm.p3-evidence/1` ([schemas/envelope.schema.json](schemas/envelope.schema.json)); the track-specific part goes in `details` ([schemas/track-*.schema.json](schemas/)). Native records you already have (`nuzm.live-evidence`, `nuzm.benchmark-evidence/1`, `nuzm.staging-evidence/1`, `nuzm.runtime-attestation/1`) are not replaced: hash the native file, list it in `outputs`, and fill `details` from it.
2. Seal it: `pnpm --filter @nuzm/api exec tsx src/qa/evidence/cli.ts seal record.json > sealed.json` (sets `contentHash`, the sha256 of the canonical JSON without `contentHash`). Or import `seal` from `apps/api/src/qa/evidence/verify.ts`.
3. Verify it: `pnpm --filter @nuzm/api exec tsx src/qa/evidence/cli.ts verify path/to/record.json`. Fix every reported rule. Never edit a sealed record by hand: re-seal.
4. Commit it only when the verifier accepts it.

## Labels (CLAUDE.md section 6 and the Phase 3 plan section 2)
- `LIVE-VERIFIED`: a real component ran (named model, node, host or device), under approvals you name (`approvals[]`: the id, the owner's reference as recorded in `docs/parallel/OWNER-APPROVAL-PACK.md` section 6, where it is recorded). Result `PASS`; every check `PASS` and labelled `LIVE-VERIFIED`; every component `origin: real`; a positive duration; at least one output hash; cost within its hard maximum; no blockers.
- `SIMULATED`: a mock, twin, scripted model, in-memory port or reference oracle was involved. It is valid evidence of the pipeline only and never reaches a real column.
- `NOT VERIFIED`: implemented, live validation missing; carries `blockers`.
- **Mixed labels are rejected**: a record that contains both a SIMULATED marker (`simulated: true`, `label`/`origin`/`mode` = mock, twin, simulated, scripted...) and a LIVE-VERIFIED marker anywhere is rejected, whatever its top label says. A real run that also used a mock for one step is two records or a NOT VERIFIED one.
- A real run that failed is recorded with result `FAIL` (label `LIVE-VERIFIED`) only when everything else about the run was real; the matrix shows FAIL for the row. Otherwise `NOT VERIFIED` with the blockers.

## What never goes in a record
Secrets, key shapes, vault references, prompts, model outputs, file contents, customer data, e-mail addresses other than reserved example ones. The verifier runs the repository secret scanner over the whole record and refuses on any finding.

## The verifier and the matrix
```
pnpm --filter @nuzm/api exec tsx src/qa/evidence/cli.ts verify            # all files; exit 1 on any rejection
pnpm --filter @nuzm/api exec tsx src/qa/evidence/cli.ts matrix --write    # ACCEPTANCE-MATRIX.md / .json
```
The repository check runs inside `pnpm test` (unit test `apps/api/src/qa/evidence/verify.spec.ts`, "the repository evidence directory"), so `pnpm verify` fails on a rejected committed record. [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md) is generated; it is never edited by hand. Its rows (T1..T6 and the cross-cutting gates) are defined in `apps/api/src/qa/evidence/matrix.ts`; its blockers are the owner approvals not yet recorded plus the external facts listed there.

Directories starting with `_` (for example `_fixtures/`) and `schemas/` are never scanned.
