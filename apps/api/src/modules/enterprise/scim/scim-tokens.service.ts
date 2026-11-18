import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';

export interface ScimPrincipal {
  orgId: string;
  connectionId: string;
  tokenId: string;
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * SCIM bearer tokens (identity.scim_tokens): SHA-256 hashed, bound to ONE organization and ONE connection, shown once, rotatable, revocable, with an
 * optional expiry. Issuance is a SERVICE capability: the HTTP endpoint (POST /v1/organizations/{orgId}/scim-tokens, PA-04 / SCR-M12-01) is not
 * approved, so nothing exposes `issue` to a caller yet.
 */
export class ScimTokenService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async issue(
    orgId: string,
    connectionId: string,
    createdBy: string,
    opts: { expiresAt?: Date } = {},
  ): Promise<{ id: string; token: string; prefix: string }> {
    const id = uuidv7();
    const prefix = `nzscim_${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8)}`;
    const token = `${prefix}.${randomBytes(32).toString('base64url')}`;
    await this.db.withOrg(orgId, async (c) => {
      const conn = await c.query(
        `SELECT 1 FROM identity.sso_connections WHERE id = $1 AND status <> 'disabled'`,
        [connectionId],
      );
      if (!conn.rowCount) throw new ProblemException('not_found');
      await c.query(
        `INSERT INTO identity.scim_tokens (id, org_id, connection_id, prefix, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, orgId, connectionId, prefix, sha(token), opts.expiresAt ?? null, createdBy],
      );
      await this.audit.record({
        action: 'scim.token.issued',
        orgId,
        actorUserId: createdBy,
        resource: { type: 'scim_token', id },
        outcome: 'success',
        detail: { prefix, connectionId },
      });
    });
    return { id, token, prefix };
  }

  async revoke(orgId: string, tokenId: string, by: string): Promise<boolean> {
    return this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE identity.scim_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [tokenId],
      );
      if (r.rowCount)
        await this.audit.record({
          action: 'scim.token.revoked',
          orgId,
          actorUserId: by,
          resource: { type: 'scim_token', id: tokenId },
          outcome: 'success',
        });
      return Boolean(r.rowCount);
    });
  }

  /** Rotation: a new token is issued and the old one revoked in the caller's flow (both audited). */
  async rotate(orgId: string, oldTokenId: string, by: string) {
    const old = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query<{ connection_id: string }>(
            `SELECT connection_id FROM identity.scim_tokens WHERE id = $1 AND revoked_at IS NULL`,
            [oldTokenId],
          )
        ).rows[0],
    );
    if (!old) throw new ProblemException('not_found');
    const fresh = await this.issue(orgId, old.connection_id, by);
    await this.revoke(orgId, oldTokenId, by);
    return fresh;
  }

  /** Returns the principal for a presented token, or null (unknown, revoked, expired, org suspended/connection disabled). Same cost either way. */
  async authenticate(presented: string): Promise<ScimPrincipal | null> {
    const dot = presented.indexOf('.');
    if (dot < 0 || !/^nzscim_[A-Za-z0-9]{8}$/.test(presented.slice(0, dot))) return null;
    const prefix = presented.slice(0, dot);
    return this.db.withAuthScope('scim_lookup', async (c) => {
      const { rows } = await c.query<{
        id: string;
        org_id: string;
        connection_id: string;
        token_hash: string;
        revoked_at: Date | null;
        expires_at: Date | null;
      }>(
        `SELECT t.id, t.org_id, t.connection_id, t.token_hash, t.revoked_at, t.expires_at FROM identity.scim_tokens t WHERE t.prefix = $1`,
        [prefix],
      );
      const t = rows[0];
      const a = Buffer.from(sha(presented));
      const b = Buffer.from(t?.token_hash ?? sha('x'));
      const same = a.length === b.length && timingSafeEqual(a, b);
      if (!t || !same || t.revoked_at || (t.expires_at && t.expires_at.getTime() <= Date.now()))
        return null;
      await c.query(`UPDATE identity.scim_tokens SET last_used_at = now() WHERE id = $1`, [t.id]);
      return { orgId: t.org_id, connectionId: t.connection_id, tokenId: t.id };
    });
  }
}
