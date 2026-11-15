/**
 * Audit sink interface. S02 ships the interface plus a structured-log sink; S04 binds the persistent
 * hash-chained `audit.audit_logs` writer. Every auth outcome calls `record` (docs/04, M01 §9).
 */
export interface AuditEvent {
  action: string; // e.g. auth.login.succeeded
  actorUserId?: string;
  orgId?: string;
  resource?: { type: string; id?: string };
  outcome: 'success' | 'failure';
  traceId?: string;
  ip?: string;
  detail?: Record<string, unknown>;
}

export abstract class AuditSink {
  abstract record(event: AuditEvent): Promise<void> | void;
}

export class LogAuditSink extends AuditSink {
  record(event: AuditEvent): void {
    // Never log secrets; detail must be pre-sanitised by callers.
    process.stdout.write(
      JSON.stringify({ audit: { ...event, at: new Date().toISOString() } }) + '\n',
    );
  }
}
