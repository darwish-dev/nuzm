# DEFECT-12 — `decideTarget` reads inherited object names as a product type and throws

Reporter: Session 07 (QA) · Owner: Session 06 (`apps/api/src/modules/deploy/internal/targets.ts` `decideTarget`) · cc Master · Severity: **LOW** (latent: the product type comes from a closed builder enum today; fails closed) · Status: FIXED, RE-TESTED (2026-11-24, feature/ai-deployment 03380df9 merged into feature/ai-qa-security)

Same class as DEFECT-1 (exec profiles). `TARGET_BY_PRODUCT_TYPE[productType]` is a plain object lookup, so `__proto__`, `constructor`, `toString`, `hasOwnProperty` return inherited members; `readiness` is undefined and the denial message calls `r.blockers.join` → `TypeError`. Expected: `null` (unknown type, refused). Fix: `Object.prototype.hasOwnProperty.call(TARGET_BY_PRODUCT_TYPE, t)` (as `decideExec` now does) or a `Map`.
Test: `qa-deploy-targets.int.spec.ts` → `it.fails('DEFECT-12 …')` + `CONFIRMED TODAY` control (delete with the fix).

## Re-test result
FIXED and RE-TESTED: `decideTarget` answers null for `__proto__`, `constructor`, `toString`, `hasOwnProperty`, `valueOf` (`qa-deploy-targets.int.spec.ts`, ordinary test; CONFIRMED TODAY control deleted).
