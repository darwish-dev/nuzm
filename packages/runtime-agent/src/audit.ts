import { appendFile } from 'node:fs/promises';

/**
 * Node-side audit trail: one JSON line per event, CONTENT-FREE (ids, codes, counts; never file content, argv, env, stdout or a token). The platform's log agent ships the file to
 * the platform log (D-34); the agent only appends. A write failure never changes a run's outcome (it increments a counter the alert rules watch).
 */
export type AgentEventType =
  | 'agent_started'
  | 'request_refused'
  | 'workspace_created'
  | 'workspace_destroyed'
  | 'workspace_destroy_failed'
  | 'run_started'
  | 'run_finished'
  | 'run_killed'
  | 'run_limit_kill'
  | 'run_flood_kill'
  | 'spec_refused'
  | 'stray_killed'
  | 'emergency_stop'
  | 'reaped'
  | 'node_disabled'
  | 'image_mismatch';
export interface AgentEvent {
  type: AgentEventType;
  orgId?: string;
  runId?: string;
  workspaceId?: string;
  handle?: string;
  /** codes and numbers only */
  detail?: Record<string, string | number | boolean>;
}
export interface AuditSink {
  write(e: AgentEvent): Promise<void>;
}
export class FileAuditSink implements AuditSink {
  failures = 0;
  constructor(
    private readonly file: string,
    private readonly nodeId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}
  async write(e: AgentEvent): Promise<void> {
    try {
      await appendFile(
        this.file,
        `${JSON.stringify({ ts: new Date(this.now()).toISOString(), node: this.nodeId, ...e })}\n`,
        { mode: 0o640 },
      );
    } catch {
      this.failures++;
    }
  }
}
/** in-memory sink for tests */
export class MemoryAuditSink implements AuditSink {
  readonly events: AgentEvent[] = [];
  async write(e: AgentEvent): Promise<void> {
    this.events.push(e);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}
