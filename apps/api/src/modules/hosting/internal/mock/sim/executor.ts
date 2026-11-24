/** What the simulated node runtime needs from the simulated node. TEST DOUBLE ONLY: the product talks to a real panel through `hestia/` (HestiaCP's REST API). */
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
