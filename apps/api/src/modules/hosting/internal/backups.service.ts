import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db, OperationsService } from '@nuzm/platform';
import { assertResidency, ResidencyDenied, type ResidencyEvaluator, UUID } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { tokenFor } from './hosting-names';
import type { HostingConfig } from './config';
import type { BackupRef, BackupSink, HostingAdapter } from './ports';
import { KIND, type Caller, type SitesService } from './sites.service';
import { NeedsReconcile, PermanentError, recordStep } from './steps';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

export interface BackupDto {
  id: string;
  kind: string;
  label: string | null;
  status: string;
  sizeBytes: number | null;
  checksum: string | null;
  createdAt: string;
  expiresAt: string | null;
  failureReason: string | null;
  /** false when the archive carries no encryption of its own (HestiaCP): it is protected by the region's off-server store instead (ADR-068) */
  encrypted: boolean;
}

/**
 * Backups, restores and expiring download links (M06 §4 task 12).
 *  - every site has its OWN encryption key (vault ref on the site) for adapters whose archives are encrypted on the node; HestiaCP's archives are NOT (nothing documents it: the row says
 *    `encrypted: false` and the region's off-server store is the protection, ADR-068). The archive is stored OFF the node in the `BackupSink` of the SITE'S region
 *    (M04 hook m06-backup-sink); the row keeps the checksum and a manifest of (path, sha256, bytes), never content or keys;
 *  - `POST /restores` makes a PRE-RESTORE SAFETY BACKUP first, restores, and verifies the checksum; a corrupt archive is detected before anything is overwritten;
 *  - a download link is HMAC-signed, bound to organization + site + backup, and expires; another organization's link or backup id is 404.
 */
