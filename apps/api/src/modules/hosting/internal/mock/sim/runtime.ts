import { createHash } from 'node:crypto';
import { COMMANDS, validateArgs } from './commands';
import type { CommandExecutor } from './executor';

/**
 * TEST DOUBLE: the decision logic of a simulated hosting node (allow-list, argument validation, an idempotency ledger per token, timeout). It lets the platform's
 * own logic (capacity, reconcile-before-retry, quotas, abuse, suspension) be tested without a panel. It proves nothing about HestiaCP: that is `hestia/` and its tests.
 */
export interface SimRequest {
  commandId: string;
  args: Record<string, unknown>;
  idempotencyToken: string;
  operationId: string;
}
export interface SimReply {
  status: 'ok' | 'rejected' | 'failed';
  reason?:
    | 'unknown_command'
    | 'invalid_args'
    | 'token_reuse'
    | 'node_not_active'
    | 'timeout'
    | 'output_too_large'
    | 'executor_error';
  category?: string;
  message?: string;
  result?: unknown;
  /** true when a previous result for the same idempotency token was returned without re-executing */
  recorded?: boolean;
}

export class SimRuntime {
  private readonly results = new Map<string, { argsHash: string; reply: SimReply }>();
  constructor(
    private readonly cfg: {
      nodeId: string;
      executor: CommandExecutor;
      now?: () => Date;
      active?: () => boolean;
    },
  ) {}

  async handle(req: SimRequest): Promise<SimReply> {
    if (this.cfg.active && !this.cfg.active())
      return { status: 'rejected', reason: 'node_not_active' };
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, req.commandId))
      return { status: 'rejected', reason: 'unknown_command' };
    const def = COMMANDS[req.commandId]!;
    const bad = validateArgs(def.schema, req.args);
    if (bad) return { status: 'rejected', reason: 'invalid_args', message: bad };
    const argsHash = createHash('sha256').update(JSON.stringify(req.args)).digest('hex');
    const key = `${req.commandId}|${req.idempotencyToken}`;
    if (def.mutating) {
      const prior = this.results.get(key);
      if (prior) {
        if (prior.argsHash !== argsHash) return { status: 'rejected', reason: 'token_reuse' };
        return { ...prior.reply, recorded: true };
      }
    }
    let reply: SimReply;
    try {
      const r = await withTimeout(
        this.cfg.executor.execute(req.commandId, req.args, {
          idempotencyToken: req.idempotencyToken,
          operationId: req.operationId,
          now: this.cfg.now?.() ?? new Date(),
        }),
        def.timeoutMs,
      );
      if (r === TIMEOUT)
        reply = { status: 'failed', reason: 'timeout', message: 'command timed out' };
      else if (!r.ok) reply = { status: 'failed', category: r.category, message: r.message };
      else if (JSON.stringify(r.result ?? null).length > def.maxOutputBytes)
        reply = { status: 'failed', reason: 'output_too_large' };
      else reply = { status: 'ok', result: r.result };
    } catch (e) {
      reply = {
        status: 'failed',
        reason: 'executor_error',
        message: (e as Error).message.slice(0, 200),
      };
    }
    // only a SUCCESS is recorded as the result of a token: a failed attempt may be retried with the same token
    if (def.mutating && reply.status === 'ok') this.results.set(key, { argsHash, reply });
    return reply;
  }
}
const TIMEOUT = Symbol('timeout');
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
