import { v7 as uuidv7 } from 'uuid';
import type { Db, OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { tokenFor } from './hosting-names';
import type { BackupService } from './backups.service';
import type { CapacityService } from './capacity.service';
import { planLimits, planNeed, planRow } from './plans.service';
import type { BackupRef, HostingAdapter } from './ports';
import { KIND, type SitesService } from './sites.service';
import { NeedsReconcile, PermanentError, recordStep } from './steps';
import { UUID } from '@nuzm/domain';

/**
 * Admin-triggered site migration for drain/maintenance (M06 §4 task 13): backup (pre_migration) on the source → create the site on the TARGET → restore there →
 * verify the checksum → switch (reservation moves, `sites.node_id` changes, domains are re-applied, managed certificates are re-issued) → delete from the source.
 * The SOURCE keeps serving and is untouched until the target is verified: any failure before the switch removes the target copy and leaves the source as it was
 * (no customer data loss). The same region is required (residency): a site never migrates across data regions.
 */
export class MigrationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly sites: SitesService,
    private readonly capacity: CapacityService,
    private readonly backups: BackupService,
    private readonly adapter: HostingAdapter,
    private readonly kick: (orgId: string, operationId: string) => void = () => undefined,
  ) {}

  async request(
    staffId: string,
    siteId: string,
    body: Record<string, unknown>,
  ): Promise<{ migrationId: string; operationId: string }> {
    for (const k of Object.keys(body))
      if (k !== 'targetNodeId')
        throw new ProblemException('validation_failed', `unknown member ${k}`);
    if (typeof body.targetNodeId !== 'string' || !UUID.test(body.targetNodeId))
      throw new ProblemException('validation_failed', 'targetNodeId must be a node id');
    const target = body.targetNodeId;
    if (!UUID.test(siteId)) throw new ProblemException('not_found', 'site not found');
    const site = await this.db.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM hosting.sites WHERE id = $1`, [siteId])).rows[0],
    );
    if (!site) throw new ProblemException('not_found', 'site not found');
    if (site.status !== 'active')
      throw new ProblemException('site_not_active', 'only an active site can be migrated');
    if (site.node_id === target)
      throw new ProblemException('validation_failed', 'the site is already on that node');
    const orgId = site.org_id as string;
    const tn = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, status, health, data_region, runtimes FROM hosting.nodes WHERE id = $1`,
            [target],
          )
        ).rows[0],
    );
    if (!tn) throw new ProblemException('not_found', 'target node not found');
    if (tn.status !== 'active' || tn.health !== 'healthy')
      throw new ProblemException('conflict', 'the target node is not active and healthy');
    if (tn.data_region !== site.data_region)
      throw new ProblemException(
        'residency_denied',
        'a site never migrates to another data region',
      );
    if (!(tn.runtimes as string[]).includes(site.runtime as string))
      throw new ProblemException(
        'unsupported_runtime',
        'the target node does not offer the site runtime',
      );
    const mid = uuidv7();
    const op = await this.ops.create(orgId, {
      kind: KIND.migrate,
      input: { siteId, migrationId: mid },
      resourceKind: 'hosting_site',
      resourceId: siteId,
      createdBy: staffId,
      maxAttempts: 3,
    });
    try {
      await this.db.withPlatformScope((c) =>
        c.query(
          `INSERT INTO hosting.site_migrations (id, site_id, from_node_id, to_node_id, operation_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [mid, siteId, site.node_id, target, op.id, staffId],
        ),
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'a migration of this site is already running');
      throw e;
    }
    await this.audit.record({
      action: 'hosting.site.migration.requested',
      actorUserId: staffId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
      detail: { to: target },
    });
    this.kick(orgId, op.id);
    return { migrationId: mid, operationId: op.id };
  }

  async list(siteId?: string) {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT id, site_id, from_node_id, to_node_id, state, error, created_at, updated_at FROM hosting.site_migrations WHERE ($1::uuid IS NULL OR site_id = $1) ORDER BY created_at DESC LIMIT 100`,
          [siteId ?? null],
        )
      ).rows.map((r) => ({
        id: r.id as string,
        siteId: r.site_id as string,
        fromNodeId: r.from_node_id as string,
        toNodeId: r.to_node_id as string,
        state: r.state as string,
        error: (r.error as string | null) ?? null,
        createdAt: (r.created_at as Date).toISOString(),
      })),
    );
  }

  /** Operation handler `hosting.site.migrate`. */
  async execute(o: {
    orgId: string;
    operationId: string;
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const siteId = o.input.siteId as string;
    const mid = o.input.migrationId as string;
    const m = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM hosting.site_migrations WHERE id = $1`, [mid])).rows[0],
    );
    if (!m) throw new PermanentError('migration not found');
    if (m.state === 'switched') return { migrationId: mid, state: 'switched' };
    const setState = (state: string, error?: string) =>
      this.db.withPlatformScope((c) =>
        c.query(
          `UPDATE hosting.site_migrations SET state = $2, error = $3, updated_at = now() WHERE id = $1`,
          [mid, state, error ?? null],
        ),
      );
    const site = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.*, src.compute_instance_id AS src_instance, dst.compute_instance_id AS dst_instance FROM hosting.sites s JOIN hosting.nodes src ON src.id = $2 JOIN hosting.nodes dst ON dst.id = $3 WHERE s.id = $1`,
            [siteId, m.from_node_id, m.to_node_id],
          )
        ).rows[0],
    );
    if (!site) throw new PermanentError('site or node missing');
    if (site.node_id !== m.from_node_id)
      throw new PermanentError('the site is no longer on the source node');
    const src = {
      nodeId: m.from_node_id as string,
      computeInstanceId: site.src_instance as string,
    };
    const dst = { nodeId: m.to_node_id as string, computeInstanceId: site.dst_instance as string };
    const name = site.node_name as string;
    const plan = planRow(
      (await this.db.withPlatformScope(
        async (c) =>
          (await c.query(`SELECT * FROM hosting.plan_definitions WHERE id = $1`, [site.plan_id]))
            .rows[0],
      ))!,
    );
    const step = (
      n: string,
      st: 'running' | 'succeeded' | 'failed',
      d: Record<string, unknown> = {},
    ) => this.db.withOrg(o.orgId, (c) => recordStep(c, o.orgId, o.operationId, n, st, d));
    let targetCreated = false;
    const rollback = async (why: string) => {
      // the SOURCE was never touched: only the target copy is removed
      if (targetCreated)
        await this.adapter
          .deleteSite(this.sites.ctx(o.operationId), dst, name, {
            idempotencyToken: tokenFor(o.orgId, `${mid}:rollback`, 'delete_target'),
            operationId: o.operationId,
          })
          .catch(() => undefined);
      await setState('rolled_back', why.slice(0, 280));
      await this.audit.record({
        action: 'hosting.site.migration.failed',
        actorType: 'system',
        orgId: o.orgId,
        resource: { type: 'hosting_site', id: siteId },
        outcome: 'failure',
        detail: { reason: why.slice(0, 200), sourceServing: true },
      });
    };
    try {
      // 1. backup of the source (pre_migration) through the normal backup path (per-site key, sink of the site region)
      await setState('backing_up');
      await step('backup_source', 'running');
      const bid = uuidv7();
      await this.db.withOrg(o.orgId, (c) =>
        c.query(
          `INSERT INTO hosting.site_backups (id, site_id, org_id, kind, label, enc_key_ref, sink_kind, data_region, expires_at) VALUES ($1,$2,$3,'pre_migration',$4,$5,$6,$7, now() + interval '30 days')`,
          [
            bid,
            siteId,
            o.orgId,
            `migration:${mid}`,
            site.backup_key_ref,
            'node-local-segregated',
            site.data_region,
          ],
        ),
      );
      const made = await this.backups.execute({
        orgId: o.orgId,
        operationId: o.operationId,
        input: { siteId, backupId: bid },
      });
      if (made.status !== 'available')
        throw new PermanentError('the source backup could not be made');
      await this.db.withPlatformScope((c) =>
        c.query(`UPDATE hosting.site_migrations SET backup_id = $2 WHERE id = $1`, [mid, bid]),
      );
      await step('backup_source', 'succeeded');
      // 2. the site on the target (same site name, a new token generation: the name is only unique PER NODE)
      await step('create_on_target', 'running');
      const spec = {
        name,
        runtime: site.runtime as string,
        domain: `${name}.migrating.invalid`,
        limits: planLimits(plan),
        credentialsRef: site.credentials_ref as string,
        backupKeyRef: site.backup_key_ref as string,
        idempotencyToken: tokenFor(o.orgId, `${mid}:target`, 'create_site'),
        operationId: o.operationId,
      };
      const cr = await this.adapter.createSite(this.sites.ctx(o.operationId), dst, spec);
      if (cr.status === 'uncertain') {
        const f = await this.adapter.findByToken(this.sites.ctx(o.operationId), dst, name);
        if (!f.data) throw new NeedsReconcile('the target create answer was lost');
      } else if (cr.status !== 'succeeded')
        throw new PermanentError(
          `the target refused the site: ${cr.error?.message ?? ''}`.slice(0, 200),
        );
      targetCreated = true;
      await step('create_on_target', 'succeeded');
      // 3. restore on the target + verify
      await setState('restoring');
      await step('restore_on_target', 'running');
      const b = await this.db.withOrg(
        o.orgId,
        async (c) =>
          (await c.query(`SELECT * FROM hosting.site_backups WHERE id = $1`, [bid])).rows[0],
      );
      const ref: BackupRef = {
        backupId: bid,
        sizeBytes: Number(b.size_bytes),
        checksum: b.checksum as string,
        sinkRef: b.sink_ref as string,
        manifest: b.manifest as BackupRef['manifest'],
      };
      const rs = await this.adapter.restore(this.sites.ctx(o.operationId), dst, name, ref, {
        idempotencyToken: tokenFor(o.orgId, `${mid}:restore`, 'restore'),
        operationId: o.operationId,
      });
      if (rs.status === 'uncertain') throw new NeedsReconcile('the target restore answer was lost');
      await setState('verifying');
      if (rs.status !== 'succeeded' || !rs.data?.verified || rs.data.checksum !== b.checksum)
        throw new PermanentError('the restored copy could not be verified');
      await step('restore_on_target', 'succeeded', { verified: true });
      // 4. switch: the reservation moves with the site (target reserved first, then the source released), then the node pointer
      await step('switch', 'running');
      const domains = await this.db.withOrg(o.orgId, async (c) =>
        (
          await c.query(
            `SELECT domain FROM hosting.site_domain_bindings WHERE site_id = $1 AND state = 'active'`,
            [siteId],
          )
        ).rows.map((r) => r.domain as string),
      );
      await this.db.withPlatformScope(async (c) => {
        await this.capacity.move(c, siteId, m.to_node_id as string);
        await c.query(
          `UPDATE hosting.sites SET node_id = $2, version = version + 1, updated_at = now() WHERE id = $1`,
          [siteId, m.to_node_id],
        );
        await c.query(
          `UPDATE hosting.ssl_certificates SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE site_id = $1 AND mode = 'managed' AND status = 'issued'`,
          [siteId],
        ); // re-issued on the new node by the sweep
      });
      if (domains.length)
        await this.adapter.updateSite(
          this.sites.ctx(o.operationId),
          dst,
          name,
          { domains },
          {
            idempotencyToken: tokenFor(o.orgId, `${mid}:domains`, 'bind'),
            operationId: o.operationId,
          },
        );
      await step('switch', 'succeeded');
      // 5. the source copy is removed only now
      await this.adapter
        .deleteSite(this.sites.ctx(o.operationId), src, name, {
          idempotencyToken: tokenFor(o.orgId, `${mid}:source`, 'delete_source'),
          operationId: o.operationId,
        })
        .catch(() => undefined);
      await setState('switched');
      await this.audit.record({
        action: 'hosting.site.migrated',
        actorType: 'system',
        orgId: o.orgId,
        resource: { type: 'hosting_site', id: siteId },
        outcome: 'success',
        detail: { from: m.from_node_id as string, to: m.to_node_id as string },
      });
      return { migrationId: mid, state: 'switched' };
    } catch (e) {
      if (e instanceof NeedsReconcile) throw e;
      await rollback((e as Error).message);
      throw e instanceof PermanentError ? e : new PermanentError((e as Error).message);
    }
  }
}
export { planNeed };
