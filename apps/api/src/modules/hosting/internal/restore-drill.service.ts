import { v7 as uuidv7 } from 'uuid';
import type { Db, OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { UUID } from '@nuzm/domain';
import { tokenFor } from './hosting-names';
import type { BackupRef, HostingAdapter, NodeRef, SiteProbe } from './ports';
import { KIND, type SitesService } from './sites.service';
import type { OpCtx } from './site-workflow';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

export interface RestoreDrillDto {
  id: string;
  backupId: string;
  siteId: string;
  nodeId: string;
  state: 'running' | 'passed' | 'failed';
  checks: Record<string, unknown>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

/**
 * Restore drills (master prompt S06): a REAL backup is restored into an ISOLATED node (`purpose = restore_drill`, never `active`, in the backup's own data region), the result is checked,
 * the restored account is wiped again, and the duration and the result are kept. It is how "the backup restores" is proven, rather than assumed.
 * Checks: the archive matches its checksum (before anything is touched), `v-restore-user` ran and the account matches the snapshot taken at backup time, a WordPress site answers with its
 * admin page, and afterwards NOTHING of the customer's account is left on the drill node (a wipe that leaves residue fails the drill).
 */
export class RestoreDrillService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly sites: SitesService,
    private readonly adapter: HostingAdapter,
    private readonly probe: SiteProbe,
    private readonly defaultDomainSuffix: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly kick: (orgId: string, operationId: string) => void = () => undefined,
  ) {}

  private dto(r: Row): RestoreDrillDto {
    return {
      id: r.id as string,
      backupId: r.backup_id as string,
      siteId: r.site_id as string,
      nodeId: r.node_id as string,
      state: r.state as RestoreDrillDto['state'],
      checks: (r.checks as Record<string, unknown>) ?? {},
      error: (r.error as string | null) ?? null,
      startedAt: iso(r.started_at)!,
      finishedAt: iso(r.finished_at),
      durationMs:
        r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    };
  }

  async request(
    adminUserId: string,
    backupId: string,
    nodeId: string,
  ): Promise<{ drill: RestoreDrillDto; operationId: string }> {
    if (!UUID.test(backupId) || !UUID.test(nodeId))
      throw new ProblemException('validation_failed', 'backupId and nodeId must be ids');
    const b = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT b.*, s.status AS site_status FROM hosting.site_backups b JOIN hosting.sites s ON s.id = b.site_id WHERE b.id = $1`,
            [backupId],
          )
        ).rows[0],
    );
    if (!b) throw new ProblemException('not_found', 'backup not found');
    if (b.status !== 'available')
      throw new ProblemException(
        'conflict',
        `the backup is ${b.status as string}: only an available backup can be drilled`,
      );
    if (b.kind === 'pre_restore')
      throw new ProblemException('conflict', 'a pre-restore safety backup is not drilled');
    const n = await this.db.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM hosting.nodes WHERE id = $1`, [nodeId])).rows[0],
    );
    if (!n) throw new ProblemException('not_found', 'node not found');
    if (n.purpose !== 'restore_drill')
      throw new ProblemException(
        'conflict',
        'a restore drill runs only on a node whose purpose is restore_drill (never on a node that holds customer sites)',
      );
    if (n.status !== 'maintenance')
      throw new ProblemException(
        'conflict',
        'the drill node must be in maintenance (it never takes orders)',
      );
    if (n.data_region !== b.data_region)
      throw new ProblemException(
        'residency_denied',
        'the drill node is not in the data region of the backup: customer data never leaves its region',
      );
    const open = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM hosting.restore_drills WHERE node_id = $1 AND state = 'running'`,
            [nodeId],
          )
        ).rowCount,
    );
    if (open) throw new ProblemException('conflict', 'a drill is already running on this node');
    const id = uuidv7();
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `INSERT INTO hosting.restore_drills (id, backup_id, site_id, org_id, node_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [id, backupId, b.site_id, b.org_id, nodeId, adminUserId],
          )
        ).rows[0]!,
    );
    const op = await this.ops.create(b.org_id as string, {
      kind: KIND.drill,
      input: { drillId: id },
      resourceKind: 'hosting_site',
      resourceId: b.site_id as string,
      createdBy: adminUserId,
      maxAttempts: 3,
    });
    await this.audit.record({
      action: 'hosting.restore_drill.requested',
      actorUserId: adminUserId,
      actorType: 'user',
      orgId: b.org_id as string,
      resource: { type: 'hosting_backup', id: backupId },
      outcome: 'success',
      detail: { nodeId },
    });
    this.kick(b.org_id as string, op.id);
    return { drill: this.dto(row), operationId: op.id };
  }

  async list(limit = 50): Promise<{ items: RestoreDrillDto[] }> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.restore_drills ORDER BY started_at DESC, id DESC LIMIT $1`,
            [limit],
          )
        ).rows,
    );
    return { items: rows.map((r) => this.dto(r)) };
  }
  async get(id: string): Promise<RestoreDrillDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found', 'drill not found');
    const r = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM hosting.restore_drills WHERE id = $1`, [id])).rows[0],
    );
    if (!r) throw new ProblemException('not_found', 'drill not found');
    return this.dto(r);
  }

  /** Operation handler `hosting.restore.drill`. The drill's verdict is its own record: the operation succeeds whenever the drill was RUN, whatever the verdict. */
  async execute(o: OpCtx): Promise<Record<string, unknown>> {
    const drillId = o.input.drillId as string;
    const d = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM hosting.restore_drills WHERE id = $1`, [drillId])).rows[0],
    );
    if (!d) return { skipped: true };
    if (d.state !== 'running') return { drillId, state: d.state };
    const b = (await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM hosting.site_backups WHERE id = $1`, [d.backup_id])).rows[0],
    ))!;
    const site = (await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM hosting.sites WHERE id = $1`, [d.site_id])).rows[0],
    ))!;
    const n = (await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM hosting.nodes WHERE id = $1`, [d.node_id])).rows[0],
    ))!;
    const ref: NodeRef = {
      nodeId: n.id as string,
      computeInstanceId: n.compute_instance_id as string,
    };
    const name = site.node_name as string;
    const ctx = this.sites.ctx(o.operationId);
    const started = new Date(d.started_at as Date).getTime();
    const checks: Record<string, unknown> = {};
    let error: string | null = null;
    try {
      const backup: BackupRef = {
        backupId: b.id as string,
        sizeBytes: Number(b.size_bytes),
        checksum: b.checksum as string,
        sinkRef: (b.sink_ref as string | null) ?? undefined,
        manifest: (b.manifest as BackupRef['manifest']) ?? [],
        archiveName: (b.archive_name as string | null) ?? undefined,
        snapshot: (b.provider_state as { snapshot?: BackupRef['snapshot'] } | null)?.snapshot,
      };
      const r = await this.adapter.restore(ctx, ref, name, backup, {
        idempotencyToken: tokenFor(b.org_id as string, `${d.id as string}`, 'drill_restore'),
        operationId: o.operationId,
      });
      checks.restore =
        r.status === 'succeeded' && r.data?.verified === true && r.data.checksum === b.checksum
          ? 'passed'
          : `failed: ${r.error?.message ?? r.status}`.slice(0, 160);
      if (checks.restore === 'passed') {
        const f = await this.adapter.findByToken(ctx, ref, name);
        checks.account =
          f.status === 'succeeded' && f.data
            ? 'passed'
            : 'failed: the account is not on the drill node';
        if (f.data) checks.domains = f.data.domains.length;
        if (site.app_kind === 'wordpress') {
          const obs = await this.probe.observe(ref.nodeId, `${name}.${this.defaultDomainSuffix}`);
          checks.wordpress =
            obs.phase === 'installed' && obs.adminPage
              ? 'passed'
              : `failed: ${obs.detail}`.slice(0, 160);
        }
      }
    } catch (e) {
      error = (e as Error).message.slice(0, 280);
    } finally {
      // the customer's data does not stay on the drill node, whatever happened
      try {
        await this.adapter.deleteSite(ctx, ref, name, {
          idempotencyToken: tokenFor(b.org_id as string, `${d.id as string}`, 'drill_wipe'),
          operationId: o.operationId,
        });
        const w = await this.adapter.verifyWipe(ctx, ref, name);
        const left = w.data
          ? Object.entries(w.data).reduce(
              (a, [k, v]) => (k !== 'site' && typeof v === 'number' ? a + v : a),
              0,
            )
          : -1;
        checks.wipe =
          left === 0 ? 'passed' : `failed: ${left < 0 ? 'unverified' : `${left} object(s) left`}`;
      } catch (e) {
        checks.wipe = `failed: ${(e as Error).message.slice(0, 120)}`;
      }
    }
    const ok =
      !error &&
      Object.values(checks).every(
        (v) => typeof v !== 'string' || v === 'passed' || !v.startsWith('failed'),
      );
    const finished = this.clock();
    await this.db.withPlatformScope((c) =>
      c.query(
        `UPDATE hosting.restore_drills SET state = $2, checks = $3::jsonb, error = $4, finished_at = $5, duration_ms = $6 WHERE id = $1 AND state = 'running'`,
        [
          drillId,
          ok ? 'passed' : 'failed',
          JSON.stringify(checks),
          error,
          finished,
          Math.max(0, finished.getTime() - started),
        ],
      ),
    );
    await this.audit.record({
      action: ok ? 'hosting.restore_drill.passed' : 'hosting.restore_drill.failed',
      actorType: 'system',
      orgId: b.org_id as string,
      resource: { type: 'hosting_backup', id: b.id as string },
      outcome: ok ? 'success' : 'failure',
      detail: { durationMs: finished.getTime() - started },
    });
    return { drillId, state: ok ? 'passed' : 'failed' };
  }
}
