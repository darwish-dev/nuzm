import { enforcedConnectionFor } from './sso-enforcement';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { Mailer } from '../../../common/mailer';
import type { IdentityConfig } from './config';
import {
  hashPassword,
  makeDummyHash,
  passwordProblem,
  verifyPassword,
  type PasswordProblem,
  type ScryptCost,
} from './password';
import type { SessionService } from './session.service';
import type { UserRow } from './user.service';

/** Issuer recorded for users created by the built-in sign-in. */
export const LOCAL_ISSUER = 'nuzm:local';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

type Purpose = 'email_verification' | 'password_reset';
interface Meta {
  ip?: string;
  traceId?: string;
}

const REASON: Record<PasswordProblem, string> = {
  too_short: 'password must be at least 12 characters',
  too_long: 'password must be at most 128 characters',
  common: 'password is too common',
  same_as_email: 'password must not be the email address',
};

/** Built-in email + password accounts (ADR-008): registration, sign-in with lockout, reset, change and email verification. */
export class CredentialsService {
  private readonly cost: ScryptCost;
  private dummy: Promise<string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly cfg: IdentityConfig,
    private readonly sessions: SessionService,
    private readonly mailer: Mailer,
    private readonly audit: AuditSink,
  ) {
    this.cost = { logN: cfg.scryptLogN, r: 8, p: 1 };
  }

  private dummyHash() {
    return (this.dummy ??= makeDummyHash(this.cost));
  }

  /** 422 with a field error; the message never repeats the password. */
  assertPolicy(password: string, email?: string) {
    const bad = passwordProblem(password, email);
    if (bad)
      throw new ProblemException('weak_password', REASON[bad], [
        { field: 'password', message: REASON[bad] },
      ]);
  }

  validateEmail(raw: unknown): string {
    const email = typeof raw === 'string' ? normalizeEmail(raw) : '';
    if (!email || email.length > 254 || !EMAIL.test(email))
      throw new ProblemException('validation_failed', 'email is not valid', [
        { field: 'email', message: 'email is not valid' },
      ]);
    return email;
  }

  async register(
    input: { email: string; password: string; displayName?: string; locale?: 'ar' | 'en' },
    meta: Meta,
  ): Promise<UserRow> {
    const email = this.validateEmail(input.email);
    this.assertPolicy(input.password, email);
    if (await enforcedConnectionFor(this.db, email)) {
      await this.audit.record({
        action: 'auth.account.registration_refused',
        outcome: 'failure',
        traceId: meta.traceId,
        ip: meta.ip,
        detail: { reason: 'sso_enforced' },
      });
      throw new ProblemException('sso_required');
    }
    const hash = await hashPassword(input.password, this.cost);
    const id = uuidv7();
    let user: UserRow;
    try {
      user = await this.db.withoutScope(async (c) => {
        const { rows } = await c.query<UserRow>(
          `INSERT INTO identity.users (id, issuer, subject, email, email_verified, display_name, locale, last_login_at)
           VALUES ($1,$2,$6,$3,false,$4,$5, now())
           RETURNING id, email, email_verified, display_name, locale, status, is_platform_user`,
          [id, LOCAL_ISSUER, email, input.displayName?.trim() || null, input.locale ?? 'ar', id],
        );
        await c.query(`INSERT INTO identity.credentials (user_id, password_hash) VALUES ($1,$2)`, [
          id,
          hash,
        ]);
        return rows[0]!;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('email_in_use', 'an account with this email already exists');
      throw e;
    }
    await this.audit.record({
      action: 'auth.account.registered',
      actorUserId: user.id,
      outcome: 'success',
      traceId: meta.traceId,
      ip: meta.ip,
      resource: { type: 'user', id: user.id },
    });
    await this.sendToken(user, 'email_verification', meta);
    return user;
  }

  /**
   * Checks the password. Unknown email, wrong password, locked account, disabled user and platform user all end in the same
   * `invalid_credentials` (and the unknown email still pays for one hash). Returns the user on success.
   */
  async login(
    emailRaw: string,
    password: string,
    meta: Meta,
    realm: 'web' | 'admin' = 'web',
  ): Promise<UserRow> {
    const email = typeof emailRaw === 'string' ? normalizeEmail(emailRaw) : '';
    const fail = async (reason: string, userId?: string): Promise<never> => {
      await this.audit.record({
        action: 'auth.login.failed',
        actorUserId: userId,
        outcome: 'failure',
        traceId: meta.traceId,
        ip: meta.ip,
        detail: { method: 'password', realm, reason },
      });
      throw new ProblemException('invalid_credentials');
    };
    if (!email || typeof password !== 'string' || password.length > 128) {
      await verifyPassword('x', await this.dummyHash());
      return fail('malformed');
    }
    if (await enforcedConnectionFor(this.db, email)) {
      await this.audit.record({
        action: 'auth.login.failed',
        outcome: 'failure',
        traceId: meta.traceId,
        ip: meta.ip,
        detail: { method: 'password', reason: 'sso_enforced' },
      });
      throw new ProblemException('sso_required');
    }
    const row = await this.db.withoutScope(async (c) => {
      const { rows } = await c.query<
        UserRow & { password_hash: string; locked_until: Date | null }
      >(
        `SELECT u.id, u.email, u.email_verified, u.display_name, u.locale, u.status, u.is_platform_user,
                k.password_hash, k.locked_until
           FROM identity.users u JOIN identity.credentials k ON k.user_id = u.id
          WHERE lower(u.email) = $1 AND ${
            realm === 'admin'
              ? 'u.is_platform_user' // staff: any issuer, but only platform users
              : `u.issuer = '${LOCAL_ISSUER}'`
          }`,
        [email],
      );
      return rows[0] ?? null;
    });
    if (!row) {
      await verifyPassword(password, await this.dummyHash());
      return fail('unknown_email');
    }
    const locked = row.locked_until !== null && row.locked_until.getTime() > Date.now();
    // Always verify (even when locked) so timing does not reveal the lock; a locked account never succeeds.
    const ok = await verifyPassword(password, row.password_hash);
    if (locked) return fail('locked', row.id);
    if (!ok) {
      await this.recordFailure(row.id);
      return fail('wrong_password', row.id);
    }
    if (row.status !== 'active') return fail('user_disabled', row.id);
    // staff never sign in to the customer console with a password (and customers never reach the admin one: the query above)
    if (realm === 'web' && row.is_platform_user) return fail('platform_user', row.id);
    await this.db.withoutScope((c) =>
      c.query(
        `UPDATE identity.credentials SET failed_attempts = 0, last_failed_at = NULL, locked_until = NULL WHERE user_id=$1`,
        [row.id],
      ),
    );
    await this.db.withoutScope((c) =>
      c.query(`UPDATE identity.users SET last_login_at = now() WHERE id=$1`, [row.id]),
    );
    const { password_hash: _h, locked_until: _l, ...user } = row;
    return user;
  }

  private async recordFailure(userId: string) {
    await this.db.withoutScope((c) =>
      c.query(
        `UPDATE identity.credentials
            SET failed_attempts = failed_attempts + 1, last_failed_at = now(),
                locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(secs => $3) ELSE locked_until END
          WHERE user_id = $1`,
        [userId, this.cfg.passwordLockThreshold, this.cfg.passwordLockSeconds],
      ),
    );
  }

  /** Always resolves; mail failures are audited, never shown (no enumeration, no oracle for mail outages). */
  async requestReset(emailRaw: string, meta: Meta): Promise<void> {
    const email = typeof emailRaw === 'string' ? normalizeEmail(emailRaw) : '';
    const user = email
      ? await this.db.withoutScope(async (c) => {
          const { rows } = await c.query<UserRow>(
            `SELECT u.id, u.email, u.email_verified, u.display_name, u.locale, u.status, u.is_platform_user
               FROM identity.users u JOIN identity.credentials k ON k.user_id = u.id
              WHERE u.issuer=$1 AND lower(u.email)=$2 AND u.status='active'`,
            [LOCAL_ISSUER, email],
          );
          return rows[0] ?? null;
        })
      : null;
    await this.audit.record({
      action: 'auth.password.reset_requested',
      actorUserId: user?.id,
      outcome: 'success',
      traceId: meta.traceId,
      ip: meta.ip,
      detail: { known: Boolean(user) },
    });
    if (user) await this.sendToken(user, 'password_reset', meta);
  }

  async resetPassword(token: string, newPassword: string, meta: Meta): Promise<void> {
    const found = await this.peekToken(token, 'password_reset');
    if (!found) throw new ProblemException('invalid_token');
    this.assertPolicy(newPassword, found.email);
    const hash = await hashPassword(newPassword, this.cost);
    const used = await this.db.withoutScope(async (c) => {
      // single use: the conditional UPDATE decides the race
      const r = await c.query(
        `UPDATE identity.auth_tokens SET used_at = now()
          WHERE id=$1 AND used_at IS NULL AND expires_at > now()`,
        [found.id],
      );
      if (!r.rowCount) return false;
      await c.query(
        `UPDATE identity.credentials
            SET password_hash=$2, password_set_at=now(), failed_attempts=0, last_failed_at=NULL, locked_until=NULL
          WHERE user_id=$1`,
        [found.userId, hash],
      );
      await this.voidTokens(c, found.userId, 'password_reset');
      return true;
    });
    if (!used) throw new ProblemException('invalid_token');
    const n = await this.sessions.revokeAllForUser(found.userId);
    await this.audit.record({
      action: 'auth.password.reset',
      actorUserId: found.userId,
      outcome: 'success',
      traceId: meta.traceId,
      ip: meta.ip,
      detail: { sessionsRevoked: n },
    });
  }

  async changePassword(
    userId: string,
    sessionId: string,
    current: string,
    next: string,
    meta: Meta,
  ): Promise<void> {
    const row = await this.db.withoutScope(async (c) => {
      const { rows } = await c.query<{ password_hash: string; email: string; locked: boolean }>(
        `SELECT k.password_hash, u.email, coalesce(k.locked_until > now(), false) AS locked
           FROM identity.credentials k JOIN identity.users u ON u.id = k.user_id WHERE k.user_id=$1`,
        [userId],
      );
      return rows[0] ?? null;
    });
    // a user who signed in some other way has no password to change here
    if (!row) throw new ProblemException('forbidden', 'this account has no password');
    const ok = typeof current === 'string' && (await verifyPassword(current, row.password_hash));
    if (row.locked || !ok) {
      if (!row.locked) await this.recordFailure(userId);
      await this.audit.record({
        action: 'auth.password.change_failed',
        actorUserId: userId,
        outcome: 'failure',
        traceId: meta.traceId,
        ip: meta.ip,
      });
      throw new ProblemException('invalid_credentials');
    }
    this.assertPolicy(next, row.email);
    const hash = await hashPassword(next, this.cost);
    await this.db.withoutScope((c) =>
      c.query(
        `UPDATE identity.credentials
            SET password_hash=$2, password_set_at=now(), failed_attempts=0, last_failed_at=NULL, locked_until=NULL
          WHERE user_id=$1`,
        [userId, hash],
      ),
    );
    const n = await this.sessions.revokeAllForUser(userId, sessionId);
    await this.audit.record({
      action: 'auth.password.changed',
      actorUserId: userId,
      outcome: 'success',
      traceId: meta.traceId,
      ip: meta.ip,
      detail: { otherSessionsRevoked: n },
    });
  }

  async verifyEmail(token: string, meta: Meta): Promise<void> {
    const found = await this.peekToken(token, 'email_verification');
    if (!found) throw new ProblemException('invalid_token');
    const ok = await this.db.withoutScope(async (c) => {
      const r = await c.query(
        `UPDATE identity.auth_tokens SET used_at = now() WHERE id=$1 AND used_at IS NULL AND expires_at > now()`,
        [found.id],
      );
      if (!r.rowCount) return false;
      await c.query(`UPDATE identity.users SET email_verified = true WHERE id=$1`, [found.userId]);
      return true;
    });
    if (!ok) throw new ProblemException('invalid_token');
    await this.audit.record({
      action: 'auth.email.verified',
      actorUserId: found.userId,
      outcome: 'success',
      traceId: meta.traceId,
      ip: meta.ip,
    });
  }

  /** Signed-in user asks for a new verification mail. Returns false when there is nothing to verify. */
  async resendVerification(userId: string, meta: Meta): Promise<boolean> {
    const user = await this.db.withoutScope(async (c) => {
      const { rows } = await c.query<UserRow>(
        `SELECT id, email, email_verified, display_name, locale, status, is_platform_user FROM identity.users WHERE id=$1`,
        [userId],
      );
      return rows[0] ?? null;
    });
    if (!user || user.email_verified) return false;
    await this.sendToken(user, 'email_verification', meta);
    return true;
  }

  // ---- tokens ----------------------------------------------------------------------------------------------------

  private async voidTokens(c: PoolClient, userId: string, purpose: Purpose) {
    await c.query(
      `UPDATE identity.auth_tokens SET used_at = now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL`,
      [userId, purpose],
    );
  }

  private async peekToken(token: string, purpose: Purpose) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    return this.db.withoutScope(async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string; email: string }>(
        `SELECT t.id, t.user_id, u.email
           FROM identity.auth_tokens t JOIN identity.users u ON u.id = t.user_id
          WHERE t.token_hash=$1 AND t.purpose=$2 AND t.used_at IS NULL AND t.expires_at > now() AND u.status='active'`,
        [sha(token), purpose],
      );
      const r = rows[0];
      return r ? { id: r.id, userId: r.user_id, email: r.email } : null;
    });
  }

  /** Cancels earlier tokens of the same purpose, stores the hash of a new one and emails it. A mail failure is audited only. */
  private async sendToken(user: UserRow, purpose: Purpose, meta: Meta) {
    const token = `nzt_${randomBytes(32).toString('base64url')}`;
    const ttlMs =
      purpose === 'email_verification'
        ? this.cfg.verifyTokenHours * 3_600_000
        : this.cfg.resetTokenMinutes * 60_000;
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.db.withoutScope(async (c) => {
      await this.voidTokens(c, user.id, purpose);
      await c.query(
        `INSERT INTO identity.auth_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5)`,
        [uuidv7(), user.id, purpose, sha(token), expiresAt],
      );
    });
    try {
      await this.mailer.send({
        template: purpose,
        to: user.email,
        locale: user.locale,
        data: { token, expiresAt: expiresAt.toISOString() },
      });
    } catch {
      await this.audit.record({
        action: `auth.${purpose === 'password_reset' ? 'password' : 'email'}.mail_failed`,
        actorUserId: user.id,
        outcome: 'failure',
        traceId: meta.traceId,
        ip: meta.ip,
        detail: { purpose },
      });
    }
  }
}
