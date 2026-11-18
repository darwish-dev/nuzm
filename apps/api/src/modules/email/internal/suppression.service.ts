import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { PoolClient } from 'pg';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { FieldCipher } from '../../../common/field-crypto';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { DataRow as Row } from '../../data';
import { parseAddress } from './template';

export const addressHash = (a: string): string =>
  createHash('sha256').update(a.trim().toLowerCase()).digest('hex');
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);
export interface SuppressionDto {
  id: string;
  /** Shown to the organization's own managers (the list is sealed at rest). */
  address: string;
  reason: 'bounce_hard' | 'bounce_soft' | 'complaint' | 'manual';
  source: 'webhook' | 'manual' | 'provider_sync';
  active: boolean;
  createdAt: string;
  removedAt: string | null;
}

/**
 * Suppression list (FR-DAT-07): a hard bounce or a complaint suppresses the address automatically (webhook); a soft bounce does after N in a window (policy);
 * managers can add manually and remove (audited). The address is stored sealed + hashed (personal); sends check the hash BEFORE the provider is called.
 * Adding the same (address, reason) twice is one row: a duplicate webhook can never create a second suppression.
 */
export class SuppressionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly cipher: FieldCipher,
  ) {}

  /** Insert inside the caller's transaction. Returns true when a NEW active suppression was created. */
  async addIn(
    c: PoolClient,
    orgId: string,
    address: string,
    reason: SuppressionDto['reason'],
    source: SuppressionDto['source'],
    eventId: string | null,
    actor: string | null,
  ): Promise<{ id: string; created: boolean }> {
    const hash = addressHash(address);
    const id = uuidv7();
    const sealed = await this.cipher.encrypt(address.trim().toLowerCase(), {
      column: 'email.suppressions.address_enc',
      row: id,
    });
    const r = await c.query(
      `INSERT INTO email.suppressions (id, org_id, address_hash, address_enc, reason, source, event_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id, address_hash, reason) DO UPDATE SET active = true, removed_at = NULL, removed_by = NULL
         WHERE email.suppressions.active = false
       RETURNING id, (xmax = 0) AS inserted`,
      [id, orgId, hash, sealed, reason, source, eventId, actor],
    );
    // an already-active identical row returns nothing: it exists, nothing was created
    if (r.rowCount === 0) {
      const ex = await c.query(
        `SELECT id FROM email.suppressions WHERE org_id = $1 AND address_hash = $2 AND reason = $3`,
        [orgId, hash, reason],
      );
      return { id: ex.rows[0]!.id as string, created: false };
    }
    return { id: r.rows[0]!.id as string, created: true };
  }
  async isSuppressed(orgId: string, addresses: string[]): Promise<string[]> {
    const hashes = addresses.map(addressHash);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT DISTINCT address_hash FROM email.suppressions WHERE org_id = $1 AND address_hash = ANY($2::text[]) AND active`,
            [orgId, hashes],
          )
        ).rows as Row[],
    );
    const hit = new Set(rows.map((r) => r.address_hash as string));
    return hashes.filter((h) => hit.has(h));
  }

  async add(orgId: string, actor: string, body: Record<string, unknown>): Promise<SuppressionDto> {
    if (Object.keys(body).some((k) => !['address', 'action', 'override'].includes(k)))
      throw new ProblemException('validation_failed', 'unknown field');
    const address = parseAddress(body.address);
    const action = body.action ?? 'add';
    if (action === 'remove') return this.remove(orgId, actor, address, body.override === true);
    if (action !== 'add')
      throw new ProblemException('validation_failed', 'action must be add or remove');
    const out = await this.db.withOrg(orgId, async (c) => {
      const r = await this.addIn(c, orgId, address, 'manual', 'manual', null, actor);
      return {
        ...r,
        row: (await c.query(`SELECT * FROM email.suppressions WHERE id = $1`, [r.id]))
          .rows[0] as Row,
      };
    });
    if (out.created)
      await this.audit.record({
        action: 'email.suppression.added',
        actorUserId: actor,
        orgId,
        resource: { type: 'suppression', id: out.id },
        outcome: 'success',
        after: { reason: 'manual', addressHash: addressHash(address).slice(0, 12) },
      });
    return this.dto(out.row, address);
  }
  /** Remove (audited). Hard bounces and complaints are protective: removing them needs `override=true` (the console asks the manager to confirm). */
  async remove(
    orgId: string,
    actor: string,
    address: string,
    override: boolean,
  ): Promise<SuppressionDto> {
    const hash = addressHash(address);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.suppressions WHERE org_id = $1 AND address_hash = $2 AND active`,
            [orgId, hash],
          )
        ).rows as Row[],
    );
    if (rows.length === 0)
      throw new ProblemException('not_found', 'this address is not suppressed');
    if (rows.some((r) => (r.reason === 'bounce_hard' || r.reason === 'complaint') && !override))
      throw new ProblemException(
        'validation_failed',
        'this address bounced or complained: send override=true to remove it anyway',
      );
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE email.suppressions SET active = false, removed_at = now(), removed_by = $3 WHERE org_id = $1 AND address_hash = $2 AND active`,
        [orgId, hash, actor],
      ),
    );
    await this.audit.record({
      action: 'email.suppression.removed',
      actorUserId: actor,
      orgId,
      resource: { type: 'suppression', id: rows[0]!.id as string },
      outcome: 'success',
      after: { reasons: rows.map((r) => r.reason), override, addressHash: hash.slice(0, 12) },
    });
    const row = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT * FROM email.suppressions WHERE id = $1`, [rows[0]!.id])).rows[0],
    )) as Row;
    return this.dto(row, address);
  }
  dto(r: Row, address: string): SuppressionDto {
    return {
      id: r.id as string,
      address,
      reason: r.reason as SuppressionDto['reason'],
      source: r.source as SuppressionDto['source'],
      active: r.active as boolean,
      createdAt: iso(r.created_at)!,
      removedAt: iso(r.removed_at),
    };
  }
  async list(
    orgId: string,
    q: { limit: number; cursor?: string; active?: string },
  ): Promise<Page<SuppressionDto>> {
    const before = decodeCursor(q.cursor);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM email.suppressions WHERE org_id = $1 AND ($2::uuid IS NULL OR id < $2) AND ($3::boolean IS NULL OR active = $3) ORDER BY id DESC LIMIT $4`,
            [orgId, before, q.active === undefined ? null : q.active === 'true', q.limit + 1],
          )
        ).rows as Row[],
    );
    const p = pageOf(rows as (Row & { id: string })[], q.limit);
    const items = await Promise.all(
      p.items.map(async (r) =>
        this.dto(
          r,
          await this.cipher.decrypt(r.address_enc as string, {
            column: 'email.suppressions.address_enc',
            row: r.id as string,
          }),
        ),
      ),
    );
    return { items, nextCursor: p.nextCursor };
  }
}
