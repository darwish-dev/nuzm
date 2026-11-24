import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db, OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { tokenFor } from './hosting-names';
import type { CapacityService } from './capacity.service';
import { planLimits, planRow } from './plans.service';
import type { HostingAdapter, NodeRef, SiteInfo, VaultPort } from './ports';
import type { SitesService } from './sites.service';
import { recordStep, Deferred, NeedsReconcile, PermanentError } from './steps';
import type { AccountContext } from './m05-contracts';
import { SslService } from './ssl.service';
import type { HostingConfig } from './config';

type Row = Record<string, unknown>;
export interface OpCtx {
  orgId: string;
  operationId: string;
  input: Record<string, unknown>;
  attempts: number;
}

/**
 * Operation handlers of the site lifecycle (`platform.operations`, kinds `hosting.*`):
 *   create: quote consumed + authorization + allocation happened in the API → secrets → create_site(token) → configure → (domain/cert) → active
 *   delete: wait out the export window → wipe on the node → verify residual → release capacity/vault/domains/certs → deleted + wipe report
 *   domain.bind, ssl.issue: one step each.
 * RECONCILE-BEFORE-RETRY: every step that mutates the node first looks the effect up (`findByToken` by the site name derived from the token); a create whose answer
 * is `uncertain` is looked up again and, if the site is still not provably there, the operation is parked as `needs_reconcile`: it is never retried blind.
 */
