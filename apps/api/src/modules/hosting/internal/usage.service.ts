import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { HostingConfig } from './config';
import type { HostingAdapter, SiteUsage } from './ports';
import type { SitesService } from './sites.service';

type Row = Record<string, unknown>;
const MIB = 1_048_576;
const GB = 1_000_000_000;

export interface UsageDto {
  period: string;
  diskMb: number;
  inodes: number;
  bandwidthGbMonth: number;
  backupGb: number;
  processes: number;
  observedAt: string | null;
  quotas: { dim: string; used: number; soft: number; limit: number; state: string }[];
}
export interface Notify {
  (orgId: string, kind: string, params: Record<string, unknown>): Promise<void>;
}

/** The month a usage observation belongs to (UTC): `2026-11`. */
export const periodOf = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Usage reporting and quota enforcement (M06 §4 tasks 10-11).
 *  - the agent reports usage (disk, inodes, cumulative monthly bandwidth from per-site access logs, processes); the latest hourly row is the site's usage;
 *  - quotas: soft warning at `soft_limit` (default 80 %), hard at the limit (100 %): disk/inodes are enforced ON THE NODE (`quota.apply` filesystem quotas), a hard
 *    bandwidth limit suspends the site (reason code `quota`), a hard backup limit refuses new backups (BackupService);
 *  - each threshold notifies the organization's owners and admins ONCE (`quota_events` UNIQUE (site, dim, threshold, period) is the arbiter); dropping back below
 *    the soft limit re-arms a non-monthly dimension.
 */
