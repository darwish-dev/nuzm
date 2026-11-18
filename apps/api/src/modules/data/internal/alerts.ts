import { enqueue, type Db } from '@nuzm/platform';
import type { NotificationService } from '../../notifications';

export interface DataAlert {
  /** `<domain>.<topic>`, e.g. `data.restore_verification_failed`. */
  kind: string;
  severity: 'warning' | 'critical';
  resource: { type: string; id: string };
  /** Non-sensitive facts only (ids, counts, codes): never addresses, secrets or content. */
  detail: Record<string, unknown>;
  /** Permission whose holders are told (default: the organization's database admins). */
  audiencePermission?: string;
}

/**
 * Raises an alert: an `ops.alert` outbox event (what the ops console of M12 will consume) and an in-app notification to the organization members who
 * can act on it. A failing notification never hides the alert: the outbox row commits first.
 */
export class DataAlerts {
  readonly raised: DataAlert[] = [];
  constructor(
    private readonly db: Db,
    private readonly notifications: Pick<NotificationService, 'notify'> | null,
  ) {}
  async raise(orgId: string, a: DataAlert): Promise<void> {
    this.raised.push(a);
    await this.db.withOrg(orgId, (c) =>
      enqueue(c, orgId, 'ops.alert', {
        kind: a.kind,
        severity: a.severity,
        resource: a.resource,
        detail: a.detail,
      }),
    );
    if (!this.notifications) return;
    const perm = a.audiencePermission ?? 'data:db:admin';
    const users = await this.db.withOrg(orgId, async (c) =>
      (
        await c.query<{ user_id: string }>(
          `SELECT DISTINCT m.user_id FROM tenancy.memberships m JOIN tenancy.role_permissions rp ON rp.role = m.role AND rp.permission = $2 WHERE m.org_id = $1`,
          [orgId, perm],
        )
      ).rows.map((r) => r.user_id),
    );
    for (const userId of users)
      await this.notifications
        .notify({
          orgId,
          userId,
          kind: a.kind,
          params: {
            severity: a.severity,
            resourceType: a.resource.type,
            resourceId: a.resource.id,
            ...a.detail,
          },
        })
        .catch(() => undefined);
  }
}
