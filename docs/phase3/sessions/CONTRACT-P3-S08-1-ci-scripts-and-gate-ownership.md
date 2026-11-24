# CONTRACT-P3-S08-1: root scripts, CI wiring and how the new gates are maintained

From P3-S08 to the Master. Nothing here changes behaviour until you apply it; the gates already run in `pnpm test` / `pnpm verify` without any change (they are unit tests under `apps/api/src/qa`).

## 1. Scripts (root `package.json` or `apps/api/package.json`, Master-owned)
```json
"evidence:verify":  "pnpm --filter @nuzm/api exec tsx src/qa/evidence/cli.ts verify",
"evidence:matrix":  "pnpm --filter @nuzm/api exec tsx src/qa/evidence/cli.ts matrix --write",
"qualify:p3":       "pnpm --filter @nuzm/api exec tsx src/qa/harness/cli.ts",
"validate:owner":   "docs/phase3/validate/run-all.sh"
```
`evidence:verify` is already covered inside `pnpm verify` through the unit test "the repository evidence directory"; adding it as an explicit step of `verify` is optional and only makes the failure message shorter.

## 2. Existing files renamed (my own area)
`apps/api/src/qa/qa-route-inventory.int.spec.ts` -> `qa-route-inventory.spec.ts`: it is static and never needed a database, so it now runs in `pnpm test`. Consequence for every merge: a new public route, a new organization POST without `@Idempotent()`, or a new GET route in the customer-content areas (`qa-o9-static-gate.spec.ts`) fails `pnpm test` until P3-S08 has classified it. Please run `pnpm --filter @nuzm/api exec vitest run src/qa` after each session merge; on a failure send P3-S08 the route list and I update `O9-ROUTE-CLASSIFICATION.json` and the pinned lists (sessions cannot: they are my files).

## 3. Decision needed from you
- **Native evidence formats.** P3-S01 already writes `nuzm.p3-provider-evidence` into `docs/phase3/EVIDENCE/provider/`; the verifier supports it (independent rules + derived canonical records). P3-S02 (evidence index), P3-S03 (`evidence.ts`), P3-S04 (`qa/evidence.ts`) and P3-S06 (`apk-evidence.ts`, `docs/mobile/evidence/`) have their own shapes. Until an adapter exists a foreign file under `docs/phase3/EVIDENCE/<track>/` is REJECTED (so `pnpm test` fails). Ask each session either to emit the canonical envelope (`docs/phase3/EVIDENCE/README.md`, with `seal`) or to send me the frozen format; evidence kept elsewhere (for example `docs/mobile/evidence/`) is not scanned and does not count for the matrix.
- **Java on the owner's Mac.** The checklist table says "Java present"; `java -version` answers "Unable to locate a Java Runtime" (only the macOS stub exists). The Flutter local tests need JDK 17. See `docs/security/P3-FLUTTER-LOCAL-QUIET-WINDOW.md`. Please correct `OWNER-SETUP-CHECKLIST.md` section 0 and add JDK 17 to section A.
