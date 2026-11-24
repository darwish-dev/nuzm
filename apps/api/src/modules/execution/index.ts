/**
 * S-AG6 (OFFLINE) execution module: adapters only. Not registered in `app.module.ts`, no controller, no route, no job. The feature flag `ai.agent.exec_tools` stays closed
 * (`AiFlags.execTools` always returns false) and `executionGate` stays closed; nothing here can start a process on its own. The `ExecutionPort` over the sandbox runtime
 * boundary lives next to the runtime, in `appbuilder/internal/sandbox/execution-port.ts` (module boundary lint).
 */
export * from './audit-adapter';
export * from './qualification-tools';
export * from './runtime-metrics';
