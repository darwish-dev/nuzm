import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { IdClaims } from './oidc';

export interface UserRow {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  locale: 'ar' | 'en';
  status: 'active' | 'disabled';
  is_platform_user: boolean;
}

export class UserService {
  constructor(private readonly db: Db) {}

  /** JIT-provision on first login; refresh profile on later logins. Never re-enables a disabled user. */
  async upsertFromClaims(issuer: string, c: IdClaims): Promise<UserRow> {
    return this.db.withoutScope(async (cl) => {
      const { rows } = await cl.query<UserRow>(
        `INSERT INTO identity.users (id, issuer, subject, email, email_verified, display_name, last_login_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (issuer, subject) DO UPDATE
           SET email = EXCLUDED.email, email_verified = EXCLUDED.email_verified,
               display_name = COALESCE(EXCLUDED.display_name, identity.users.display_name), last_login_at = now()
         RETURNING id, email, email_verified, display_name, locale, status, is_platform_user`,
        [uuidv7(), issuer, c.sub, c.email, c.emailVerified, c.name ?? null],
      );
      return rows[0]!;
    });
  }

  async get(id: string): Promise<UserRow | null> {
    return this.db.withoutScope(async (cl) => {
      const { rows } = await cl.query<UserRow>(
        'SELECT id, email, email_verified, display_name, locale, status, is_platform_user FROM identity.users WHERE id=$1',
        [id],
      );
      return rows[0] ?? null;
    });
  }
}
