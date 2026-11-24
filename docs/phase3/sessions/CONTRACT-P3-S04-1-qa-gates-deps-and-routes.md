# CONTRACT-P3-S04-1 — website QA gates: dependencies, scripts, routes, E2E hook-up

From: P3-S04 (Website Generation and Live Preview). To: the Master. Everything below is outside S04's ownership (root `package.json`, lockfile, `spec/**`, SDK, `scripts/**`, `e2e/**`, `packages/domain` exports); S04's own files already work without it, with the degradations named in each item.

## 1. Dependencies (root/`apps/api/package.json` + lockfile)
`apps/api` `devDependencies`: `axe-core@4.14.0` and `jsdom@27.4.0`. Both are ALREADY in the lockfile (transitive of `@axe-core/playwright` and `vitest`), so the lockfile change is two importer entries, no new resolution.
- Why: the `a11y-axe` gate (`apps/api/src/modules/builder/internal/qa/axe.ts`) runs axe-core on jsdom, WCAG 2.1 A/AA, both languages. It resolves both with `require` at call time.
- Without it: the gate reports `skipped` (never `pass`), the run is `passed` but `qualified: false`, and the CLI exits 3. In this worktree S04 symlinked the two packages into the untracked `apps/api/node_modules` to run the gate for real; that is not a repository change.
- Production note: dev-only is intended. A deployed API never runs axe in a request; the QA runs from the CLI / CI / the repair loop (P3-S03 calls `runWebsiteQa` with `axe: 'auto'`).

## 2. Root scripts (`package.json`) — wrappers over S04 CLIs (all offline, read files only)
```
"qa:website":       "pnpm --filter @nuzm/api exec tsx src/modules/builder/internal/qa/website-qa.cli.ts"
"qa:build-site":    "pnpm --filter @nuzm/api exec tsx src/modules/builder/internal/qa/build-site.cli.ts"
"preview:domain":   "pnpm --filter @nuzm/api exec tsx src/modules/builder/internal/preview-domain.cli.ts"
```
Usage: `pnpm qa:build-site retail /tmp/out --base-url https://example.test --forms-base https://api.example.test/p/<project-uuid>` then `pnpm qa:website /tmp/out/site --min-pages 5 --require-slugs home,contact`. Exit codes: 0 every gate ran and passed, 1 a gate failed, 2 usage, 3 passed with a gate skipped.

## 3. OpenAPI / SDK (spec first, then S04 adds the controller methods)
S04 implemented the service (`VersionArtifactService`, exported from the builder index and provided/exported by `BuilderModule`) and deliberately did NOT add controller routes (they need spec + SDK first). Requested routes, all under `/v1/builder/projects/{projectId}`, `website` projects only, `viewer`+ read, org-scoped (RLS), no side effects:
| Route | Returns | Service call |
|---|---|---|
| `GET /versions/{versionId}/artifact` | `{versionId, manifest:{schema, rootHash, files:[{path,sha256,size,mime}], totalBytes, provenance}}` | `manifest()` |
| `POST /versions/{versionId}/qa` (body `{mode?:'preview'\|'publish', minPages?, requiredSlugs?}`) | `QaReport` (`schema nuzm.website-qa/1`) — `axe` stays `off` in a request (CPU), the full run is CLI/CI | `qa()` |
| `GET /versions/{from}/comparison/{to}` | `EditDiffStats` (verdict none/minimal/moderate/rewrite) | `compare()` |
Error codes from the registry only (`not_found`, `unsupported_capability`). No new tables, no migration (S04 uses none of 2330–2339 so far).

## 4. `packages/domain` (optional, small)
Export `tokenize`/`attrOf` from `packages/domain/src/builder/render/html-scan.ts` through the render index. S04 duplicated a small lenient HTML reader (`internal/qa/html.ts`) instead of waiting; once exported, the duplicate can be deleted.

## 5. Browser E2E for W2 (P3-S08 owns `e2e/tests/p3-*.spec.ts`)
S04 cannot place files under `e2e/`. Needed from S08/Master, ar + en: create a preview of a template project, open it in the console iframe and assert (a) the framed page renders styled, (b) `<token>.<previewDomain>` with a flipped token character, the console host, a cookie-bearing request, an expired and a revoked token each answer the uniform 404, (c) no `Set-Cookie`/CORS header. The deterministic decision table those browser checks sit on is `builder/preview-tamper.spec.ts` (unit) and `builder/p3-s04.int.spec.ts` (DB).

## 6. Evidence schema
S04 emits website QA reports as `nuzm.website-qa/1` JSON (bound to the artifact `rootHash`). For T1 part 1 the evidence record should embed that report next to model id, tokens, cost and files. S08's schema should accept it as `qa` verbatim.
