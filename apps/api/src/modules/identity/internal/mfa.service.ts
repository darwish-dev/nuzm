import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import type { SecretStore } from '../../../common/secrets';

export interface MfaOptions {
  pepper: Uint8Array; // HMAC key for recovery-code hashes (derived from a server secret)
  lockThreshold: number; // consecutive failures before lock (proposal 5)
  lockSeconds: number; // lock duration (proposal 15 min)
  pendingTtlSeconds: number; // a pending enrolment older than this may be replaced
  issuerLabel: string;
}

export function derivePepper(sealKey: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', sealKey, new Uint8Array(0), 'nuzm-recovery-pepper', 32));
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1: unambiguous
const normalize = (c: string) => c.toUpperCase().replace(/[\s-]/g, '');

export function newRecoveryCode(): string {
  const b = randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += B32[b[i]! % 32];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

interface FactorRow {
  id: string;
  status: 'pending' | 'active';
  secret_ref: string;
  failed_attempts: number;
  locked_until: Date | null;
  last_used_step: string | null;
  created_at: Date;
}

export class MfaService {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly opts: MfaOptions,
  ) {}

  private totp(secretB32: string, label: string) {
    return new OTPAuth.TOTP({
      issuer: this.opts.issuerLabel,
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretB32),
    });
  }

  async hasActiveFactor(userId: string): Promise<boolean> {
    return this.db.withoutScope(async (c) =>
      Boolean(
        (
          await c.query(`SELECT 1 FROM identity.mfa_factors WHERE user_id=$1 AND status='active'`, [
            userId,
          ])
        ).rowCount,
      ),
    );
  }

  async listFactors(userId: string) {
    return this.db.withoutScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, type, status, created_at, verified_at FROM identity.mfa_factors WHERE user_id=$1 ORDER BY created_at`,
            [userId],
          )
        ).rows,
    );
  }

  /** Start TOTP enrolment. The secret is returned once and stored only in the secret store. */
  async enroll(user: {
    id: string;
    email: string;
  }): Promise<{ factorId: string; otpauthUri: string; secret: string }> {
    const secret = new OTPAuth.Secret({ size: 20 });
    const id = uuidv7();
    const ref = await this.secrets.put(`mfa-${id}`, secret.base32);
    try {
      await this.db.withoutScope(async (c) => {
        const { rows } = await c.query<{
          status: string;
          id: string;
          secret_ref: string;
          fresh: boolean;
        }>(
          `SELECT id, status, secret_ref, created_at > now() - make_interval(secs=>$2) AS fresh
             FROM identity.mfa_factors WHERE user_id=$1 FOR UPDATE`,
          [user.id, this.opts.pendingTtlSeconds],
        );
        if (rows.some((r) => r.status === 'active'))
          throw new ProblemException('conflict', 'an active factor already exists');
        const pending = rows.find((r) => r.status === 'pending');
        if (pending?.fresh)
          throw new ProblemException('conflict', 'an enrolment is already pending');
        if (pending) {
          await c.query('DELETE FROM identity.mfa_factors WHERE id=$1', [pending.id]);
          await this.secrets.delete(pending.secret_ref);
        }
        await c.query(
          `INSERT INTO identity.mfa_factors (id, user_id, type, secret_ref) VALUES ($1,$2,'totp',$3)`,
          [id, user.id, ref],
        );
      });
    } catch (e) {
      await this.secrets.delete(ref);
      throw e;
    }
    return {
      factorId: id,
      otpauthUri: this.totp(secret.base32, user.email).toString(),
      secret: secret.base32,
    };
  }

  /** Verify a TOTP code for a factor (activates a pending factor). Throws on bad code/lock. */
  async verifyTotp(
    user: { id: string; email: string },
    factorId: string,
    code: string,
  ): Promise<{ activated: boolean }> {
    const outcome = await this.db.withoutScope(async (c) => {
      const { rows } = await c.query<FactorRow>(
        `SELECT id, status, secret_ref, failed_attempts, locked_until, last_used_step, created_at
           FROM identity.mfa_factors WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [factorId, user.id],
      );
      const f = rows[0];
      if (!f) return { kind: 'not_found' as const };
      if (f.locked_until && f.locked_until.getTime() > Date.now())
        return { kind: 'locked' as const };

      const secret = await this.secrets.get(f.secret_ref);
      const delta = /^\d{6}$/.test(code)
        ? this.totp(secret, user.email).validate({ token: code, window: 1 })
        : null;
      const step = delta === null ? null : Math.floor(Date.now() / 30000) + delta;
      const replay =
        step !== null && f.last_used_step !== null && BigInt(step) <= BigInt(f.last_used_step);

      if (step === null || replay) {
        const attempts = f.failed_attempts + 1;
        const lock = attempts >= this.opts.lockThreshold;
        await c.query(
          `UPDATE identity.mfa_factors SET failed_attempts=$2, locked_until = CASE WHEN $3 THEN now() + make_interval(secs=>$4) ELSE locked_until END WHERE id=$1`,
          [f.id, lock ? 0 : attempts, lock, this.opts.lockSeconds],
        );
        return lock ? { kind: 'locked_now' as const } : { kind: 'bad' as const };
      }
      await c.query(
        `UPDATE identity.mfa_factors SET failed_attempts=0, locked_until=NULL, last_used_step=$2,
           status='active', verified_at = COALESCE(verified_at, now()) WHERE id=$1`,
        [f.id, step],
      );
      return { kind: 'ok' as const, activated: f.status === 'pending' };
    });
    if (outcome.kind === 'not_found') throw new ProblemException('not_found');
    if (outcome.kind === 'locked' || outcome.kind === 'locked_now')
      throw new ProblemException('rate_limited', 'too many failed attempts; try again later');
    if (outcome.kind === 'bad') throw new ProblemException('validation_failed', 'invalid code');
    return { activated: outcome.activated };
  }

  /** New batch of 10 single-use recovery codes; previous codes are invalidated. Shown once. */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, newRecoveryCode);
    const batch = uuidv7();
    await this.db.withoutScope(async (c) => {
      await c.query('DELETE FROM identity.recovery_codes WHERE user_id=$1', [userId]);
      for (const code of codes) {
        await c.query(
          'INSERT INTO identity.recovery_codes (id, user_id, batch_id, code_hash) VALUES ($1,$2,$3,$4)',
          [uuidv7(), userId, batch, this.hash(code)],
        );
      }
    });
    return codes;
  }

  private hash(code: string): string {
    return createHmac('sha256', this.opts.pepper).update(normalize(code)).digest('hex');
  }

  /** Consume a recovery code (single use, atomic). Failures feed the same lockout as TOTP. */
  async verifyRecoveryCode(userId: string, code: string): Promise<void> {
    const outcome = await this.db.withoutScope(async (c) => {
      const { rows } = await c.query<FactorRow>(
        `SELECT id, status, secret_ref, failed_attempts, locked_until, last_used_step, created_at
           FROM identity.mfa_factors WHERE user_id=$1 AND status='active' FOR UPDATE`,
        [userId],
      );
      const f = rows[0];
      if (!f) return 'no_factor' as const;
      if (f.locked_until && f.locked_until.getTime() > Date.now()) return 'locked' as const;
      const used = await c.query(
        `UPDATE identity.recovery_codes SET used_at = now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id`,
        [userId, this.hash(code)],
      );
      if (used.rowCount) {
        await c.query(
          'UPDATE identity.mfa_factors SET failed_attempts=0, locked_until=NULL WHERE id=$1',
          [f.id],
        );
        return 'ok' as const;
      }
      const attempts = f.failed_attempts + 1;
      const lock = attempts >= this.opts.lockThreshold;
      await c.query(
        `UPDATE identity.mfa_factors SET failed_attempts=$2, locked_until = CASE WHEN $3 THEN now() + make_interval(secs=>$4) ELSE locked_until END WHERE id=$1`,
        [f.id, lock ? 0 : attempts, lock, this.opts.lockSeconds],
      );
      return lock ? ('locked' as const) : ('bad' as const);
    });
    if (outcome === 'no_factor') throw new ProblemException('not_found');
    if (outcome === 'locked')
      throw new ProblemException('rate_limited', 'too many failed attempts; try again later');
    if (outcome === 'bad') throw new ProblemException('validation_failed', 'invalid recovery code');
  }

  /** Mark the session as MFA-verified (does NOT rotate tokens; callers rotate for fixation safety). */
  async elevateSession(sessionId: string, level: 'totp' | 'recovery'): Promise<void> {
    await this.db.withoutScope((c) =>
      c.query(`UPDATE identity.sessions SET mfa_level=$2, mfa_verified_at=now() WHERE id=$1`, [
        sessionId,
        level,
      ]),
    );
  }

  /** Remove a factor. Platform users (admin realm) may not remove their last active factor. */
  async removeFactor(
    user: { id: string; isPlatformUser: boolean },
    factorId: string,
  ): Promise<void> {
    await this.db.withoutScope(async (c) => {
      const { rows } = await c.query<{ id: string; status: string; secret_ref: string }>(
        'SELECT id, status, secret_ref FROM identity.mfa_factors WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [factorId, user.id],
      );
      const f = rows[0];
      if (!f) throw new ProblemException('not_found');
      if (f.status === 'active' && user.isPlatformUser)
        throw new ProblemException('conflict', 'platform users must keep an active MFA factor');
      await c.query('DELETE FROM identity.mfa_factors WHERE id=$1', [f.id]);
      if (f.status === 'active')
        await c.query('DELETE FROM identity.recovery_codes WHERE user_id=$1', [user.id]);
      await this.secrets.delete(f.secret_ref);
    });
  }
}
