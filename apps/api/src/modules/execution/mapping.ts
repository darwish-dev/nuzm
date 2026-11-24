import { executionGateway as eg } from '@nuzm/domain';
import type { Quota } from '../appbuilder/internal/sandbox/runtime';

/** decision limits -> the M10 sandbox quota (the runtime's own units) */
export function quotaFromLimits(l: eg.ExecLimits): Quota {
  return {
    vcpu: 1,
    memoryMb: l.memoryMb,
    diskGb: Math.max(1, Math.ceil(l.diskMb / 1024)),
    pids: l.pids,
    buildTimeoutMinutes: Math.max(1, Math.ceil(l.wallSeconds / 60)),
  };
}
export const checkRunEnvOk = (env: Record<string, string>): boolean => eg.checkRunEnv(env).ok;
