import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { Mailer } from '../../../common/mailer';

export interface NotificationDraft {
  orgId: string;
  userId: string;
  /** `<domain>.<topic>` e.g. `security.impersonation_started`; params are non-sensitive facts for rendering. */
  kind: string;
  params: Record<string, unknown>;
}
export interface Recipient {
  email: string;
  emailVerified: boolean;
  locale: 'ar' | 'en';
}

/** A delivery channel. Channels never throw for expected failures of OTHER channels (see NotificationService). */
export interface NotificationChannel {
  readonly name: 'in_app' | 'email';
  deliver(n: NotificationDraft, to: Recipient): Promise<void>;
}

export class InAppChannel implements NotificationChannel {
  readonly name = 'in_app' as const;
  constructor(private readonly db: Db) {}
  async deliver(n: NotificationDraft): Promise<void> {
    // No RETURNING: the recipient-only SELECT policy hides other users' rows from the producer.
    await this.db.withOrg(n.orgId, (c) =>
      c.query(
        `INSERT INTO platform.notifications (id, org_id, user_id, kind, body) VALUES ($1,$2,$3,$4,$5)`,
        [uuidv7(), n.orgId, n.userId, n.kind, JSON.stringify({ params: n.params })],
      ),
    );
  }
}

/** Email via the Mailer port (dev: logs; production provider arrives with M08/D-08). */
export class EmailChannel implements NotificationChannel {
  readonly name = 'email' as const;
  constructor(private readonly mailer: Mailer) {}
  async deliver(n: NotificationDraft, to: Recipient): Promise<void> {
    if (!to.emailVerified) return; // never mail an unverified address
    await this.mailer.send({
      to: to.email,
      template: 'notification',
      locale: to.locale,
      data: { kind: n.kind, params: n.params },
    });
  }
}
