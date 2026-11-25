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
5. **Durable journal and kill switch** (new flag `execution.durable_store`, default OFF; code in `apps/api/src/modules/execution/durable-journal.ts`, domain port `packages/domain/src/ai/execution-gateway/journal.ts`). Where the orchestrator is constructed (nothing constructs it in the application yet):
   ```ts
   import { executionGateway as eg } from '@nuzm/domain';
   import { PgExecutionJournal, PgExecutionStore, durableExecutionEnabled } from '../execution';   // module public index
   const durable = durableExecutionEnabled(await flagValue(db, 'execution.durable_store'));         // exactly `true`, else off
   const journal = durable ? new PgExecutionJournal(new PgExecutionStore(db), (e) => metrics.inc('execution_journal_write_failures_total', { op: e.op })) : null;
   if (journal) await journal.reconcileOnStart();                                                   // terminates what a previous process left open; throws if the store is unreadable: do not start
   const killSwitch = journal ? journal.createKillSwitch() : new eg.ExecutionKillSwitch();
   if (journal) await journal.hydrateKillSwitch(killSwitch as eg.JournaledKillSwitch);              // a restart never releases an engaged switch; throws if unreadable: do not start
   new eg.ExecutionOrchestrator({ /* …existing deps…, */ killSwitch, ...(journal ? { journal: { sink: journal, dataRegion: (orgId) => orgDataRegion(orgId) /* the organization's data_region */ } } : {}) });
   ```
   - On shutdown call `await journal.drain()` (flushes the write-behind queue).
   - Alert on `journal.failures()` growing (the counter above feeds `ExecutionJournalWriteFailures`; the rule is added to `infra/runtime/alerts/runtime-alerts.yaml` by P3-S02 only when the metric is registered: say if you register it under another name).
   - **What it is not**: a durable work queue. The queue payload is not stored, so after a restart every job that was queued or running is terminated (`restart_recovery`) and the caller submits again with a NEW idempotency key (the old key is refused `idempotency_key_already_recorded`). Approvals are still in memory (a restart revokes pending approvals by terminating their jobs). Quota reservations/usage are not journaled by this batch (the store methods exist; wiring them needs the orchestrator's `ledger` to become async, a separate change).
   - Needs migrations 2310–2313 and the ownership/residency patch of CONTRACT-2 applied.
