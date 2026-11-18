import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { COMMANDS, validateArgs } from './commands';
import {
  MAX_ENVELOPE_BYTES,
  canonicalize,
  hashEnvelope,
  verifyEnvelope,
  type EnvelopeRejection,
} from './envelope';
import type { CommandExecutor } from './executor';

export type AgentRejection =
  | EnvelopeRejection
  | 'replayed'
  | 'unknown_command'
  | 'invalid_args'
  | 'token_reuse'
  | 'node_not_active';
export interface AgentReply {
  status: 'ok' | 'rejected' | 'failed';
  reason?: AgentRejection | 'timeout' | 'output_too_large' | 'executor_error';
  category?: string;
  message?: string;
  result?: unknown;
  /** true when a previous result for the same idempotency token was returned without re-executing */
  recorded?: boolean;
}
export interface AuditEntry {
  seq: number;
  occurredAt: string;
  operationId: string | null;
  commandId: string | null;
  outcome: 'accepted' | 'rejected' | 'executed' | 'failed';
  reason: string | null;
  envelopeHash: string;
  prevHash: string;
  hash: string;
}
export const ZERO_HASH = '0'.repeat(64);
export const auditHash = (e: Omit<AuditEntry, 'hash'>): string =>
  createHash('sha256')
    .update(
      [
        e.seq,
        e.occurredAt,
        e.operationId ?? '',
        e.commandId ?? '',
        e.outcome,
        e.reason ?? '',
        e.envelopeHash,
        e.prevHash,
      ].join('|'),
    )
    .digest('hex');

/** What survives an agent restart (persisted on the node in production). */
export interface LedgerState {
  nonces: Record<string, number>;
  results: Record<string, { argsHash: string; reply: AgentReply }>;
  audit: AuditEntry[];
}

/**
 * The agent's decision logic (threat model §2-§6): verify, replay-protect, allow-list, validate, execute under a timeout and an output cap, record an
 * append-only hash-chained audit entry for EVERY decision. The executor is the only thing that touches the node.
 */
export class AgentRuntime {
  private state: LedgerState;
  constructor(
    private readonly cfg: {
      nodeId: string;
      keys: Map<string, KeyObject>;
      executor: CommandExecutor;
      now?: () => Date;
      active?: () => boolean;
    },
    state?: LedgerState,
  ) {
    this.state = state ?? { nonces: {}, results: {}, audit: [] };
  }
  private now() {
    return this.cfg.now?.() ?? new Date();
  }
  snapshot(): LedgerState {
    return JSON.parse(JSON.stringify(this.state)) as LedgerState;
  }
  get auditLog(): readonly AuditEntry[] {
    return this.state.audit;
  }
  private log(
    outcome: AuditEntry['outcome'],
    envHash: string,
    operationId: string | null,
    commandId: string | null,
    reason: string | null,
  ) {
    const prev = this.state.audit[this.state.audit.length - 1]?.hash ?? ZERO_HASH;
    const base = {
      seq: this.state.audit.length + 1,
      occurredAt: this.now().toISOString(),
      operationId,
      commandId,
      outcome,
      reason,
      envelopeHash: envHash,
      prevHash: prev,
    };
    this.state.audit.push({ ...base, hash: auditHash(base) });
  }
  private reject(
    reason: AgentRejection,
    envHash: string,
    op: string | null,
    cmd: string | null,
  ): AgentReply {
    this.log('rejected', envHash, op, cmd, reason);
    return { status: 'rejected', reason };
  }

  async handle(raw: unknown): Promise<AgentReply> {
    const now = this.now();
    const rawHash = createHash('sha256').update(safeJson(raw)).digest('hex');
    if (safeJson(raw).length > MAX_ENVELOPE_BYTES)
      return this.reject('oversize', rawHash, null, null);
    if (this.cfg.active && !this.cfg.active())
      return this.reject('node_not_active', rawHash, null, null);
    const v = verifyEnvelope(raw, { nodeId: this.cfg.nodeId, keys: this.cfg.keys, now });
    if (!v.ok) return this.reject(v.reason, rawHash, null, null);
    const env = v.envelope;
    const b = env.body;
    const eh = hashEnvelope(env);
    // replay: a nonce is single-use until it can no longer be valid (expiry + skew)
    for (const [n, exp] of Object.entries(this.state.nonces))
      if (exp < now.getTime() - 60_000) delete this.state.nonces[n];
    if (this.state.nonces[b.nonce] !== undefined)
      return this.reject('replayed', eh, b.operationId, b.commandId);
    this.state.nonces[b.nonce] = Date.parse(b.expiresAt);
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, b.commandId))
      return this.reject('unknown_command', eh, b.operationId, b.commandId);
    const def = COMMANDS[b.commandId]!;
    const bad = validateArgs(def.schema, b.args);
    if (bad) {
      this.log('rejected', eh, b.operationId, b.commandId, 'invalid_args');
      return { status: 'rejected', reason: 'invalid_args', message: bad };
    }
    const argsHash = createHash('sha256').update(canonicalize(b.args)).digest('hex');
    const key = `${b.commandId}|${b.idempotencyToken}`;
    if (def.mutating) {
      const prior = this.state.results[key];
      if (prior) {
        if (prior.argsHash !== argsHash)
          return this.reject('token_reuse', eh, b.operationId, b.commandId);
        this.log('accepted', eh, b.operationId, b.commandId, 'recorded_result');
        return { ...prior.reply, recorded: true };
      }
    }
    this.log('accepted', eh, b.operationId, b.commandId, null);
    let reply: AgentReply;
    try {
      const r = await withTimeout(
        this.cfg.executor.execute(b.commandId, b.args, {
          idempotencyToken: b.idempotencyToken,
          operationId: b.operationId,
          now,
        }),
        def.timeoutMs,
      );
      if (r === TIMEOUT)
        reply = { status: 'failed', reason: 'timeout', message: 'command timed out' };
      else if (!r.ok) reply = { status: 'failed', category: r.category, message: r.message };
      else if (safeJson(r.result).length > def.maxOutputBytes)
        reply = { status: 'failed', reason: 'output_too_large' };
      else reply = { status: 'ok', result: r.result };
    } catch (e) {
      reply = {
        status: 'failed',
        reason: 'executor_error',
        message: (e as Error).message.slice(0, 200),
      };
    }
    this.log(
      reply.status === 'ok' ? 'executed' : 'failed',
      eh,
      b.operationId,
      b.commandId,
      reply.reason ?? reply.category ?? null,
    );
    // only a SUCCESS is recorded as the result of a token: a failed attempt may be retried with the same token
    if (def.mutating && reply.status === 'ok') this.state.results[key] = { argsHash, reply };
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
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** Verifies the hash chain of an audit log (control-plane side of "shipped to the control plane"). */
export function verifyAuditChain(entries: readonly AuditEntry[]): {
  ok: boolean;
  brokenAt?: number;
} {
  let prev = ZERO_HASH;
  for (const e of entries) {
    const { hash, ...base } = e;
    if (e.prevHash !== prev || auditHash(base) !== hash) return { ok: false, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true };
}
