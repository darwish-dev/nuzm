import type { executionGateway as eg } from '@nuzm/domain';
import type { AuditAction, AuditEvent, AuditSink } from '../../common/audit';

/**
 * S-AG6 (OFFLINE): adapts the domain's content-free execution audit record to the platform `AuditSink` (hash-chained `audit.audit_logs` in production). The record's detail is
 * already allow-listed and bounded by `buildExecAudit`; this adapter adds nothing to it and never passes content. NOT wired to any module or route.
 */
export function toAuditEvent(r: eg.ExecAuditRecord): AuditEvent {
  return {
    action: r.action as AuditAction,
    actorUserId: r.actorUserId,
    actorType: r.actorType === 'agent' ? 'system' : r.actorType,
    // the platform-level `*` org is reserved for events with no organization (global kill switch)
    orgId: r.orgId === '*' ? undefined : r.orgId,
    resource: { type: 'ai_execution', id: r.jobId ?? r.runId },
    outcome: r.outcome,
    detail: { ...r.detail, runId: r.runId, at: r.at },
  };
}
export class ExecutionAuditAdapter {
  constructor(private readonly sink: AuditSink) {}
  readonly record = async (r: eg.ExecAuditRecord): Promise<void> => {
    await this.sink.record(toAuditEvent(r));
  };
}