export class BackupService {
  private readonly secret: Buffer;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly sites: SitesService,
    private readonly adapter: HostingAdapter,
    private readonly sink: BackupSink,
    private readonly residency: ResidencyEvaluator,
    private readonly cfg: HostingConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly kick: (orgId: string, operationId: string) => void = () => undefined,
    downloadSecret: string | undefined = process.env.HOSTING_DOWNLOAD_SECRET,
  ) {
    this.secret = downloadSecret ? Buffer.from(downloadSecret) : randomBytes(32);
  }

  private dto(r: Row): BackupDto {
    return {
      id: r.id as string,
      kind: r.kind as string,
      label: (r.label as string | null) ?? null,
      status: r.status as string,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      checksum: (r.checksum as string | null) ?? null,
      createdAt: iso(r.created_at)!,
      expiresAt: iso(r.expires_at),
      failureReason: (r.failure_reason as string | null) ?? null,
      encrypted:
        ((r.provider_state as { encrypted?: boolean } | null)?.encrypted ?? true) !== false,
    };
  }

  /* ───────────── create ───────────── */
  async request(
    orgId: string,
    actor: Caller,
    siteId: string,
    body: Record<string, unknown>,
  ): Promise<{ backup: BackupDto; operationId: string }> {
    await this.sites.row(orgId, siteId); // the site first: another organization's id is a 404 whatever the body says
    for (const k of Object.keys(body))
      if (k !== 'label') throw new ProblemException('validation_failed', `unknown member ${k}`);
    const label = body.label;
    if (
      label !== undefined &&
      (typeof label !== 'string' || label.length < 1 || label.length > 100)
    )
      throw new ProblemException('validation_failed', 'label must be 1..100 characters');
    const site = await this.sites.row(orgId, siteId);
    if (site.status !== 'active')
      throw new ProblemException('site_not_active', 'only an active site can be backed up');
    this.requireSink();
    await this.requireResidency(orgId, site.data_region as string);
    await this.requireQuota(orgId, siteId);
    return this.insertAndQueue(
      orgId,
      actor.userId,
      site,
      'on_demand',
      (label as string | undefined) ?? null,
    );
  }
  private requireSink() {
    if (this.sink.kind === 'none')
      throw new ProblemException(
        'no_backup_sink',
        'no backup sink is configured: production backups wait for the D-07 / P-M06-1 decision',
      );
  }
  private async requireResidency(orgId: string, region: string) {
    try {
      // M04 hook m06-backup-sink: the sink region equals the site region and must be allowed for this organization
      await assertResidency(this.residency, {
        orgId,
        dataClass: 'customer-content',
        targetRegion: region,
        purpose: 'hosting_backup',
        operation: 'write',
      });
    } catch (e) {
      if (e instanceof ResidencyDenied)
        throw new ProblemException(
          'residency_denied',
          'the data residency policy does not allow storing this backup',
        );
      throw e;
    }
  }
  private async requireQuota(orgId: string, siteId: string) {
    const q = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT dim, limit_value FROM hosting.site_quotas WHERE site_id = $1 AND dim IN ('backup_count','backup_gb')`,
            [siteId],
          )
        ).rows,
    );
    const used = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int AS n, coalesce(sum(size_bytes),0)::bigint AS bytes FROM hosting.site_backups WHERE site_id = $1 AND status IN ('creating','available') AND kind IN ('on_demand','scheduled')`,
            [siteId],
          )
        ).rows[0]!,
    );
    const count = q.find((x) => x.dim === 'backup_count');
    const gb = q.find((x) => x.dim === 'backup_gb');
    if (count && Number(used.n) >= Number(count.limit_value))
      throw new ProblemException(
        'quota_exceeded',
        `the backup count limit (${String(count.limit_value)}) is reached`,
      );
    if (gb && Number(used.bytes) >= Number(gb.limit_value) * 1e9)
      throw new ProblemException(
        'quota_exceeded',
        `the backup size limit (${String(gb.limit_value)} GB) is reached`,
      );
  }
  private async insertAndQueue(
    orgId: string,
    userId: string | null,
    site: Row,
    kind: string,
    label: string | null,
  ) {
    const id = uuidv7();
    const expires = new Date(this.clock().getTime() + this.cfg.backupRetentionDays * 86_400_000);
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `INSERT INTO hosting.site_backups (id, site_id, org_id, kind, label, enc_key_ref, sink_kind, data_region, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [
              id,
              site.id,
              orgId,
              kind,
              label,
              site.backup_key_ref,
              this.sink.kind === 'none' ? null : this.sink.kind,
              site.data_region,
              userId,
              expires,
            ],
          )
        ).rows[0]!,
    );
    const op = await this.ops.create(orgId, {
      kind: KIND.backup,
      input: { siteId: site.id as string, backupId: id },
      resourceKind: 'hosting_site',
      resourceId: site.id as string,
      createdBy: userId ?? undefined,
      maxAttempts: 4,
    });
    await this.audit.record({
      action: 'hosting.backup.requested',
      actorUserId: userId ?? undefined,
      actorType: userId ? 'user' : 'system',
      orgId,
      resource: { type: 'hosting_backup', id },
      outcome: 'success',
      detail: { kind },
    });
    this.kick(orgId, op.id);
    return { backup: this.dto(row), operationId: op.id };
  }

  async list(orgId: string, siteId: string, limit = 50): Promise<{ items: BackupDto[] }> {
    await this.sites.row(orgId, siteId);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.site_backups WHERE site_id = $1 AND org_id = $2 AND status <> 'deleted' AND kind <> 'pre_restore' ORDER BY created_at DESC, id DESC LIMIT $3`,
            [siteId, orgId, limit],
          )
        ).rows,
    );
    return { items: rows.map((r) => this.dto(r)) };
  }
  async get(orgId: string, siteId: string, backupId: string): Promise<BackupDto> {
    return this.dto(await this.rowOf(orgId, siteId, backupId));
  }
  private async rowOf(orgId: string, siteId: string, backupId: string): Promise<Row> {
    if (!UUID.test(siteId) || !UUID.test(backupId))
      throw new ProblemException('not_found', 'backup not found');
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.site_backups WHERE id = $1 AND site_id = $2 AND org_id = $3`,
            [backupId, siteId, orgId],
          )
        ).rows[0],
    );
    if (!r) throw new ProblemException('not_found', 'backup not found'); // another organization's id: RLS hides it: 404, never 403
    return r;
  }

  /** Operation handler `hosting.backup.create`. */
  async execute(o: {
    orgId: string;
    operationId: string;
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const backupId = o.input.backupId as string;
    const b = await this.db.withOrg(
      o.orgId,
      async (c) =>
        (await c.query(`SELECT * FROM hosting.site_backups WHERE id = $1`, [backupId])).rows[0],
    );
    if (!b) throw new PermanentError('the backup row is gone');
    if (b.status === 'available') return { backupId, status: 'available' };
    const site = await this.siteWithNode(o.input.siteId as string);
    await this.db.withOrg(o.orgId, (c) =>
      recordStep(c, o.orgId, o.operationId, 'archive', 'running'),
    );
    const ref = {
      nodeId: site.node_id as string,
      computeInstanceId: site.compute_instance_id as string,
    };
    // idempotency across retries and restarts: what existed BEFORE the schedule and whether the schedule was sent are persisted first (a retry only waits, never schedules twice)
    const st = { ...((b.provider_state as Record<string, unknown> | null) ?? {}) } as {
      known?: string[];
      scheduledAt?: string;
    };
    const save = (extra: Record<string, unknown> = {}) =>
      this.db.withOrg(o.orgId, (c) =>
        c.query(
          `UPDATE hosting.site_backups SET provider_state = provider_state || $2::jsonb WHERE id = $1`,
          [backupId, JSON.stringify({ ...st, ...extra })],
        ),
      );
    if (this.adapter.listBackups && !st.known) {
      const l = await this.adapter.listBackups(
        this.sites.ctx(o.operationId),
        ref,
        site.node_name as string,
      );
      if (l.status !== 'succeeded' || !l.data)
        throw new Error(
          `the archive list could not be read: ${l.error?.message ?? 'unknown'}`.slice(0, 200),
        );
      st.known = l.data.map((x) => x.name);
      await save();
    }
    const scheduleAllowed = !st.scheduledAt;
    if (scheduleAllowed) {
      st.scheduledAt = this.clock().toISOString();
      await save();
    }
    const r = await this.adapter.backup(
      this.sites.ctx(o.operationId),
      ref,
      site.node_name as string,
      {
        idempotencyToken: tokenFor(o.orgId, backupId, 'backup'),
        operationId: o.operationId,
        backupId,
        ...(st.known ? { known: st.known, scheduleAllowed } : {}),
      },
    );
    if (r.status === 'uncertain')
      throw new NeedsReconcile('the backup answer was lost: the archive may exist in the sink');
    if (r.status !== 'succeeded' || !r.data) {
      const reason = (r.error?.message ?? 'backup failed').slice(0, 190);
      await this.db.withOrg(o.orgId, (c) =>
        c.query(
          `UPDATE hosting.site_backups SET status = 'failed', failure_reason = $2 WHERE id = $1`,
          [backupId, reason],
        ),
      );
      await this.audit.record({
        action: 'hosting.backup.failed',
        actorType: 'system',
        orgId: o.orgId,
        resource: { type: 'hosting_backup', id: backupId },
        outcome: 'failure',
        detail: { reason },
      });
      throw new PermanentError(reason, r.error?.providerCode);
    }
    const d: BackupRef = r.data;
    await this.db.withOrg(o.orgId, (c) =>
      c.query(
        `UPDATE hosting.site_backups SET status = 'available', size_bytes = $2, checksum = $3, manifest = $4, sink_ref = $5, archive_name = $6,
           provider_state = provider_state || $7::jsonb WHERE id = $1`,
        [
          backupId,
          d.sizeBytes,
          d.checksum,
          JSON.stringify(
            d.manifest.map((m) => ({ path: m.path, sha256: m.sha256, bytes: m.bytes })),
          ),
          d.sinkRef ?? null,
          d.archiveName ?? null,
          JSON.stringify({
            ...(d.encrypted === false ? { encrypted: false } : {}),
            ...(d.snapshot ? { snapshot: d.snapshot } : {}),
          }),
        ],
      ),
    );
    await this.db.withOrg(o.orgId, (c) =>
      recordStep(c, o.orgId, o.operationId, 'archive', 'succeeded', { sizeBytes: d.sizeBytes }),
    );
    await this.audit.record({
      action: 'hosting.backup.created',
      actorType: 'system',
      orgId: o.orgId,
      resource: { type: 'hosting_backup', id: backupId },
      outcome: 'success',
      detail: { kind: b.kind as string, sizeBytes: d.sizeBytes },
    });
    return { backupId, status: 'available', sizeBytes: d.sizeBytes };
  }
  private async siteWithNode(siteId: string): Promise<Row> {
    const r = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.*, n.compute_instance_id FROM hosting.sites s JOIN hosting.nodes n ON n.id = s.node_id WHERE s.id = $1`,
            [siteId],
          )
        ).rows[0],
    );
    if (!r) throw new PermanentError('the site or its node no longer exists');
    return r;
  }

  /* ───────────── restore ───────────── */
  async requestRestore(
    orgId: string,
    actor: Caller,
    siteId: string,
    body: Record<string, unknown>,
  ): Promise<{ operationId: string; site: { id: string; status: string } }> {
    await this.sites.row(orgId, siteId); // the site first: another organization's id is a 404 whatever the body says
    for (const k of Object.keys(body))
      if (k !== 'backupId') throw new ProblemException('validation_failed', `unknown member ${k}`);
    if (typeof body.backupId !== 'string' || !UUID.test(body.backupId))
      throw new ProblemException('validation_failed', 'backupId must be a backup id');
    const site = await this.sites.row(orgId, siteId);
    if (site.status === 'restoring')
      throw new ProblemException(
        'restore_in_progress',
        'a restore is already running for this site',
      );
    if (site.status !== 'active')
      throw new ProblemException('site_not_active', 'only an active site can be restored');
    const b = await this.rowOf(orgId, siteId, body.backupId);
    if (b.status !== 'available')
      throw new ProblemException(
        'conflict',
        `the backup is ${b.status as string}: only an available backup can be restored`,
      );
    this.requireSink();
    // the conditional update is the arbiter between two parallel restore requests
    const moved = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE hosting.sites SET status = 'restoring', version = version + 1, updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'active'`,
            [siteId, orgId],
          )
        ).rowCount,
    );
    if (!moved)
      throw new ProblemException(
        'restore_in_progress',
        'a restore is already running for this site',
      );
    const op = await this.ops.create(orgId, {
      kind: KIND.restore,
      input: { siteId, backupId: b.id as string },
      resourceKind: 'hosting_site',
      resourceId: siteId,
      createdBy: actor.userId,
      maxAttempts: 3,
    });
    await this.audit.record({
      action: 'hosting.restore.requested',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_backup', id: b.id as string },
      outcome: 'success',
    });
    this.kick(orgId, op.id);
    return { operationId: op.id, site: { id: siteId, status: 'restoring' } };
  }

  /** Operation handler `hosting.backup.restore`: pre-restore safety backup → restore → verify → active. The site is returned to `active` on any failure (nothing was overwritten if verification failed first). */
  async executeRestore(o: {
    orgId: string;
    operationId: string;
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const siteId = o.input.siteId as string;
    const backupId = o.input.backupId as string;
    const site = await this.siteWithNode(siteId);
    const ref = {
      nodeId: site.node_id as string,
      computeInstanceId: site.compute_instance_id as string,
    };
    const b = await this.db.withOrg(
      o.orgId,
      async (c) =>
        (await c.query(`SELECT * FROM hosting.site_backups WHERE id = $1`, [backupId])).rows[0],
    );
    if (!b) throw new PermanentError('the backup row is gone');
    const back = async (status = 'active') =>
      this.db.withOrg(o.orgId, (c) =>
        c.query(
          `UPDATE hosting.sites SET status = $2, version = version + 1, updated_at = now() WHERE id = $1 AND status = 'restoring'`,
          [siteId, status],
        ),
      );
    try {
      // 1. the PRE-RESTORE SAFETY BACKUP (kept for the retention period; it is how a bad restore is undone)
      await this.db.withOrg(o.orgId, (c) =>
        recordStep(c, o.orgId, o.operationId, 'pre_restore_backup', 'running'),
      );
      let safety: Row | undefined = (await this.db.withOrg(
        o.orgId,
        async (c) =>
          (
            await c.query(
              `SELECT * FROM hosting.site_backups WHERE site_id = $1 AND kind = 'pre_restore' AND (created_by IS NULL) AND label = $2`,
              [siteId, `op:${o.operationId}`],
            )
          ).rows[0],
      )) as Row | undefined;
      if (!safety) {
        const sid = uuidv7();
        safety = await this.db.withOrg(
          o.orgId,
          async (c) =>
            (
              await c.query(
                `INSERT INTO hosting.site_backups (id, site_id, org_id, kind, label, enc_key_ref, sink_kind, data_region, expires_at) VALUES ($1,$2,$3,'pre_restore',$4,$5,$6,$7,$8) RETURNING *`,
                [
                  sid,
                  siteId,
                  o.orgId,
                  `op:${o.operationId}`,
                  site.backup_key_ref,
                  this.sink.kind,
                  site.data_region,
                  new Date(this.clock().getTime() + this.cfg.backupRetentionDays * 86_400_000),
                ],
              )
            ).rows[0]!,
        );
      }
      const safetyId = (safety as Row).id as string;
      const sb = await this.execute({
        orgId: o.orgId,
        operationId: o.operationId,
        input: { siteId, backupId: safetyId },
      });
      if (sb.status !== 'available')
        throw new PermanentError(
          'the safety backup could not be made: the restore was not started',
        );
      await this.db.withOrg(o.orgId, (c) =>
        recordStep(c, o.orgId, o.operationId, 'pre_restore_backup', 'succeeded', {
          backupId: safetyId,
        }),
      );
      // 2. restore + verification (checksum of the archive and of the restored files)
      await this.db.withOrg(o.orgId, (c) =>
        recordStep(c, o.orgId, o.operationId, 'restore', 'running'),
      );
      const refB: BackupRef = {
        backupId,
        sizeBytes: Number(b.size_bytes),
        checksum: b.checksum as string,
        sinkRef: (b.sink_ref as string | null) ?? undefined,
        manifest: (b.manifest as BackupRef['manifest']) ?? [],
        archiveName: (b.archive_name as string | null) ?? undefined,
        snapshot: (b.provider_state as { snapshot?: BackupRef['snapshot'] } | null)?.snapshot,
      };
      const r = await this.adapter.restore(
        this.sites.ctx(o.operationId),
        ref,
        site.node_name as string,
        refB,
        {
          idempotencyToken: tokenFor(o.orgId, `${backupId}:${o.operationId}`, 'restore'),
          operationId: o.operationId,
        },
      );
      if (r.status === 'uncertain')
        throw new NeedsReconcile(
          'the restore answer was lost: verify the site before anything else',
        );
      if (r.status !== 'succeeded' || !r.data?.verified || r.data.checksum !== b.checksum) {
        const corrupt = r.error?.category === 'validation';
        if (corrupt)
          await this.db.withOrg(o.orgId, (c) =>
            c.query(
              `UPDATE hosting.site_backups SET status = 'corrupt', failure_reason = $2 WHERE id = $1`,
              [backupId, (r.error?.message ?? 'integrity check failed').slice(0, 190)],
            ),
          );
        await this.db.withOrg(o.orgId, (c) =>
          recordStep(c, o.orgId, o.operationId, 'restore', 'failed'),
        );
        await this.audit.record({
          action: 'hosting.restore.failed',
          actorType: 'system',
          orgId: o.orgId,
          resource: { type: 'hosting_backup', id: backupId },
          outcome: 'failure',
          detail: { corrupt },
        });
        await back();
        throw new PermanentError(
          corrupt
            ? 'the backup is corrupt (integrity check failed): the site was not changed'
            : 'the restore could not be verified',
          corrupt ? 'backup_corrupt' : 'restore_failed',
        );
      }
      await this.db.withOrg(o.orgId, (c) =>
        recordStep(c, o.orgId, o.operationId, 'restore', 'succeeded', { verified: true }),
      );
      await back();
      await this.audit.record({
        action: 'hosting.backup.restored',
        actorType: 'system',
        orgId: o.orgId,
        resource: { type: 'hosting_backup', id: backupId },
        outcome: 'success',
        detail: { safetyBackupId: safetyId },
      });
      return { backupId, verified: true, safetyBackupId: safetyId };
    } catch (e) {
      if (e instanceof NeedsReconcile) throw e; // the site stays `restoring` until the reconcile run settles it
      await back().catch(() => undefined);
      throw e;
    }
  }

  /* ───────────── expiring download links ───────────── */
  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
  /** `GET /v1/hosting/backup-downloads?token=…`: the token binds organization + site + backup + expiry; it is useless to any other organization. */
  async downloadLink(
    orgId: string,
    siteId: string,
    backupId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const b = await this.rowOf(orgId, siteId, backupId);
    if (b.status !== 'available')
      throw new ProblemException('conflict', 'only an available backup can be downloaded');
    const exp = this.clock().getTime() + this.cfg.downloadLinkTtlSeconds * 1000;
    const payload = Buffer.from(
      JSON.stringify({ o: orgId, s: siteId, b: backupId, e: exp }),
    ).toString('base64url');
    return {
      url: `/v1/hosting/backup-downloads?token=${payload}.${this.sign(payload)}`,
      expiresAt: new Date(exp).toISOString(),
    };
  }
  async download(
    orgId: string,
    token: string,
  ): Promise<{ data: Buffer; checksum: string; id: string }> {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) throw new ProblemException('not_found', 'link not found');
    const good = this.sign(payload);
    if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good)))
      throw new ProblemException('not_found', 'link not found');
    let p: { o: string; s: string; b: string; e: number };
    try {
      p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new ProblemException('not_found', 'link not found');
    }
    if (p.o !== orgId) throw new ProblemException('not_found', 'link not found'); // the link of another organization: indistinguishable from a missing one
    if (p.e < this.clock().getTime())
      throw new ProblemException('gone', 'this download link has expired');
    const b = await this.rowOf(orgId, p.s, p.b);
    if (b.status !== 'available' || !b.sink_ref)
      throw new ProblemException('conflict', 'the backup is not available');
    const data = await this.sink.get(b.sink_ref as string);
    if (!data) throw new ProblemException('not_found', 'the archive is not in the sink');
    await this.audit.record({
      action: 'hosting.backup.downloaded',
      orgId,
      actorType: 'user',
      resource: { type: 'hosting_backup', id: p.b },
      outcome: 'success',
    });
    return { data, checksum: b.checksum as string, id: p.b };
  }

  /* ───────────── scheduled backups ───────────── */
  /**
   * The platform's own backup schedule: every active site whose plan includes backups gets one `scheduled` backup per day (Hestia's own nightly job is switched off at node setup so
   * there is ONE schedule, ours, with a row, a checksum, a quota and a region check for every archive). A site at its backup-count limit first expires its oldest SCHEDULED backup
   * (the retention sweep deletes it); a quota filled by the customer's own on-demand backups is never touched, and the missing backup raises the `backup_missing` alert.
   */
  async scheduleDue(now = this.clock()): Promise<{ queued: number; skipped: number }> {
    const out = { queued: 0, skipped: 0 };
    if (this.sink.kind === 'none') return out;
    const sites = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.*, q.limit_value AS backup_limit FROM hosting.sites s
               JOIN hosting.site_quotas q ON q.site_id = s.id AND q.dim = 'backup_count' AND q.limit_value > 0
              WHERE s.status = 'active' AND s.node_id IS NOT NULL AND s.backup_key_ref IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM hosting.site_backups b WHERE b.site_id = s.id AND b.kind = 'scheduled'
                                   AND ((b.status IN ('creating','available') AND b.created_at > $1::timestamptz - interval '24 hours')
                                     OR (b.status = 'failed' AND b.created_at > $1::timestamptz - interval '3 hours')))
              ORDER BY s.created_at LIMIT 100`,
            [now],
          )
        ).rows,
    );
    for (const site of sites) {
      const orgId = site.org_id as string;
      try {
        await this.requireResidency(orgId, site.data_region as string);
        const live = await this.db.withOrg(
          orgId,
          async (c) =>
            (
              await c.query(
                `SELECT id, kind FROM hosting.site_backups WHERE site_id = $1 AND status IN ('creating','available') AND kind IN ('on_demand','scheduled') AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at`,
                [site.id, now],
              )
            ).rows,
        );
        const room = Number(site.backup_limit) - live.length;
        if (room < 1) {
          const oldest = live.find((x) => x.kind === 'scheduled');
          if (!oldest) {
            out.skipped++;
            continue;
          }
          await this.db.withOrg(orgId, (c) =>
            c.query(`UPDATE hosting.site_backups SET expires_at = $2 WHERE id = $1`, [
              oldest.id,
              now,
            ]),
          );
        }
        await this.insertAndQueue(orgId, null, site, 'scheduled', null);
        out.queued++;
      } catch {
        out.skipped++; // residency denied, no room: the monitor reports a site without a recent backup
      }
    }
    return out;
  }

  /* ───────────── retention ───────────── */
  /** Removes expired backups from the sink (retention, M04 proposal defaults); a site under legal hold keeps its backups. */
  async sweepRetention(now = this.clock()): Promise<{ deleted: number; heldBack: number }> {
    const due = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT b.id, b.org_id, b.sink_ref, b.archive_name, s.node_id, s.node_name, n.compute_instance_id
               FROM hosting.site_backups b JOIN hosting.sites s ON s.id = b.site_id LEFT JOIN hosting.nodes n ON n.id = s.node_id
              WHERE b.status IN ('available','corrupt','failed') AND b.expires_at IS NOT NULL AND b.expires_at <= $1 ORDER BY b.expires_at LIMIT 200`,
            [now],
          )
        ).rows,
    );
    const out = { deleted: 0, heldBack: 0 };
    for (const b of due) {
      const hold = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `SELECT 1 FROM audit.legal_holds WHERE status = 'active' AND (org_id = $1 OR org_id IS NULL) AND (dataset IS NULL OR dataset = ANY($2::text[])) LIMIT 1`,
              [b.org_id, ['hosting.sites', 'hosting.site_backups']],
            )
          ).rowCount,
      );
      if (hold) {
        out.heldBack++;
        continue;
      }
      if (b.sink_ref) await this.sink.delete(b.sink_ref as string);
      // the copy still on the node (Hestia keeps its own until its package limit drops it): best effort, the sink copy is the one that counts
      if (b.archive_name && b.node_id && this.adapter.deleteBackup)
        await this.adapter
          .deleteBackup(
            this.sites.ctx(`retention-${b.id as string}`),
            { nodeId: b.node_id as string, computeInstanceId: b.compute_instance_id as string },
            b.node_name as string,
            b.archive_name as string,
          )
          .catch(() => undefined);
      await this.db.withPlatformScope((c) =>
        c.query(
          `UPDATE hosting.site_backups SET status = 'deleted', deleted_at = now(), sink_ref = NULL WHERE id = $1`,
          [b.id],
        ),
      );
      out.deleted++;
    }
    return out;
  }
}
