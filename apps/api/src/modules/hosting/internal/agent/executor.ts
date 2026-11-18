/** What the agent runtime needs from the thing that really touches the node: the production implementation spawns argv arrays (clpctl + system helpers); tests use MockCloudPanelNode. */
export type ExecResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      category:
        | 'validation'
        | 'not_found'
        | 'conflict'
        | 'unsupported'
        | 'capacity'
        | 'rate_limit'
        | 'internal';
      message: string;
    };

export interface ExecContext {
  idempotencyToken: string;
  operationId: string;
  now: Date;
}
export interface CommandExecutor {
  execute(commandId: string, args: Record<string, unknown>, ctx: ExecContext): Promise<ExecResult>;
}
/** Production seam: how a process is run. Always an argv ARRAY; never a shell. Not exercised against a real node (BLOCKED, HG-06-01). */
export interface ProcessRunner {
  run(
    argv: readonly string[],
    opts: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }>;
}
