import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { HostingConfig } from './config';
import type { BackupSink, HostingAdapter } from './ports';
import type { SitesService } from './sites.service';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

export type AlertKind =
  | 'capacity_low'
  | 'activation_failed'
  | 'activation_stuck'
  | 'certificate_expiring'
  | 'certificate_failed'
  | 'backup_failed'
  | 'backup_missing'
  | 'backup_host_unreachable'
  | 'panel_unreachable'
  | 'wordpress_failed'
  | 'restore_drill_failed';
export interface AlertDto {
  id: string;
  kind: AlertKind;
  severity: 'info' | 'warning' | 'critical';
  summary: string;
  nodeId: string | null;
  siteId: string | null;
  detail: Record<string, unknown>;
  state: 'open' | 'resolved';
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}
interface Found {
  kind: AlertKind;
  scope: string;
  severity: AlertDto['severity'];
  summary: string;
  nodeId?: string;
  siteId?: string;
  orgId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Operational monitoring of the hosting layer (master prompt S06): capacity, activation failures, certificates, backups, the backup store and the panel link. Each `sweep()` COMPUTES the set
 * of conditions that hold now, opens one row per (kind, scope) (the partial unique index makes opening idempotent: no duplicate alert, no flood) and RESOLVES the open rows whose condition
 * is gone. Alerts are admin-scope; no customer sees them. Thresholds are PROPOSALS (HOSTING_* env, defaults below) until the owner sets them.
 */
export class MonitorService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly adapter: HostingAdapter,
    private readonly sink: BackupSink,
    private readonly sites: SitesService,
    private readonly cfg: HostingConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly o: {
      capacityWarnPercent: number;
      capacityCriticalPercent: number;
      activationStuckMinutes: number;
      certificateWarnDays: number;
      backupMaxAgeHours: number;
    } = {
      capacityWarnPercent: Number(process.env.HOSTING_ALERT_CAPACITY_WARN_PERCENT ?? 80),
      capacityCriticalPercent: Number(process.env.HOSTING_ALERT_CAPACITY_CRITICAL_PERCENT ?? 95),
      activationStuckMinutes: Number(process.env.HOSTING_ALERT_ACTIVATION_STUCK_MINUTES ?? 20),
      certificateWarnDays: Number(process.env.HOSTING_ALERT_CERTIFICATE_DAYS ?? 7),
      backupMaxAgeHours: Number(process.env.HOSTING_ALERT_BACKUP_MAX_AGE_HOURS ?? 36),
    },
  ) {}

  private dto(r: Row): AlertDto {
    return {
      id: r.id as string,
      kind: r.kind as AlertKind,
      severity: r.severity as AlertDto['severity'],
      summary: r.summary as string,
      nodeId: (r.node_id as string | null) ?? null,
      siteId: (r.site_id as string | null) ?? null,
      detail: (r.detail as Record<string, unknown>) ?? {},
      state: r.state as AlertDto['state'],
      openedAt: iso(r.opened_at)!,
      lastSeenAt: iso(r.last_seen_at)!,
      resolvedAt: iso(r.resolved_at),
    };
  }
  async list(
    state: 'open' | 'resolved' | 'all' = 'open',
    limit = 100,
  ): Promise<{ items: AlertDto[] }> {
    if (!['open', 'resolved', 'all'].includes(state))
      throw new ProblemException('validation_failed', 'state must be open, resolved or all');
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.monitor_alerts WHERE ($1 = 'all' OR state = $1) ORDER BY (state = 'open') DESC, opened_at DESC, id DESC LIMIT $2`,
            [state, limit],
          )
        ).rows,
    );
    return { items: rows.map((r) => this.dto(r)) };
  }

  /* ───────────── the conditions ───────────── */
  private async capacity(out: Found[]) {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT n.id, n.name, k.dim, k.sellable, k.reserved FROM hosting.node_capacity k JOIN hosting.nodes n ON n.id = k.node_id
              WHERE n.status = 'active' AND n.purpose = 'customer' AND k.sellable > 0`,
          )
        ).rows,
    );
    for (const r of rows) {
      const pct = (Number(r.reserved) * 100) / Number(r.sellable);
      if (pct >= this.o.capacityWarnPercent)
        out.push({
          kind: 'capacity_low',
          scope: `${r.id as string}:${r.dim as string}`,
          severity: pct >= this.o.capacityCriticalPercent ? 'critical' : 'warning',
          summary: `node ${r.name as string}: ${r.dim as string} ${Math.floor(pct)}% reserved`,
          nodeId: r.id as string,
          detail: { dim: r.dim, percent: Math.floor(pct) },
        });
    }
  }
  private async activation(out: Found[], now: Date) {
    const failed = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, name FROM hosting.sites WHERE status = 'failed' AND updated_at > $1::timestamptz - interval '7 days'`,
            [now],
          )
        ).rows,
    );
    for (const s of failed)
      out.push({
        kind: 'activation_failed',
        scope: s.id as string,
        severity: 'critical',
        summary: `site activation failed: ${s.name as string}`,
        siteId: s.id as string,
        orgId: s.org_id as string,
      });
    const stuck = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, name FROM hosting.sites WHERE status = 'creating' AND created_at < $1::timestamptz - make_interval(mins => $2)`,
            [now, this.o.activationStuckMinutes],
          )
        ).rows,
    );
    for (const s of stuck)
      out.push({
        kind: 'activation_stuck',
        scope: s.id as string,
        severity: 'warning',
        summary: `site still creating after ${this.o.activationStuckMinutes} minutes: ${s.name as string}`,
        siteId: s.id as string,
        orgId: s.org_id as string,
      });
    const wp = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT a.site_id, a.org_id, a.last_error FROM hosting.site_apps a WHERE a.state = 'failed' OR (a.state IN ('pending','installing') AND a.updated_at < $1::timestamptz - make_interval(mins => $2))`,
            [now, this.o.activationStuckMinutes * 2],
          )
        ).rows,
    );
    for (const a of wp)
      out.push({
        kind: 'wordpress_failed',
        scope: a.site_id as string,
        severity: 'warning',
        summary: 'WordPress installation failed or is stuck',
        siteId: a.site_id as string,
        orgId: a.org_id as string,
        detail: { error: a.last_error },
      });
  }
  private async certificates(out: Found[], now: Date) {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, site_id, org_id, status, not_after FROM hosting.ssl_certificates
              WHERE (status = 'failed' AND updated_at > $1::timestamptz - interval '14 days') OR (status = 'issued' AND not_after < $1::timestamptz + make_interval(days => $2))`,
            [now, this.o.certificateWarnDays],
          )
        ).rows,
    );
    for (const r of rows)
      out.push(
        r.status === 'failed'
          ? {
              kind: 'certificate_failed',
              scope: r.id as string,
              severity: 'warning',
              summary: 'a certificate could not be issued',
              siteId: r.site_id as string,
              orgId: r.org_id as string,
            }
          : {
              kind: 'certificate_expiring',
              scope: r.id as string,
              severity: 'critical',
              summary: `a certificate expires ${iso(r.not_after)} and was not renewed`,
              siteId: r.site_id as string,
              orgId: r.org_id as string,
            },
      );
  }
  private async backups(out: Found[], now: Date) {
    if (this.sink.kind === 'none') return;
    const failed = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT DISTINCT ON (site_id) id, site_id, org_id FROM hosting.site_backups WHERE status = 'failed' AND kind IN ('scheduled','on_demand') AND created_at > $1::timestamptz - interval '24 hours' ORDER BY site_id, created_at DESC`,
            [now],
          )
        ).rows,
    );
    for (const b of failed)
      out.push({
        kind: 'backup_failed',
        scope: b.site_id as string,
        severity: 'warning',
        summary: 'a backup failed in the last 24 hours',
        siteId: b.site_id as string,
        orgId: b.org_id as string,
      });
    const missing = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.id, s.org_id, s.name FROM hosting.sites s JOIN hosting.site_quotas q ON q.site_id = s.id AND q.dim = 'backup_count' AND q.limit_value > 0
              WHERE s.status = 'active' AND s.created_at < $1::timestamptz - make_interval(hours => $2)
                AND NOT EXISTS (SELECT 1 FROM hosting.site_backups b WHERE b.site_id = s.id AND b.status = 'available' AND b.kind IN ('scheduled','on_demand') AND b.created_at > $1::timestamptz - make_interval(hours => $2))
              LIMIT 200`,
            [now, this.o.backupMaxAgeHours],
          )
        ).rows,
    );
    for (const s of missing)
      out.push({
        kind: 'backup_missing',
        scope: s.id as string,
        severity: 'warning',
        summary: `no backup in the last ${this.o.backupMaxAgeHours} hours: ${s.name as string}`,
        siteId: s.id as string,
        orgId: s.org_id as string,
      });
    const drills = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, site_id, org_id FROM hosting.restore_drills WHERE state = 'failed' AND finished_at > $1::timestamptz - interval '14 days'`,
            [now],
          )
        ).rows,
    );
    for (const d of drills)
      out.push({
        kind: 'restore_drill_failed',
        scope: d.id as string,
        severity: 'critical',
        summary: 'a restore drill failed: the backups of this site may not be restorable',
        siteId: d.site_id as string,
        orgId: d.org_id as string,
      });
    if (this.sink.health) {
      const regions = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `SELECT DISTINCT data_region FROM hosting.nodes WHERE status <> 'retired'`,
            )
          ).rows,
      );
      for (const r of regions) {
        const h = await this.sink
          .health(r.data_region as string)
          .catch(() => ({ ok: false, detail: 'the check itself failed' }));
        if (!h.ok)
          out.push({
            kind: 'backup_host_unreachable',
            scope: r.data_region as string,
            severity: 'critical',
            summary: `the backup store of ${r.data_region as string} is not reachable`,
            detail: { region: r.data_region, detail: h.detail },
          });
      }
    }
  }
  /** The panel link: a live health call per node that takes (or could take) sites; the result is also written to `nodes.health` so the admin list shows it. */
  private async panels(out: Found[]) {
    const nodes = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, name, compute_instance_id, status, health FROM hosting.nodes WHERE status IN ('active','draining','maintenance') AND panel_host IS NOT NULL`,
          )
        ).rows,
    );
    for (const n of nodes) {
      const h = await this.adapter
        .health(this.sites.ctx(`monitor-${n.id as string}`), {
          nodeId: n.id as string,
          computeInstanceId: n.compute_instance_id as string,
        })
        .catch(() => ({ state: 'unhealthy' as const, detail: 'check failed' }));
      if (h.state !== 'unknown' && h.state !== n.health)
        await this.db.withPlatformScope((c) =>
          c.query(`UPDATE hosting.nodes SET health = $2, updated_at = now() WHERE id = $1`, [
            n.id,
            h.state,
          ]),
        );
      if (h.state === 'unhealthy' || h.state === 'degraded')
        out.push({
          kind: 'panel_unreachable',
          scope: n.id as string,
          severity: h.state === 'unhealthy' ? 'critical' : 'warning',
          summary: `node ${n.name as string}: the panel link is ${h.state}${h.detail ? ` (${h.detail})` : ''}`,
          nodeId: n.id as string,
          detail: { state: h.state, detail: h.detail ?? null },
        });
    }
  }

  /* ───────────── the sweep ───────────── */
  async sweep(now = this.clock()): Promise<{ open: number; opened: number; resolved: number }> {
    const found: Found[] = [];
    // one failing probe must not blind the others, and must not resolve alerts it could not re-check: only kinds of probes that RAN are ever resolved
    const covered = new Set<AlertKind>();
    const probe = async (kinds: AlertKind[], f: () => Promise<void>) => {
      try {
        await f();
        kinds.forEach((k) => covered.add(k));
      } catch {
        /* its alerts stay as they are */
      }
    };
    await probe(['capacity_low'], () => this.capacity(found));
    await probe(['activation_failed', 'activation_stuck', 'wordpress_failed'], () =>
      this.activation(found, now),
    );
    await probe(['certificate_expiring', 'certificate_failed'], () =>
      this.certificates(found, now),
    );
    await probe(
      ['backup_failed', 'backup_missing', 'restore_drill_failed', 'backup_host_unreachable'],
      () => this.backups(found, now),
    );
    await probe(['panel_unreachable'], () => this.panels(found));
    let opened = 0;
    for (const f of found) {
      const r = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `INSERT INTO hosting.monitor_alerts (id, kind, severity, scope_key, node_id, site_id, org_id, summary, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
               ON CONFLICT (kind, scope_key) WHERE state = 'open' DO UPDATE SET last_seen_at = now(), severity = EXCLUDED.severity, summary = EXCLUDED.summary, detail = EXCLUDED.detail
               RETURNING (xmax = 0) AS inserted`,
              [
                uuidv7(),
                f.kind,
                f.severity,
                f.scope,
                f.nodeId ?? null,
                f.siteId ?? null,
                f.orgId ?? null,
                f.summary.slice(0, 200),
                JSON.stringify(f.detail ?? {}),
              ],
            )
          ).rows[0],
      );
      if (r?.inserted) {
        opened++;
        await this.audit.record({
          action: 'hosting.alert.opened',
          actorType: 'system',
          ...(f.orgId ? { orgId: f.orgId } : {}),
          resource: { type: 'hosting_alert', id: f.scope },
          outcome: 'failure',
          detail: { kind: f.kind, severity: f.severity },
        });
      }
    }
    // conditions that no longer hold: resolved (a kind this sweep could not evaluate is not resolved: only kinds whose probe ran are touched)
    const keys = found.map((f) => `${f.kind}|${f.scope}`);
    const resolved = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE hosting.monitor_alerts SET state = 'resolved', resolved_at = now() WHERE state = 'open' AND kind = ANY($2::text[]) AND NOT ((kind || '|' || scope_key) = ANY($1::text[]))`,
            [keys, [...covered]],
          )
        ).rowCount ?? 0,
    );
    const open = Number(
      (
        await this.db.withPlatformScope(
          async (c) =>
            (
              await c.query(
                `SELECT count(*)::int AS n FROM hosting.monitor_alerts WHERE state = 'open'`,
              )
            ).rows[0]!,
        )
      ).n,
    );
    return { open, opened, resolved };
  }
}
