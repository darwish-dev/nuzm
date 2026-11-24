# CONTRACT-P3-S02-4 — application wiring (request to the Master; app.module / registration batch)

Status: REQUEST. Everything below is default off. P3-S02 does not edit `app.module.ts`, `appbuilder.module.ts` registration or flags.

1. **Host-exec audit sink** (once, at module init, e.g. in the AppBuilder module's `onModuleInit`):
   ```ts
   import { executionGateway as eg } from '@nuzm/domain';
   eg.setHostExecAuditor((d) => audit.record({ action: d.allowed ? 'host_exec.allowed' : 'host_exec.refused', detail: { path: d.path, reasons: d.reasons, templateId: d.templateId } })); // content-free; never throw
   ```
   Until installed, decisions are enforced but not audited.
2. **Placement residency** (where the real service is started, `startRealExecution`'s `RealRuntimeConfig`; not yet exposed by `startRealExecution`: add `residency` to `RealExecutionConfig`/deps when you wire it, or build the service with `RealRuntimeService.start` directly):
   ```ts
   residency: { enforce: await flagOn(db, 'execution.residency_enforce'), syntheticOnly: cfg.syntheticOnly /* platform config only */,
     evaluate: async ({ orgId, dataRegion, nodeRegion }) => { const d = await residency.evaluate({ orgId, purpose: 'execution.placement', targetRegion: nodeRegion, dataRegion }); return { allowed: d.allowed, reason: d.reason }; } }
   ```
   and per run `RunInputs.dataRegion` = the project's `data_region` from the project record; per node `RealRuntimeNode.region` = `execution.runtime_nodes.data_region` (`PgExecutionStore.listNodes()` returns it). Flag `execution.residency_enforce`: new feature flag, default off. The exact `ResidencyPolicyService` call shape above is a sketch: use the sandbox service's existing call (`sandbox.service.ts`, `targetRegion: this.cfg.nodeRegion`) as the model.
3. **Environment**: `NUZM_LOCAL_DEV_EXEC=1` is now required for every host process path (local-dev sandbox, live preview, local Android build, git.store); it must be absent in production. `GitStore.temp()` (test helper) sets it for suites that use a throw-away store.
4. **Not wiring but a consequence**: in production `git.store` now refuses (NODE_ENV=production): a production deployment of the builder needs a non-host version store (it was never supposed to run git on the API host in production).
