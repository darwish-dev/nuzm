import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { NotificationChannel, NotificationDraft, Recipient } from './channels';

export interface NotificationItem {
  id: string;
  kind: string;
  params: unknown;
  readAt: string | null;
  createdAt: string;
}
type Channel = 'in_app' | 'email';
const KIND = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** Security notices cannot be switched off and always go to every channel. */
const isCritical = (kind: string) => kind.startsWith('security.');
const DEFAULTS: Record<Channel, boolean> = { in_app: true, email: false };

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly channels: NotificationChannel[],
    private readonly recipient: (userId: string) => Promise<Recipient | null>,
    private readonly onChannelError: (e: unknown, ch: string, kind: string) => void = () =>
      undefined,
  ) {}

  /** Effective channel settings for one user/kind (defaults overlaid with the user's stored preferences). */
  private async enabled(
    orgId: string,
    userId: string,
    kind: string,
  ): Promise<Record<Channel, boolean>> {
    if (isCritical(kind)) return { in_app: true, email: true };
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query<{ channel: Channel; enabled: boolean }>(
            `SELECT channel, enabled FROM platform.notification_preferences WHERE user_id = $1 AND kind = $2`,
            [userId, kind],
          )
        ).rows,
    );
    const out = { ...DEFAULTS };
    for (const r of rows) out[r.channel] = r.enabled;
    return out;
  }

  /**
   * Deliver to every enabled channel. In-app is the source of truth: its failure propagates; other channels
   * (email) are best-effort and reported through `onChannelError` so one outage never blocks the rest.
   */
  async notify(n: NotificationDraft): Promise<void> {
    if (!KIND.test(n.kind)) throw new Error(`invalid notification kind: ${n.kind}`);
    const on = await this.enabled(n.orgId, n.userId, n.kind);
    const to = await this.recipient(n.userId);
    if (!to) return;
    for (const ch of this.channels) {
      if (!on[ch.name]) continue;
      try {
        await ch.deliver(n, to);
      } catch (e) {
        if (ch.name === 'in_app') throw e;
        this.onChannelError(e, ch.name, n.kind);
      }
    }
  }

  async setPreference(
    orgId: string,
    userId: string,
    kind: string,
    channel: Channel,
    enabled: boolean,
  ) {
    if (!KIND.test(kind) || !(channel in DEFAULTS))
      throw new ProblemException('validation_failed', 'unknown kind or channel');
    if (isCritical(kind))
      throw new ProblemException('conflict', 'security notifications cannot be disabled');
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `INSERT INTO platform.notification_preferences (org_id, user_id, kind, channel, enabled) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, user_id, kind, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [orgId, userId, kind, channel, enabled],
      ),
    );
  }

  async list(
    orgId: string,
    userId: string,
    o: { unreadOnly: boolean; limit: number; cursor?: string | null },
  ): Promise<Page<NotificationItem> & { unreadCount: number }> {
    const cur = decodeCursor(o.cursor);
    const { rows, unread } = await this.db.withOrg(
      orgId,
      async (c) => ({
        rows: (
          await c.query(
            `SELECT id, kind, body, read_at, created_at FROM platform.notifications
              WHERE user_id = $1 AND ($2::boolean = false OR read_at IS NULL) AND ($3::uuid IS NULL OR id < $3)
              ORDER BY id DESC LIMIT $4`,
            [userId, o.unreadOnly, cur, o.limit + 1],
          )
        ).rows,
        unread: (
          await c.query(
            `SELECT count(*)::int n FROM platform.notifications WHERE user_id = $1 AND read_at IS NULL`,
            [userId],
          )
        ).rows[0]!.n as number,
      }),
      { userId },
    );
    const items = rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      params: (r.body as { params?: unknown }).params ?? {},
      readAt: r.read_at ? (r.read_at as Date).toISOString() : null,
      createdAt: (r.created_at as Date).toISOString(),
    }));
    return { ...pageOf(items, o.limit), unreadCount: unread };
  }

  /** 404 for unknown OR someone else's notification. */
  async setRead(
    orgId: string,
    userId: string,
    id: string,
    read: boolean,
  ): Promise<NotificationItem> {
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE platform.notifications SET read_at = CASE WHEN $3 THEN COALESCE(read_at, now()) ELSE NULL END
              WHERE id = $1 AND user_id = $2 RETURNING id, kind, body, read_at, created_at`,
            [id, userId, read],
          )
        ).rows[0],
      { userId },
    );
    if (!row) throw new ProblemException('not_found');
    return {
      id: row.id,
      kind: row.kind,
      params: row.body.params ?? {},
      readAt: row.read_at ? row.read_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    };
  }
}
