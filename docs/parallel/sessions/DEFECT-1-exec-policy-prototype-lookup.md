# DEFECT-1 — Execution Gateway policy throws on prototype-chain profile names

Reporter: Session 07 (QA) · Owner: Session 04 (Sandbox + Execution Gateway) · cc Master · Severity: **LOW-MEDIUM** (fails closed by accident, but a refusal becomes an uncaught exception) · Status: FIXED, RE-TESTED (Session 07, merged integration 4af0920c) (2026-11-24) · Found: 2026-11-24 on baseline `f81872d5`

## Where
`packages/domain/src/ai/execution-gateway/index.ts:139` (`const profile = typeof req.profile === 'string' ? EXEC_PROFILES[req.profile] : undefined;`) and `:155` (`if (profile.params.script)`).

## Reproduction (offline, pure function, no process started)
```js
import { executionGateway as gw } from '@nuzm/domain';
const ctx = { orgId: 'o', runId: 'r', enabledProfiles: [], projectScripts: [] };
gw.decideExec({ orgId: 'o', runId: 'r', profile: 'constructor', params: {} }, ctx);
// -> TypeError: Cannot read properties of undefined (reading 'script')
```
Same for `toString`, `valueOf`, `hasOwnProperty`, `__proto__` (any `Object.prototype` member name). A normal unknown name (`'nope'`) correctly returns `{ allowed:false, reasons:['unknown_profile'] }`.

## Expected
Every request the model can send is answered by a decision: `{ allowed:false, reasons:['unknown_profile'] }`. A model-supplied string must never select an inherited member.

## Actual
`EXEC_PROFILES` is a plain object literal, so `EXEC_PROFILES['constructor']` is `Object` (truthy). The profile is then "found", `enabledProfiles.includes(undefined)` is false (reason `profile_not_enabled`), and the next block dereferences `profile.params.script` on a function that has no `params`: the policy **throws**. Consequences: (a) the refusal is not recorded with its reason (callers that audit refusals by reason get an exception instead), (b) a caller that wraps the gateway in a generic handler may translate it as a 500 / retry, (c) if a future change adds a field with the same name to a prototype-reachable object the guard could flip to allow. Today nothing is ALLOWED (verified by the QA test), so this is hardening, not an escape.

## Suggested fix (Session 04 decides)
Look the profile up with an own-property check: `Object.hasOwn(EXEC_PROFILES, req.profile)` or create the catalogue with `Object.create(null)` / a `Map`. Add `'unknown_profile'` for any non-own name.

## Tests
`apps/api/src/qa/qa-exec-gateway.int.spec.ts` → `describe('DEFECT-1 …')`: five `it.fails` cases state the secure expectation and currently fail (so the suite is green while the defect exists). When fixed they start failing ("expected to fail but passed"): remove the `.fails` marker then. A companion case proves the profile is never ALLOWED today.

## Re-test result (2026-11-24, branch merged with integration/ai-engine 4af0920c)
FIXED and RE-TESTED (Session 07, merged integration 4af0920c): the 5 former `it.fails` cases are ordinary tests and pass; the "never allowed" control is now strict (no try/catch).
