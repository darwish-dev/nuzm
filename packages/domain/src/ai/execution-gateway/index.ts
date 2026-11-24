/**
 * S-AG6 (OFFLINE PREPARATION) public surface of the Execution Gateway. The policy core lives in `policy.ts` (unchanged API); the rest is the offline machinery around it:
 * ports, limits and quotas, state machines, queue, approvals, audit, termination, monitoring, secret/env protection, artifacts, cleanup. NOTHING here starts a process or
 * is wired to a route, tool declaration or job; `executionGate` stays closed.
 */
export * from './policy';
export * from './port';
export * from './mock-port';
export * from './limits';
export * from './quota';
export * from './lifecycle';
export * from './queue';
export * from './approval';
export * from './audit';
export * from './env-guard';
export * from './termination';
export * from './monitor';
export * from './health';
export * from './artifacts';
export * from './cleanup';
export * from './runtime-spec';
export * from './orchestrator';
export * from './workspace';
export * from './real-runtime';
export * from './node-protocol';
