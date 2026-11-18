import { SANDBOX_QUOTA } from '../core';

/**
 * The sandbox technology boundary (D-21 OPEN). The control plane talks to a `SandboxRuntime` only; the technology (gVisor, Firecracker, Kata, rootless containers on a
 * dedicated node pool) is chosen under D-21 and reviewed under HG-10-02. Until then there are two implementations and NEITHER is an isolating runtime:
 *  - `mock`      in-memory, simulates quotas and the control-plane checks; no process is ever started.
 *  - `local-dev` child processes on the developer's machine, dev only, non-isolated.
 * `isolation` is 'verified' ONLY for a runtime whose escape suite ran against it and whose security review (HG-10-02) is recorded; nothing in this repository sets it.
 */
export type RuntimeKind = 'mock' | 'local-dev' | 'isolated';
export type IsolationLevel = 'none' | 'simulated' | 'verified';
export interface Quota {
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  pids: number;
  buildTimeoutMinutes: number;
}
export const DEFAULT_QUOTA: Quota = {
  vcpu: SANDBOX_QUOTA.vcpu,
  memoryMb: SANDBOX_QUOTA.memoryMb,
  diskGb: SANDBOX_QUOTA.diskGb,
  pids: SANDBOX_QUOTA.pids,
  buildTimeoutMinutes: SANDBOX_QUOTA.buildTimeoutMinutes,
};
export interface RuntimeSpec {
  sandboxId: string;
  orgId: string;
  projectId: string;
  quota: Quota;
  /** Egress profile id: the policy the sandbox proxy enforces. */
  egressProfile: string;
}
export interface ExecRequest {
  /** argv, never a shell string: there is no shell interpretation anywhere. */
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
}
export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  /** CPU time used by the command (seconds), as the runtime measured it. */
  cpuSeconds: number;
}
export interface RuntimeStats {
  cpuSeconds: number;
  memoryMb: number;
  diskMb: number;
  pids: number;
}
export class RuntimeNoCapacity extends Error {
  constructor() {
    super('no sandbox capacity');
    this.name = 'RuntimeNoCapacity';
  }
}
export class RuntimeQuotaError extends Error {
  constructor(
    readonly quota: 'disk' | 'pids' | 'files' | 'memory' | 'time',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeQuotaError';
  }
}
export abstract class SandboxRuntime {
  abstract readonly kind: RuntimeKind;
  abstract readonly isolation: IsolationLevel;
  abstract create(spec: RuntimeSpec): Promise<string>;
  abstract writeFiles(handle: string, files: ReadonlyMap<string, string>): Promise<void>;
  abstract readFiles(handle: string, paths?: string[]): Promise<Map<string, string>>;
  abstract exec(handle: string, req: ExecRequest): Promise<ExecResult>;
  abstract stats(handle: string): Promise<RuntimeStats>;
  abstract destroy(handle: string): Promise<void>;
  /** Number of further sandboxes the node pool can host (0 => 503 `sandbox_no_capacity`). */
  abstract freeSlots(): Promise<number>;
}
export const MAX_OUTPUT_BYTES = 1_000_000;
