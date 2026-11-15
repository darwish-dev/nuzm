import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { IdentityConfig } from './config';

export type Realm = 'web' | 'admin';

export interface Principal {
  userId: string;
  sessionId: string;
  realm: Realm;
  mfaLevel: 'none' | 'totp' | 'recovery';
  mfaVerifiedAt: Date | null;
  email: string;
}

export interface SessionInfo {
  id: string;
  realm: Realm;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  mfaLevel: string;
  userAgent: string | null;
  ip: string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const rand = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

/** Opaque server-side sessions: only SHA-256 hashes of the session and CSRF tokens are stored. */
export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly cfg: IdentityConfig,
  ) {}

  async create(userId: string, realm: Realm, meta: { ip?: string; userAgent?: string }) {
    const token = rand('nzs_');
    const csrf = rand('nzc_');
    const id = uuidv7();
    await this.db.withoutScope((c) =>
      c.query(
        `INSERT INTO identity.sessions (id, user_id, realm, token_hash, csrf_hash, idle_expires_at, absolute_expires_at, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs=>$6), now() + make_interval(secs=>$7), $8, $9)`,
        [
          id,
          userId,
          realm,
          sha(token),
          sha(csrf),
          this.cfg.idleSeconds,
          this.cfg.absoluteSeconds,
          meta.ip ?? null,
          meta.userAgent?.slice(0, 300) ?? null,
        ],
      ),
    );
    return { id, token, csrf };
  }

  /** Validate a presented token for a realm; slides the idle timeout but never past the absolute one. */
  async authenticate(
    token: string,
    realm: Realm,
  ): Promise<(Principal & { csrfHash: string }) | null> {
    return this.db.withoutScope(async (c) => {
      const { rows } = await c.query<{
        id: string;
        user_id: string;
        realm: Realm;
        mfa_level: Principal['mfaLevel'];
        mfa_verified_at: Date | null;
        csrf_hash: string;
        email: string;
      }>(
        `SELECT s.id, s.user_id, s.realm, s.mfa_level, s.mfa_verified_at, s.csrf_hash, u.email
           FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL
            AND s.idle_expires_at > now() AND s.absolute_expires_at > now() AND u.status = 'active'`,
        [sha(token)],
      );
      const r = rows[0];
      if (!r || r.realm !== realm) return null; // admin-realm tokens are rejected on web routes and vice versa
      await c.query(
        `UPDATE identity.sessions SET last_seen_at = now(),
           idle_expires_at = LEAST(now() + make_interval(secs=>$2), absolute_expires_at) WHERE id = $1`,
        [r.id, this.cfg.idleSeconds],
      );
      return {
        userId: r.user_id,
        sessionId: r.id,
        realm: r.realm,
        mfaLevel: r.mfa_level,
        mfaVerifiedAt: r.mfa_verified_at,
        email: r.email,
        csrfHash: r.csrf_hash,
      };
    });
  }

  csrfValid(csrfHash: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const a = Buffer.from(sha(presented));
    const b = Buffer.from(csrfHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Issue fresh tokens for an existing session (call after privilege change, e.g. MFA step-up). */
  async rotate(sessionId: string): Promise<{ token: string; csrf: string } | null> {
    const token = rand('nzs_');
    const csrf = rand('nzc_');
    const n = await this.db.withoutScope(
      async (c) =>
        (
          await c.query(
            `UPDATE identity.sessions SET token_hash=$2, csrf_hash=$3 WHERE id=$1 AND revoked_at IS NULL`,
            [sessionId, sha(token), sha(csrf)],
          )
        ).rowCount,
    );
    return n ? { token, csrf } : null;
  }

  async list(userId: string): Promise<SessionInfo[]> {
    return this.db.withoutScope(async (c) => {
      const { rows } = await c.query(
        `SELECT id, realm, created_at, last_seen_at, idle_expires_at, absolute_expires_at, mfa_level, user_agent, ip
           FROM identity.sessions WHERE user_id=$1 AND revoked_at IS NULL AND absolute_expires_at > now() AND idle_expires_at > now()
          ORDER BY created_at DESC`,
        [userId],
      );
      return rows.map((r) => ({
        id: r.id,
        realm: r.realm,
        createdAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        idleExpiresAt: r.idle_expires_at.toISOString(),
        absoluteExpiresAt: r.absolute_expires_at.toISOString(),
        mfaLevel: r.mfa_level,
        userAgent: r.user_agent,
        ip: r.ip,
      }));
    });
  }

  /** Revoke one of the user's own sessions. Returns false for unknown OR foreign sessions (404 either way). */
  async revoke(userId: string, sessionId: string): Promise<boolean> {
    return this.db.withoutScope(async (c) =>
      Boolean(
        (
          await c.query(
            `UPDATE identity.sessions SET revoked_at = now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
            [sessionId, userId],
          )
        ).rowCount,
      ),
    );
  }

  async revokeByToken(token: string): Promise<void> {
    await this.db.withoutScope((c) =>
      c.query(
        `UPDATE identity.sessions SET revoked_at = now() WHERE token_hash=$1 AND revoked_at IS NULL`,
        [sha(token)],
      ),
    );
  }
}
