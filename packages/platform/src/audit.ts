import { createHmac, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from './db';

/** Chain key of the platform chain (events with no organization). */
export const PLATFORM_CHAIN = '00000000-0000-0000-0000-000000000000';

/**
 * Signs chain heads with a key that lives OUTSIDE the database. Production = KMS/vault (D-12, BLOCKED);
 * until then an HMAC key from the environment is used and every checkpoint records its `keyRef`.
 */
export interface CheckpointSigner {
  readonly keyRef: string;
  sign(message: string): string;
  verify(message: string, signature: string): boolean;
}

export class HmacCheckpointSigner implements CheckpointSigner {
  constructor(
    private readonly key: Uint8Array,
    readonly keyRef = 'vault://dev/audit-checkpoint-key',
  ) {
    if (key.length < 32) throw new Error('audit checkpoint key must be at least 32 bytes');
  }
  /** `AUDIT_CHECKPOINT_KEY` = base64 of >= 32 random bytes. DEV stand-in until D-12. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): HmacCheckpointSigner {
    const raw = env.AUDIT_CHECKPOINT_KEY;
    if (!raw) throw new Error('missing required env AUDIT_CHECKPOINT_KEY');
    return new HmacCheckpointSigner(new Uint8Array(Buffer.from(raw, 'base64')));
  }
  sign(message: string): string {
    return createHmac('sha256', this.key).update(message).digest('hex');
  }
  verify(message: string, signature: string): boolean {
    const a = Buffer.from(this.sign(message), 'hex');
    const b = Buffer.from(signature, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export const checkpointMessage = (chain: string, seq: number | string, hash: string) =>
  `nuzm-audit-checkpoint-v1|${chain}|${seq}|${hash}`;

export interface ChainReport {
  chainKey: string;
  ok: boolean;
  checked: number;
  /** First broken sequence number and why (hash chain or checkpoint). */
  firstBadSeq?: number;
  reason?: string;
  checkpointsVerified: number;
}

/**
 * Integrity verifier + checkpointer for the hash-chained audit store. The chain itself is computed by a
 * database trigger; this class only verifies it and anchors chain heads with signed checkpoints.
 * It must run with platform scope (verifier job / admin console), never with caller-supplied scope.
 */
export class AuditIntegrity {
  constructor(
    private readonly db: Db,
    private readonly signer: CheckpointSigner,
  ) {}

  private async tips() {
    return this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ chain_key: string; last_seq: string; last_hash: string }>(
            'SELECT chain_key, last_seq, last_hash FROM audit.chain_tips()',
          )
        ).rows,
    );
  }

  /** Verify one chain's hashes and links, then every signed checkpoint against the rows they anchor. */
  async verifyChain(chainKey: string): Promise<ChainReport> {
    const r = await this.db.withPlatformScope(async (c) => {
      const v = (
        await c.query<{
          ok: boolean;
          checked: string;
          first_bad_seq: string | null;
          reason: string | null;
        }>('SELECT * FROM audit.verify_chain($1)', [chainKey])
      ).rows[0]!;
      const cps = (
        await c.query<{ upto_seq: string; head_hash: string; signature: string }>(
          'SELECT upto_seq, head_hash, signature FROM audit.audit_checkpoints WHERE chain_key = $1 ORDER BY upto_seq',
          [chainKey],
        )
      ).rows;
      const rows = new Map<string, string>();
      if (cps.length)
        for (const x of (
          await c.query<{ chain_seq: string; hash: string }>(
            'SELECT chain_seq, hash FROM audit.audit_logs WHERE chain_key = $1 AND chain_seq = ANY($2::bigint[])',
            [chainKey, cps.map((p) => p.upto_seq)],
          )
        ).rows)
          rows.set(x.chain_seq, x.hash);
      return { v, cps, rows };
    });
    const report: ChainReport = {
      chainKey,
      ok: r.v.ok,
      checked: Number(r.v.checked),
      checkpointsVerified: 0,
      ...(r.v.first_bad_seq ? { firstBadSeq: Number(r.v.first_bad_seq) } : {}),
      ...(r.v.reason ? { reason: r.v.reason } : {}),
    };
    for (const cp of r.cps) {
      const badSig = !this.signer.verify(
        checkpointMessage(chainKey, cp.upto_seq, cp.head_hash),
        cp.signature,
      );
      const rowHash = r.rows.get(cp.upto_seq);
      const why = badSig
        ? 'checkpoint signature invalid'
        : rowHash === undefined
          ? 'checkpointed row is missing (history truncated)'
          : rowHash !== cp.head_hash
            ? 'checkpointed row was altered after it was signed'
            : null;
      if (why) {
        if (report.ok || (report.firstBadSeq ?? Infinity) > Number(cp.upto_seq)) {
          report.ok = false;
          report.firstBadSeq = Number(cp.upto_seq);
          report.reason = why;
        }
        return report;
      }
      report.checkpointsVerified++;
    }
    return report;
  }

  /** Sign the current tip of a chain (only after the chain itself verifies). Idempotent per tip. */
  async checkpoint(chainKey: string): Promise<{ created: boolean; upToSeq: number }> {
    const rep = await this.verifyChain(chainKey);
    if (!rep.ok)
      throw new Error(
        `refusing to checkpoint a broken chain: ${rep.reason} (seq ${rep.firstBadSeq})`,
      );
    const tip = (await this.tips()).find((t) => t.chain_key === chainKey);
    if (!tip) return { created: false, upToSeq: 0 };
    const res = await this.db.withPlatformScope((c) =>
      c.query(
        `INSERT INTO audit.audit_checkpoints (id, org_id, chain_key, upto_seq, head_hash, key_ref, signature)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (chain_key, upto_seq) DO NOTHING`,
        [
          uuidv7(),
          chainKey === PLATFORM_CHAIN ? null : chainKey,
          chainKey,
          tip.last_seq,
          tip.last_hash,
          this.signer.keyRef,
          this.signer.sign(checkpointMessage(chainKey, tip.last_seq, tip.last_hash)),
        ],
      ),
    );
    return { created: (res.rowCount ?? 0) > 0, upToSeq: Number(tip.last_seq) };
  }

  /** Verifier job body: verify (and, when healthy, checkpoint) every chain. */
  async runOnce(): Promise<{ chains: ChainReport[]; checkpointed: number }> {
    const chains: ChainReport[] = [];
    let checkpointed = 0;
    for (const t of await this.tips()) {
      const rep = await this.verifyChain(t.chain_key);
      chains.push(rep);
      if (rep.ok && (await this.checkpoint(t.chain_key)).created) checkpointed++;
    }
    return { chains, checkpointed };
  }
}