export class SiteWorkflow {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly sites: SitesService,
    private readonly capacity: CapacityService,
    private readonly adapter: HostingAdapter,
    private readonly vault: VaultPort,
    private readonly ssl: SslService,
    private readonly cfg: HostingConfig,
    private readonly clock: () => Date = () => new Date(),
    /** called once the site is `active` (the WordPress install is queued here for a WordPress plan); a failure here never undoes the activation */
    private readonly onActive: (
      orgId: string,
      siteId: string,
      appKind: string,
    ) => Promise<void> = async () => undefined,
  ) {}

  private async load(siteId: string) {
    const r = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.*, n.compute_instance_id, n.data_region AS node_region FROM hosting.sites s LEFT JOIN hosting.nodes n ON n.id = s.node_id WHERE s.id = $1`,
            [siteId],
          )
        ).rows[0],
    );
    if (!r) throw new PermanentError('the site no longer exists', 'site_gone');
    return r as Row;
  }
  private ref(s: Row): NodeRef {
    if (!s.node_id) throw new PermanentError('the site has no node', 'no_node');
    return { nodeId: s.node_id as string, computeInstanceId: s.compute_instance_id as string };
  }
  private step(
    orgId: string,
    opId: string,
    name: string,
    state: 'running' | 'succeeded' | 'failed' | 'skipped',
    detail: Record<string, unknown> = {},
  ) {
    return this.db.withOrg(orgId, (c) => recordStep(c, orgId, opId, name, state, detail));
  }
  private ctx(opId: string): AccountContext {
    return this.sites.ctx(opId);
  }

  /* ───────────── create ───────────── */
  async create(o: OpCtx): Promise<Record<string, unknown>> {
    const siteId = o.input.siteId as string;
    const site = await this.load(siteId);
    if (site.status === 'active') {
      // an earlier run activated the site and may have stopped before queueing the application: queueing is idempotent
      if (site.app_kind !== 'none')
        await this.onActive(o.orgId, siteId, site.app_kind as string).catch(() => undefined);
      return { siteId, status: 'active', adopted: true };
    }
    if (site.status !== 'creating')
      throw new PermanentError(`the site is ${site.status as string}`, 'bad_state');
    const ref = this.ref(site);
    const nodeName = site.node_name as string;
    const t = { idempotencyToken: site.token as string, operationId: o.operationId };

    await this.step(o.orgId, o.operationId, 'allocate', 'succeeded', { node: 'assigned' }); // done synchronously by the API in the allocation transaction
    // 1. secrets: per-site credentials and per-site backup key, by vault reference only (created once)
    await this.step(o.orgId, o.operationId, 'secrets', 'running');
    for (const [ref_, bytes] of [
      [site.credentials_ref as string, 24],
      [site.backup_key_ref as string, 32],
    ] as const)
      if (!(await this.vault.exists(ref_))) await this.vault.put(ref_, randomBytes(bytes));
    await this.step(o.orgId, o.operationId, 'secrets', 'succeeded');

    // 2. create_site(token): look first, create only when provably absent
    await this.step(o.orgId, o.operationId, 'create_site', 'running');
    const plan = planRow(
      (await this.db.withPlatformScope(
        async (c) =>
          (await c.query(`SELECT * FROM hosting.plan_definitions WHERE id = $1`, [site.plan_id]))
            .rows[0],
      ))!,
    );
    let info: SiteInfo | null = null;
    const found = await this.adapter.findByToken(this.ctx(o.operationId), ref, nodeName);
    if (found.status === 'uncertain')
      throw new NeedsReconcile('the node did not answer the lookup');
    if (found.status === 'succeeded' && found.data) info = found.data;
    if (!info) {
      const spec = {
        name: nodeName,
        planKey: plan.key,
        runtime: site.runtime as string,
        domain: `${nodeName}.${this.cfg.defaultDomainSuffix}`,
        limits: planLimits(plan),
        credentialsRef: site.credentials_ref as string,
        backupKeyRef: site.backup_key_ref as string,
        ...t,
      };
      const r = await this.adapter.createSite(this.ctx(o.operationId), ref, spec);
      if (r.status === 'uncertain') {
        // the effect is UNKNOWN: reconcile now; only a proven absence allows another attempt (by the next run of this operation)
        const again = await this.adapter.findByToken(this.ctx(o.operationId), ref, nodeName);
        if (again.status === 'succeeded' && again.data) info = again.data;
        else if (again.status === 'succeeded' && again.data === null)
          throw new Error('the create did not reach the node (proven absent): retrying');
        else
          throw new NeedsReconcile('the create answer was lost and the lookup did not settle it');
      } else if (r.status === 'failed') {
        const cat = r.error?.category;
        if (cat === 'validation' || cat === 'unsupported' || cat === 'conflict' || cat === 'auth')
          throw new PermanentError(
            `${cat}: ${r.error?.message ?? ''}`.slice(0, 200),
            r.error?.providerCode ?? 'node_refused',
          );
        throw new Error(`${cat ?? 'unknown'}: ${r.error?.message ?? 'node failure'}`);
      } else {
        const after = await this.adapter.findByToken(this.ctx(o.operationId), ref, nodeName);
        info = after.data ?? null;
        if (!info) throw new NeedsReconcile('created, but the site cannot be read back');
      }
    }
    await this.step(o.orgId, o.operationId, 'create_site', 'succeeded', {
      adopted: found.data ? true : false,
    });

    // 3. configure the runtime / limits (idempotent)
    await this.step(o.orgId, o.operationId, 'configure', 'running');
    const u = await this.adapter.updateSite(
      this.ctx(o.operationId),
      ref,
      nodeName,
      { limits: planLimits(plan), runtime: site.runtime as string, planKey: plan.key },
      {
        idempotencyToken: tokenFor(site.org_id as string, siteId, 'configure'),
        operationId: o.operationId,
      },
    );
    if (u.status === 'uncertain') throw new NeedsReconcile('the configure answer was lost');
    if (u.status === 'failed')
      throw new Error(`configure failed: ${u.error?.message ?? ''}`.slice(0, 200));
    await this.step(o.orgId, o.operationId, 'configure', 'succeeded');
    await this.sites.syncQuotas(siteId, plan);

    // 4. the primary domain, only when it was verified (the binding flow decides; nothing here binds an unverified domain)
    await this.step(o.orgId, o.operationId, 'domain_and_certificate', 'skipped', {
      reason: 'domains are bound after the site is active (verification first)',
    });

    // 5. active
    await this.db.withPlatformScope((c) =>
      c.query(
        `UPDATE hosting.sites SET status = 'active', site_user = $2, version = version + 1, updated_at = now() WHERE id = $1 AND status = 'creating'`,
        [siteId, info!.systemUser],
      ),
    );
    await this.step(o.orgId, o.operationId, 'activate', 'succeeded');
    await this.audit.record({
      action: 'hosting.site.create.succeeded',
      actorType: 'system',
      orgId: o.orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
    });
    if (site.app_kind !== 'none')
      await this.onActive(o.orgId, siteId, site.app_kind as string).catch((e: Error) =>
        this.step(o.orgId, o.operationId, 'application', 'failed', {
          reason: e.message.slice(0, 150),
        }),
      );
    return { siteId, status: 'active' };
  }

  /** Called when a create operation is terminally failed: status failed, reservation released, audited. */
  async createFailed(orgId: string, siteId: string, reason: string): Promise<void> {
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `UPDATE hosting.sites SET status = 'failed', failure_reason = $2, version = version + 1, updated_at = now() WHERE id = $1 AND status = 'creating'`,
        [siteId, reason.slice(0, 290)],
      );
      await this.capacity.release(c, siteId);
    });
    await this.audit.record({
      action: 'hosting.site.create.failed',
      actorType: 'system',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'failure',
      detail: { reason: reason.slice(0, 200) },
    });
  }

  /* ───────────── domain ───────────── */
  async bindDomain(o: OpCtx): Promise<Record<string, unknown>> {
    const siteId = o.input.siteId as string;
    const bindingId = o.input.bindingId as string;
    const site = await this.load(siteId);
    if (site.status !== 'active') throw new PermanentError('the site is not active', 'bad_state');
    const b = await this.db.withOrg(
      o.orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.site_domain_bindings WHERE id = $1 AND site_id = $2`,
            [bindingId, siteId],
          )
        ).rows[0],
    );
    if (!b || b.state === 'removed') return { skipped: true };
    if (b.state === 'pending')
      throw new PermanentError(
        'an unverified domain is never applied to the node',
        'ownership_unverified',
      ); // the vhost is blocked until verified
    await this.step(o.orgId, o.operationId, 'vhost', 'running', { domain: b.domain });
    const r = await this.adapter.updateSite(
      this.ctx(o.operationId),
      this.ref(site),
      site.node_name as string,
      { domains: [b.domain as string] },
      {
        idempotencyToken: tokenFor(site.org_id as string, bindingId, 'bind_domain'),
        operationId: o.operationId,
      },
    );
    if (r.status === 'uncertain') throw new NeedsReconcile('the vhost answer was lost');
    if (r.status === 'failed') {
      if (r.error?.category === 'conflict')
        throw new PermanentError('the domain is already bound on the node', 'domain_conflict');
      throw new Error(`vhost failed: ${r.error?.message ?? ''}`.slice(0, 200));
    }
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `UPDATE hosting.site_domain_bindings SET state = 'active', updated_at = now() WHERE id = $1`,
        [bindingId],
      );
      if (b.is_primary)
        await c.query(
          `UPDATE hosting.sites SET domain_primary = $2, updated_at = now() WHERE id = $1`,
          [siteId, b.domain],
        );
    });
    await this.step(o.orgId, o.operationId, 'vhost', 'succeeded');
    await this.audit.record({
      action: 'hosting.site.domain.bound',
      actorType: 'system',
      orgId: o.orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
    });
    // a managed certificate is requested automatically for the first active domain without one
    const has = await this.db.withOrg(
      o.orgId,
      async (c) =>
        (
          await c.query(
            `SELECT 1 FROM hosting.ssl_certificates WHERE site_id = $1 AND status IN ('pending','issued') AND $2 = ANY(domains)`,
            [siteId, b.domain],
          )
        ).rowCount,
    );
    if (!has) {
      const id = uuidv7();
      await this.db.withOrg(o.orgId, (c) =>
        c.query(
          `INSERT INTO hosting.ssl_certificates (id, site_id, org_id, domains, mode) VALUES ($1,$2,$3,$4,'managed')`,
          [id, siteId, o.orgId, [b.domain]],
        ),
      );
      await this.ssl.attempt(o.orgId, id);
    }
    return { domain: b.domain };
  }

  async issueCertificate(o: OpCtx): Promise<Record<string, unknown>> {
    const r = await this.ssl.attempt(o.orgId, o.input.certId as string);
    return r;
  }

  /* ───────────── delete / offboarding ───────────── */
  async deleteSite(o: OpCtx): Promise<Record<string, unknown>> {
    const siteId = o.input.siteId as string;
    const site = await this.load(siteId);
    if (site.status === 'deleted') return { siteId, status: 'deleted', adopted: true };
    if (site.status !== 'deleting')
      throw new PermanentError(`the site is ${site.status as string}`, 'bad_state');
    // legal hold placed AFTER the request still blocks the wipe (M04)
    const hold = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id FROM audit.legal_holds WHERE status = 'active' AND (org_id = $1 OR org_id IS NULL) AND (dataset IS NULL OR dataset = ANY($2::text[])) LIMIT 1`,
            [o.orgId, ['hosting.sites', 'hosting.site_backups']],
          )
        ).rows[0],
    );
    if (hold)
      throw new Deferred(
        'legal_hold_active: the wipe is blocked by a legal hold; it is checked again in an hour',
        new Date(this.clock().getTime() + 3_600_000),
      );
    if (site.export_until && (site.export_until as Date).getTime() > this.clock().getTime())
      throw new Deferred('export window still open: the wipe waits', site.export_until as Date);
    const ref = site.node_id ? this.ref(site) : null;
    const nodeName = site.node_name as string;
    let residual: Record<string, number> = {
      filesRemaining: 0,
      databasesRemaining: 0,
      usersRemaining: 0,
      vhostsRemaining: 0,
      certificatesRemaining: 0,
      cronEntriesRemaining: 0,
    };
    if (ref) {
      await this.step(o.orgId, o.operationId, 'wipe_node', 'running');
      const d = await this.adapter.deleteSite(this.ctx(o.operationId), ref, nodeName, {
        idempotencyToken: tokenFor(o.orgId, siteId, 'delete_site'),
        operationId: o.operationId,
      });
      if (d.status === 'uncertain') {
        const v = await this.adapter.verifyWipe(this.ctx(o.operationId), ref, nodeName);
        if (v.status !== 'succeeded')
          throw new NeedsReconcile(
            'the delete answer was lost and the verification did not settle it',
          );
      } else if (d.status === 'failed')
        throw new Error(`delete failed: ${d.error?.message ?? ''}`.slice(0, 200));
      const v = await this.adapter.verifyWipe(this.ctx(o.operationId), ref, nodeName);
      if (v.status !== 'succeeded' || !v.data)
        throw new Error('the wipe could not be verified yet');
      const { site: _name, ...rest } = v.data;
      residual = rest;
      await this.step(o.orgId, o.operationId, 'wipe_node', 'succeeded');
    }
    const nodeResidual = Object.values(residual).reduce(
      (a, b) => a + (typeof b === 'number' ? b : 0),
      0,
    ); // `site` (a string) is not counted
    // vault material of the site: credentials, backup key, custom certificate keys (backup keys survive while retained backups exist: a backup is useless without its key, so the key goes with the LAST backup)
    const certs = await this.db.withOrg(
      o.orgId,
      async (c) =>
        (
          await c.query(`SELECT id, secret_ref FROM hosting.ssl_certificates WHERE site_id = $1`, [
            siteId,
          ])
        ).rows,
    );
    for (const c of certs) if (c.secret_ref) await this.vault.delete(c.secret_ref as string);
    // WordPress secrets (admin access, database password) leave the vault with the site
    const apps = await this.db.withOrg(
      o.orgId,
      async (c) =>
        (
          await c.query(
            `SELECT admin_secret_ref, db_secret_ref FROM hosting.site_apps WHERE site_id = $1`,
            [siteId],
          )
        ).rows,
    );
    for (const a of apps)
      for (const r of [a.admin_secret_ref, a.db_secret_ref])
        if (r) await this.vault.delete(r as string);
    await this.vault.delete(site.credentials_ref as string);
    const retained = await this.db.withOrg(o.orgId, async (c) =>
      Number(
        (
          await c.query(
            `SELECT count(*)::int AS n FROM hosting.site_backups WHERE site_id = $1 AND status = 'available' AND (expires_at IS NULL OR expires_at > now())`,
            [siteId],
          )
        ).rows[0]!.n,
      ),
    );
    if (retained === 0) await this.vault.delete(site.backup_key_ref as string);
    const vaultRemaining =
      ((await this.vault.exists(site.credentials_ref as string)) ? 1 : 0) +
      (retained === 0 && (await this.vault.exists(site.backup_key_ref as string)) ? 1 : 0) +
      (
        await Promise.all(
          certs.filter((c) => c.secret_ref).map((c) => this.vault.exists(c.secret_ref as string)),
        )
      ).filter(Boolean).length;
    const total = nodeResidual + vaultRemaining;
    await this.db.withPlatformScope(async (c) => {
      await this.capacity.release(c, siteId);
      await c.query(
        `UPDATE hosting.site_domain_bindings SET state = 'removed', removed_at = now(), updated_at = now() WHERE site_id = $1 AND state <> 'removed'`,
        [siteId],
      );
      await c.query(
        `UPDATE hosting.ssl_certificates SET status = 'removed', updated_at = now() WHERE site_id = $1 AND status <> 'removed'`,
        [siteId],
      );
      await c.query(`UPDATE hosting.site_quotas SET state = 'ok' WHERE site_id = $1`, [siteId]);
      await c.query(
        `INSERT INTO hosting.wipe_reports (id, site_id, org_id, node_residual, backups_remaining, vault_refs_remaining, verified, residual_total, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          uuidv7(),
          siteId,
          o.orgId,
          JSON.stringify(residual),
          retained,
          vaultRemaining,
          total === 0,
          total,
          retained > 0
            ? 'backups are kept until their retention expires (M04); their key stays in the vault until then'
            : null,
        ],
      );
      if (total === 0)
        await c.query(
          `UPDATE hosting.sites SET status = 'deleted', deleted_at = now(), domain_primary = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
          [siteId],
        );
    });
    if (total !== 0) throw new Error(`the wipe left ${total} residual artifact(s): retrying`);
    await this.audit.record({
      action: 'hosting.site.deleted',
      actorType: 'system',
      orgId: o.orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
      detail: { retainedBackups: retained },
    });
    return { siteId, status: 'deleted', residual: 0, retainedBackups: retained };
  }
}
