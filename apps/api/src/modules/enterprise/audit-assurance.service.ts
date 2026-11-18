import { createHash } from 'node:crypto';
import { AuditIntegrity, type ChainReport, type CheckpointSigner, type Db } from '@nuzm/platform';

/**
 * Audit assurance (M12 S55 task 5, FR-ENT-05): hash-chain verification for every chain, and SIGNED EXPORTS. The audit log is hash-chained and NOT
 * partitioned, so partition-level archival of audit.audit_logs is DEFERRED (docs/adr/ADR-055-audit-log-archival.md, PROPOSED): this service only
 * reads. A manifest binds the exported rows (count, first/last chain position and a SHA-256 over the ndjson body) to the chain tip checkpoints and is
 * signed with the audit checkpoint key (dev HMAC key until D-12). Tampering with the body, the manifest or the signature is detected by `verifyExport`.
 */
export interface ExportFilter {
  orgId?: string | null;
  from?: Date;
  to?: Date;
  limit?: number;
}
export interface ExportManifest {
  version: 1;
  generatedAt: string;
  chains: { chainKey: string; fromSeq: number; toSeq: number; rows: number; tipHash: string }[];
  rows: number;
  bodySha256: string;
  filter: { orgId: string | null; from: string | null; to: string | null };
  keyRef: string;
}
export interface SignedExport {
  manifest: ExportManifest;
  signature: string;
  body: string; // ndjson, one audit row per line, in (chain, seq) order
}

const canonical = (m: ExportManifest) => `nuzm-audit-export-v1|${JSON.stringify(m)}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class AuditAssuranceService {
  private readonly integrity: AuditIntegrity;
  constructor(
    private readonly db: Db,
    private readonly signer: CheckpointSigner,
  ) {
    this.integrity = new AuditIntegrity(db, signer);
  }

  /** Verifies every chain (hashes, links, signed checkpoints). Never repairs anything. */
  async verifyAll(): Promise<{ ok: boolean; chains: ChainReport[]; broken: ChainReport[] }> {
    const r = await this.integrity.runOnce();
    const broken = r.chains.filter((c) => !c.ok);
    return { ok: broken.length === 0, chains: r.chains, broken };
  }

  async export(f: ExportFilter = {}): Promise<SignedExport> {
    const limit = Math.min(f.limit ?? 50_000, 200_000);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<Record<string, unknown>>(
            `SELECT id, chain_key, chain_seq, occurred_at, org_id, acting_org_id, actor_type, actor_user_id, actor_api_key_id, impersonator_user_id, action, resource_type, resource_id,
                outcome, trace_id, before, after, detail, prev_hash, hash
           FROM audit.audit_logs WHERE ($1::uuid IS NULL OR org_id = $1) AND ($2::timestamptz IS NULL OR occurred_at >= $2) AND ($3::timestamptz IS NULL OR occurred_at < $3)
          ORDER BY chain_key, chain_seq LIMIT $4`,
            [f.orgId ?? null, f.from ?? null, f.to ?? null, limit],
          )
        ).rows,
    );
    const body = rows
      .map((r) =>
        JSON.stringify({
          ...r,
          chain_seq: String(r.chain_seq),
          occurred_at: (r.occurred_at as Date).toISOString(),
        }),
      )
      .join('\n');
    const chains = new Map<string, ExportManifest['chains'][number]>();
    for (const r of rows) {
      const k = r.chain_key as string;
      const seq = Number(r.chain_seq);
      const c = chains.get(k);
      if (!c)
        chains.set(k, {
          chainKey: k,
          fromSeq: seq,
          toSeq: seq,
          rows: 1,
          tipHash: r.hash as string,
        });
      else {
        c.toSeq = seq;
        c.rows++;
        c.tipHash = r.hash as string;
      }
    }
    const manifest: ExportManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      chains: [...chains.values()],
      rows: rows.length,
      bodySha256: sha(body),
      filter: {
        orgId: f.orgId ?? null,
        from: f.from?.toISOString() ?? null,
        to: f.to?.toISOString() ?? null,
      },
      keyRef: this.signer.keyRef,
    };
    return { manifest, signature: this.signer.sign(canonical(manifest)), body };
  }

  /** Verifies the signature, the body digest and the row count; returns the first problem found, or null. */
  verifyExport(e: SignedExport): string | null {
    if (!this.signer.verify(canonical(e.manifest), e.signature))
      return 'manifest signature invalid';
    if (sha(e.body) !== e.manifest.bodySha256) return 'body does not match the manifest digest';
    const n = e.body === '' ? 0 : e.body.split('\n').length;
    if (n !== e.manifest.rows) return 'row count does not match the manifest';
    return null;
  }
}
