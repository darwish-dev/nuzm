# CONTRACT P3-S09-2 — wiring of the version store (module, ChangeService, harness)

Requester: P3-S09 · Contracts: `apps/api/src/modules/appbuilder/appbuilder.module.ts` (Master registers), `internal/changes/change.service.ts` and `internal/testing/build-harness.ts` (P3-S03 owns these files) · Additive: yes (default behaviour in development and tests is unchanged) · Status: PENDING

The new code lives in `internal/versionstore/` (barrel `index.ts`). Nothing there is registered yet, so a production boot still has no version store until these lines land. They are deliberately tiny.

## 1. `ChangeService` (P3-S03): depend on the port, not on the class
`internal/changes/change.service.ts`
```ts
- import { GitError, GitStore, type CommitInfo } from '../git/git.store';
+ import { GitError } from '../git/git.store';
+ import type { CommitInfo, VersionStore } from '../versionstore';
...
-   private readonly git: GitStore,
+   private readonly git: VersionStore,
```
`VersionStoreError extends GitError`, so the two `instanceof GitError` checks (lines ~375 and ~417) keep working unchanged. `GitStore` already satisfies `VersionStore` structurally (a compile-time check is in `versionstore/oracle.spec.ts`). Optional, recommended: pass `{ actorUserId: actor, traceId }` in the two `this.git.commit(...)` options and `this.git.tag(...)` is unchanged (the audit of the existing `builder.change.applied` event stays as is; the store records its own `builder.version.*` events).

`internal/testing/build-harness.ts`: `git: GitStore` field may stay (`GitStore.temp()`); it is passed to `ChangeService` as a `VersionStore`. No change needed.

## 2. `appbuilder.module.ts` (Master)
Replace the `GitStore` provider (lines ~515–518) and the `ChangeService` provider (~560–570):
```ts
import { makeVersionStore, VERSION_STORE, type VersionStore } from './internal/versionstore';
...
    {
      provide: VERSION_STORE,
      useFactory: (db: Db, a: AuditSink, res: ResidencyService) =>
        makeVersionStore({ env: process.env, db, audit: a, residency: res }),
      inject: [DB, AuditSink, ResidencyService],
    },
...
    {
      provide: ChangeService,
      useFactory: (db: Db, a: AuditSink, p: ProjectsPort, g: VersionStore, c: CanaryRegistry, adv: AdvisoryDbPort) =>
        new ChangeService(db, a, p, g, c, adv),
      inject: [DB, AuditSink, ProjectsPort, VERSION_STORE, CanaryRegistry, AdvisoryDbPort],
    },
```
and drop `import { GitStore } from './internal/git/git.store'` plus the now-unused `join`/`tmpdir` imports if nothing else uses them. `ResidencyService` is already injected into several providers of this module (lines 345–377), it is a `ResidencyEvaluator`.

Behaviour by configuration (`APPBUILDER_VERSION_STORE`, see `versionstore/select-version-store.ts`):
| | unset | `git` | `pg` | `memory` |
|---|---|---|---|---|
| `NODE_ENV=production` | **pg** | boot **refused** | ok | boot **refused** |
| otherwise | `git` (today) | ok | ok | ok |

`APPBUILDER_GIT_ROOT` keeps its meaning for `git`. Production additionally requires the audit sink and the residency evaluator (throws at boot otherwise).

## 3. Export
`internal/versionstore/index.ts` is the module's public entry; add to `apps/api/src/modules/appbuilder/index.ts` only if another module needs it (none does now).

## 4. Feature flag / HTTP
No HTTP route and no flag is added: the store has no caller beyond `ChangeService`, which is already behind the builder flags. SCR-M10-01 (Git routes) remains owner-gated.

## 5. Tests that prove the wiring
`select-version-store.spec.ts` (production refuses `git`/`memory`; unset production = `pg`; missing residency/audit/db fail closed), `pg-version-store.int.spec.ts`, and the existing `builder-s46.int.spec.ts` / `change-tools.int.spec.ts` once the Master has applied section 1 (they use the harness with `GitStore`, unchanged).
