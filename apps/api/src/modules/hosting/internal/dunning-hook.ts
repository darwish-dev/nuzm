import type { Db } from '@nuzm/platform';
import type { SitesService } from './sites.service';

/**
 * Suspension on non-payment through M03 dunning (M06 §10, AC-M06-11). The dunning policy only REQUESTS (`dunning.suspend_requested`, no data is touched): this hook is
 * the hosting module deciding what that means. An organization with an OPEN dunning case in stage `suspended` or `terminated_pending` (and no hold) has every active site
 * suspended with reason code `dunning`; when the case closes (paid) or is put on hold, the sites suspended BY dunning are reinstated. Sites suspended for another reason
 * (abuse, staff, quota) are never touched by this hook. Reads `billing.dunning_cases` under the platform scope (read only).
 */
export class DunningHook {
  constructor(
    private readonly db: Db,
    private readonly sites: SitesService,
  ) {}
  async reconcile(): Promise<{ suspended: number; reinstated: number }> {
    const blocked = new Set(
      await this.db.withPlatformScope(async (c) =>
        (
          await c.query(
            `SELECT DISTINCT org_id FROM billing.dunning_cases WHERE closed_at IS NULL AND NOT hold AND stage IN ('suspended','terminated_pending')`,
          )
        ).rows.map((r) => r.org_id as string),
      ),
    );
    const live = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, status, suspended_by FROM hosting.sites WHERE status = 'active' OR (status = 'suspended' AND suspended_by = 'dunning')`,
          )
        ).rows,
    );
    const out = { suspended: 0, reinstated: 0 };
    for (const s of live) {
      if (blocked.has(s.org_id as string) && s.status === 'active') {
        await this.sites
          .setSuspended(
            null,
            s.id as string,
            true,
            'dunning',
            'unpaid invoice: dunning stage reached suspension',
          )
          .then(() => out.suspended++)
          .catch(() => undefined);
      } else if (!blocked.has(s.org_id as string) && s.status === 'suspended') {
        await this.sites
          .setSuspended(null, s.id as string, false, 'dunning', 'the dunning case is closed')
          .then(() => out.reinstated++)
          .catch(() => undefined);
      }
    }
    return out;
  }
}
