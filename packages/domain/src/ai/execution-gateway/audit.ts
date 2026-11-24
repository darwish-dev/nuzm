import { scanForSecrets } from '../secret-scan';

/**
 * S-AG6 (OFFLINE): execution audit events (ADR-069 item 7). Every request, decision (with reasons), approval step, start, finish, exit status and byte count is recorded WITHOUT
 * content: no stdout, no stderr, no file text, no argv beyond the profile id, no environment, no model text. `buildExecAudit` takes a free-form detail and returns only the
 * allow-listed, bounded, scalar members, so a caller cannot leak content by accident. The api module adapts the record to the platform `AuditSink`.
 */
export type ExecAuditAction =
  | 'ai.execution.requested'
  | 'ai.execution.refused'
  | 'ai.execution.quota_refused'
  | 'ai.execution.approval_requested'
  | 'ai.execution.approved'
  | 'ai.execution.rejected'
  | 'ai.execution.approval_expired'
  | 'ai.execution.queued'
  | 'ai.execution.started'
  | 'ai.execution.finished'
  | 'ai.execution.limit_exceeded'
  | 'ai.execution.terminated'
  | 'ai.execution.kill_switch'
  | 'ai.execution.artifact_recorded'
  | 'ai.execution.artifact_refused'
  | 'ai.execution.workspace_destroyed'
  | 'ai.execution.output_redacted'
  | 'ai.execution.gate_refused';
export const EXEC_AUDIT_ACTIONS: readonly ExecAuditAction[] = [
  'ai.execution.requested',
  'ai.execution.refused',
  'ai.execution.quota_refused',
  'ai.execution.approval_requested',
  'ai.execution.approved',
  'ai.execution.rejected',
  'ai.execution.approval_expired',
  'ai.execution.queued',
  'ai.execution.started',
  'ai.execution.finished',
  'ai.execution.limit_exceeded',
  'ai.execution.terminated',
  'ai.execution.kill_switch',
  'ai.execution.artifact_recorded',
  'ai.execution.artifact_refused',
  'ai.execution.workspace_destroyed',
  'ai.execution.output_redacted',
  'ai.execution.gate_refused',
];
export interface ExecAuditRecord {
  action: ExecAuditAction;
  orgId: string;
  runId: string;
  jobId?: string;
  actorUserId?: string;
  actorType: 'user' | 'system' | 'agent';
  outcome: 'success' | 'failure';
  detail: Record<string, string | number | boolean | string[]>;
  at: string;
}
const ALLOWED_DETAIL = new Set([
  'profile',
  'reasons',
  'network',
  'requiresApproval',
  'approvalId',
  'status',
  'exitCode',
  'durationMs',
  'stdoutBytes',
  'stderrBytes',
  'truncated',
  'artifactCount',
  'artifactBytes',
  'resource',
  'limit',
  'observed',
  'scope',
  'cause',
  'runtimeOrigin',
  'attempt',
  'count',
]);
const MAX_STR = 120;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,120}$/;

/** Allow-list, bound and secret-scan a detail object. Strings must look like identifiers (no free text can ride along); anything else is dropped. */
export function sanitizeAuditDetail(
  raw: Record<string, unknown>,
): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_DETAIL.has(k)) continue;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') {
      if (v.length <= MAX_STR && SAFE_TOKEN.test(v) && scanForSecrets(v).length === 0) out[k] = v;
    } else if (Array.isArray(v)) {
      const items = v
        .filter(
          (x): x is string =>
            typeof x === 'string' && SAFE_TOKEN.test(x) && scanForSecrets(x).length === 0,
        )
        .slice(0, 20);
      out[k] = items;
    }
  }
  return out;
}
export function buildExecAudit(
  i: Omit<ExecAuditRecord, 'detail' | 'at'> & { detail?: Record<string, unknown>; at?: Date },
): ExecAuditRecord {
  const { detail, at, ...rest } = i;
  return {
    ...rest,
    detail: sanitizeAuditDetail(detail ?? {}),
    at: (at ?? new Date()).toISOString(),
  };
}
/** Byte counts for the finish event, computed from the outcome without keeping any of it. */
export const outputByteCounts = (o: { stdout: string; stderr: string }) => ({
  stdoutBytes: Buffer.byteLength(o.stdout),
  stderrBytes: Buffer.byteLength(o.stderr),
});
