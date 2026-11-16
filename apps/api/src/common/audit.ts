/**
 * Audit sink port. Every mutation and every auth outcome calls `record` (docs/04, M01 §9). The persistent
 * implementation (hash-chained `audit.audit_logs`) lives in modules/audit; `LogAuditSink` is the fallback
 * for tools and unit tests that run without a database.
 */
export type AuditAction = `${string}.${string}.${string}`; // <domain>.<resource>.<action>

export interface AuditEvent {
  action: AuditAction; // e.g. auth.login.succeeded
  /** Effective actor. For an impersonated session this is the TARGET user; see impersonatorUserId. */
  actorUserId?: string;
  actorApiKeyId?: string;
  impersonatorUserId?: string;
  actorType?: 'user' | 'api_key' | 'system' | 'impersonator';
  /** Target organization (chain owner). Omit for platform-level events. */
  orgId?: string;
  actingOrgId?: string;
  resource?: { type: string; id?: string };
  outcome: 'success' | 'failure';
  traceId?: string;
  ip?: string;
  userAgent?: string;
  /** PII-minimised summaries of state before/after a mutation (never secrets). */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
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