export class UsageService {
  /** Called with every fresh report BEFORE the quotas are evaluated (metering delta, abuse detectors): registered by the module. */
  readonly afterReport: ((siteId: string, data: SiteUsage) => Promise<unknown>)[] = [];
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly sites: SitesService,
    private readonly adapter: HostingAdapter,
    private readonly cfg: HostingConfig,
    private readonly notify: Notify,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Ask the node for the usage of ONE site, store the hourly row, evaluate the quotas. */
  async collect(siteId: string): Promise<UsageDto | null> {
    const site = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.*, n.compute_instance_id FROM hosting.sites s JOIN hosting.nodes n ON n.id = s.node_id WHERE s.id = $1 AND s.status IN ('active','suspended')`,
            [siteId],
          )
        ).rows[0],
    );
    if (!site) return null;
    const r = await this.adapter.usage(
      this.sites.ctx(`usage-${siteId}`),
      { nodeId: site.node_id as string, computeInstanceId: site.compute_instance_id as string },
      site.node_name as string,
    );
    if (r.status !== 'succeeded' || !r.data) return null;
    const now = this.clock();
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const orgId = site.org_id as string;
    const backupBytes = await this.db.withPlatformScope(async (c) =>
      Number(
        (
          await c.query(
            `SELECT coalesce(sum(size_bytes),0)::bigint AS b FROM hosting.site_backups WHERE site_id = $1 AND status = 'available'`,
            [siteId],
          )
        ).rows[0]!.b,
      ),
    );
    await this.db.withPlatformScope((c) =>
      c.query(
        `INSERT INTO hosting.site_usage_reports (site_id, org_id, period_start, disk_bytes, inodes, bandwidth_bytes_month, backup_bytes, processes, cpu_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (site_id, period_start) DO UPDATE SET disk_bytes = EXCLUDED.disk_bytes, inodes = EXCLUDED.inodes, bandwidth_bytes_month = EXCLUDED.bandwidth_bytes_month, backup_bytes = EXCLUDED.backup_bytes, processes = EXCLUDED.processes, cpu_seconds = EXCLUDED.cpu_seconds, reported_at = now()`,
        [
          siteId,
          orgId,
          hour,
          r.data!.diskBytes,
          r.data!.inodes,
          r.data!.bandwidthBytesMonth,
          backupBytes,
          r.data!.processes,
          r.data!.cpuSeconds,
        ],
      ),
    );
    for (const h of this.afterReport) await h(siteId, r.data).catch(() => undefined);
    await this.evaluate(siteId, now);
    return this.read(orgId, siteId);
  }
  /** Hourly sweep over every live site. */
  async collectAll(): Promise<{ sites: number; failed: number }> {
    const ids = await this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT id FROM hosting.sites WHERE status IN ('active','suspended') ORDER BY id LIMIT 5000`,
        )
      ).rows.map((r) => r.id as string),
    );
    let failed = 0;
    for (const id of ids) if (!(await this.collect(id).catch(() => null))) failed++;
    return { sites: ids.length, failed };
  }

  /** Customer read: `GET /v1/hosting/sites/{id}/usage`. */
  async read(orgId: string, siteId: string): Promise<UsageDto> {
    await this.sites.row(orgId, siteId);
    return this.db.withOrg(orgId, async (c) => {
      const u = (
        await c.query(
          `SELECT * FROM hosting.site_usage_reports WHERE site_id = $1 ORDER BY period_start DESC LIMIT 1`,
          [siteId],
        )
      ).rows[0] as Row | undefined;
      const q = (
        await c.query(
          `SELECT dim, limit_value, soft_limit, state FROM hosting.site_quotas WHERE site_id = $1 ORDER BY dim`,
          [siteId],
        )
      ).rows;
      const used = (dim: string): number => {
        if (!u) return 0;
        switch (dim) {
          case 'disk_mb':
            return Math.ceil(Number(u.disk_bytes) / MIB);
          case 'inodes':
            return Number(u.inodes);
          case 'bandwidth_gb':
            return Number(u.bandwidth_bytes_month) / GB;
          case 'processes':
            return Number(u.processes);
          case 'backup_gb':
            return Number(u.backup_bytes) / GB;
          default:
            return 0;
        }
      };
      return {
        period: periodOf(u ? (u.period_start as Date) : this.clock()),
        diskMb: used('disk_mb'),
        inodes: used('inodes'),
        bandwidthGbMonth: Math.round(used('bandwidth_gb') * 1000) / 1000,
        backupGb: Math.round(used('backup_gb') * 1000) / 1000,
        processes: used('processes'),
        observedAt: u ? (u.reported_at as Date).toISOString() : null,
        quotas: q.map((r) => ({
          dim: r.dim as string,
          used: Math.round(used(r.dim as string) * 1000) / 1000,
          soft: Number(r.soft_limit),
          limit: Number(r.limit_value),
          state: r.state as string,
        })),
      };
    });
  }

  /** Evaluate one site against its quotas; emits each threshold once and applies the hard actions. */
  async evaluate(siteId: string, now = this.clock()): Promise<{ soft: string[]; hard: string[] }> {
    const row = await this.db.withPlatformScope(async (c) => {
      const s = (
        await c.query(`SELECT id, org_id, status, name FROM hosting.sites WHERE id = $1`, [siteId])
      ).rows[0];
      if (!s) return null;
      const u = (
        await c.query(
          `SELECT * FROM hosting.site_usage_reports WHERE site_id = $1 ORDER BY period_start DESC LIMIT 1`,
          [siteId],
        )
      ).rows[0];
      const q = (await c.query(`SELECT * FROM hosting.site_quotas WHERE site_id = $1`, [siteId]))
        .rows;
      return { s, u, q };
    });
    const out = { soft: [] as string[], hard: [] as string[] };
    if (!row || !row.u) return out;
    const orgId = row.s.org_id as string;
    const period = periodOf(now);
    const value = (dim: string): number | null => {
      switch (dim) {
        case 'disk_mb':
          return Math.ceil(Number(row.u.disk_bytes) / MIB);
        case 'inodes':
          return Number(row.u.inodes);
        case 'bandwidth_gb':
          return Number(row.u.bandwidth_bytes_month) / GB;
        case 'processes':
          return Number(row.u.processes);
        case 'backup_gb':
          return Number(row.u.backup_bytes) / GB;
        default:
          return null; // db_count / memory_mb / backup_count are checked where they are consumed
      }
    };
    for (const q of row.q) {
      const dim = q.dim as string;
      const v = value(dim);
      if (v === null) continue;
      const limit = Number(q.limit_value);
      const soft = Number(q.soft_limit);
      const state = limit > 0 && v >= limit ? 'hard' : soft > 0 && v >= soft ? 'soft' : 'ok';
      const evPeriod = dim === 'bandwidth_gb' ? period : '';
      if (state !== q.state)
        await this.db.withPlatformScope((c) =>
          c.query(
            `UPDATE hosting.site_quotas SET state = $3, enforced_at = now() WHERE site_id = $1 AND dim = $2`,
            [siteId, dim, state],
          ),
        );
      if (state === 'ok' && evPeriod === '')
        await this.db
          .withPlatformScope((c) =>
            c.query(
              `DELETE FROM hosting.quota_events WHERE site_id = $1 AND dim = $2 AND period = ''`,
              [siteId, dim],
            ),
          )
          .catch(() => undefined); // re-arm
      for (const threshold of ['soft', 'hard'] as const) {
        if (threshold !== state) continue; // a jump straight to hard notifies the hard threshold only
        const first = await this.db.withPlatformScope(
          async (c) =>
            (
              await c.query(
                `INSERT INTO hosting.quota_events (id, site_id, org_id, dim, threshold, period, observed) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (site_id, dim, threshold, period) DO NOTHING RETURNING id`,
                [uuidv7(), siteId, orgId, dim, threshold, evPeriod, Math.floor(v)],
              )
            ).rowCount,
        );
        if (!first) continue; // already notified for this threshold
        (threshold === 'soft' ? out.soft : out.hard).push(dim);
        await this.audit.record({
          action: `hosting.quota.${threshold}`,
          actorType: 'system',
          orgId,
          resource: { type: 'hosting_site', id: siteId },
          outcome: 'success',
          detail: { dim, observed: Math.round(v * 1000) / 1000, limit },
        });
        await this.notify(orgId, `hosting.quota_${threshold}`, {
          site: row.s.name as string,
          dim,
          used: Math.round(v * 100) / 100,
          limit,
        });
        // hard bandwidth: the plan's monthly transfer is used up: the site is suspended with the reason code `quota`
        if (threshold === 'hard' && dim === 'bandwidth_gb' && row.s.status === 'active')
          await this.sites
            .setSuspended(null, siteId, true, 'quota', 'monthly bandwidth quota reached')
            .catch(() => undefined);
      }
    }
    return out;
  }

  /** A new month re-arms the bandwidth dimension: a site suspended for bandwidth is reinstated (its usage counter restarts at the node). */
  async newPeriodReinstate(now = this.clock()): Promise<number> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.id FROM hosting.sites s JOIN hosting.site_quotas q ON q.site_id = s.id AND q.dim = 'bandwidth_gb' WHERE s.status = 'suspended' AND s.suspended_by = 'quota' AND q.state = 'hard'`,
          )
        ).rows,
    );
    let n = 0;
    for (const r of rows) {
      const latest = await this.collect(r.id as string).catch(() => null);
      if (latest && latest.quotas.find((q) => q.dim === 'bandwidth_gb')?.state !== 'hard') {
        await this.sites
          .setSuspended(null, r.id as string, false, 'quota', `new billing period ${periodOf(now)}`)
          .catch(() => undefined);
        n++;
      }
    }
    return n;
  }
}
export { ProblemException };
