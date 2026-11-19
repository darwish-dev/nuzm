import type { Schema, DataBlock } from '@nuzm/domain';

/**
 * Run kinds (M09 S38). A kind is a handler registered in `RunKindRegistry`; M10 registers `webapp|mobile|test-fix` the same way. A handler is RESUMABLE: it
 * keeps its progress in `ctx.checkpoint` (saved after every step) and must skip steps whose result is already there.
 */
export interface RunRow {
  id: string;
  orgId: string;
  sessionId: string;
  projectId: string | null;
  kind: string;
  state: string;
  input: Record<string, unknown>;
  budget: { maxTokens?: number; maxCredits?: number };
  checkpoint: Record<string, unknown>;
  step: string | null;
  dataRegion: string;
  createdBy: string | null;
  cancelRequested: boolean;
  version: number;
}
export type ApprovalKind = 'plan' | 'apply_changes' | 'publish' | 'delete' | 'spend' | 'auto_apply';
export interface ResumedWith {
  approvalId: string;
  kind: ApprovalKind;
  decision: 'approved' | 'denied';
  note: string | null;
  payload: unknown;
}
export type AgentTask =
  'requirements' | 'architecture' | 'page' | 'edit' | 'chat' | 'mobile_design';
export interface AgentCall {
  task: AgentTask;
  /** the trusted instruction (code, never user text) */
  instruction: string;
  /** trusted structured parameters (strings are sanitised before they enter the prompt) */
  params?: Record<string, unknown>;
  /** untrusted material: uploads, fetched pages, user messages. Enters the prompt ONLY inside delimited data blocks. */
  data?: DataBlock[];
  /** JSON schema of the `result` member of the agent envelope */
  schema: Schema;
  maxTokens: number;
  capability?: 'chat' | 'structured-output';
}
export interface RunContext {
  run: RunRow;
  orgId: string;
  userId: string | null;
  checkpoint: Record<string, unknown>;
  resumedWith: ResumedWith | null;
  /** one validated model call (gateway: residency, budget, secret scan; repair loop ≤ 2; tool-call allow-list) */
  call<T = unknown>(a: AgentCall): Promise<T>;
  emit(type: string, data?: Record<string, unknown>): Promise<number>;
  /** merge into the checkpoint and name the step: call after EVERY completed step */
  save(patch: Record<string, unknown>, step?: string): Promise<void>;
  artifact(
    type:
      'requirements' | 'architecture' | 'page' | 'change_set' | 'site_model' | 'evaluation_report',
    payload: unknown,
  ): Promise<string>;
  /** end this segment and wait for a human: creates the approval, moves the run to `waiting_approval`; never returns */
  requestApproval(
    kind: ApprovalKind,
    summary: Record<string, unknown>,
    payload: unknown,
  ): Promise<never>;
  /** finish successfully; never returns */
  succeed(result: Record<string, unknown>): Promise<never>;
  cancelled(): Promise<boolean>;
  /** an artifact of this organization by id (e.g. the requirements of an earlier run) */
  loadArtifact(id: string): Promise<{ type: string; payload: unknown } | null>;
  /** SSRF-safe fetch of a user-supplied URL, reduced to text (tags and comments stripped) */
  fetchText(url: string): Promise<{ url: string; text: string }>;
  sessionMessages(): Promise<
    { id: string; role: string; content: string; attachments: unknown[] }[]
  >;
  addAssistantMessage(content: string, attachments?: unknown[]): Promise<void>;
}
export interface RunKindHandler {
  kind: string;
  /** throws ProblemException `validation_failed` for a malformed input */
  validateInput(input: Record<string, unknown>): void;
  /** the tool allow-list name of this kind in the untrusted-content defences */
  toolKind: 'website' | 'edit' | 'chat';
  /** the run must belong to a builder project (422 at creation otherwise) */
  requiresProject?: boolean;
  execute(ctx: RunContext): Promise<void>;
  /** a denied approval: default (absent) = the run is cancelled */
  onDenied?(ctx: RunContext): Promise<void>;
}
export abstract class RunKindRegistry {
  abstract register(h: RunKindHandler): void;
  abstract get(kind: string): RunKindHandler | undefined;
  abstract kinds(): string[];
}
export class StaticRunKindRegistry extends RunKindRegistry {
  private readonly m = new Map<string, RunKindHandler>();
  register(h: RunKindHandler) {
    this.m.set(h.kind, h);
  }
  get(kind: string) {
    return this.m.get(kind);
  }
  kinds() {
    return [...this.m.keys()];
  }
}

/** Control-flow signals of a segment. They are thrown by the context and caught by the engine; a handler must not swallow them. */
export class SegmentSuspend extends Error {
  constructor(readonly reason: 'approval') {
    super(`segment suspended: ${reason}`);
  }
}
export class SegmentDone extends Error {
  constructor(readonly result: Record<string, unknown>) {
    super('segment done');
  }
}
/** Test hook: simulates a worker process dying mid-segment (the engine leaves everything as it is, so the lease expires and the run is re-claimed). */
export class WorkerCrash extends Error {}
export class AgentOutputInvalid extends Error {
  constructor(
    readonly task: string,
    readonly errors: string[],
  ) {
    super(`agent output for ${task} is invalid after repair`);
  }
}
