import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db, OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { HostingConfig } from './config';
import type { OperationResult } from './m05-contracts';
import type { NodeRef, SiteProbe, VaultPort, WordPressNodePort, WpSite } from './ports';
import { KIND, type Caller, type SitesService } from './sites.service';
import { NeedsReconcile, PermanentError, recordStep } from './steps';
import type { OpCtx } from './site-workflow';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
const HANDOVER_DAYS = 7;
/** 32 characters of [A-Za-z0-9]: passes every argument pattern of the allow-list and needs no escaping anywhere */
const password = () => randomBytes(24).toString('base64url').replace(/[-_]/g, 'x');

export interface WordPressDto {
  app: 'wordpress';
  state: 'pending' | 'installing' | 'ready' | 'failed';
  phase: string | null;
  siteUrl: string | null;
  loginUrl: string | null;
  adminUser: string | null;
  handover: { state: string; expiresAt: string | null };
  verification: { answers?: boolean; adminPage?: boolean; checkedAt?: string };
  attempts: number;
  lastError: string | null;
  installedAt: string | null;
  verifiedAt: string | null;
}

/**
 * Managed WordPress (master prompt S03 §4, ADR-068). The install is a STATE MACHINE DRIVEN BY WHAT THE SITE SHOWS over HTTP (`SiteProbe`), not by what this service remembers:
 *   none → (database, placeholders, `wp core download`) → unconfigured → (`wp config create`) → uninstalled → (`wp core install`) → installed → verified (home answers, `wp-login.php` served).
 * A retry, a restart or a second worker therefore resumes at the right step and can never overwrite content: WP-CLI itself refuses to download over, configure or install over an existing site.
 * Secrets: the admin and database passwords are generated here, held in the vault by reference only, and the admin one reaches the customer ONCE (`handover`): the first successful read consumes it
 * and deletes it from the vault; an unread one expires after 7 days and a reset (`wp user update`) issues a new one. Nothing secret is in a response, a log line, an audit detail or a table.
 */
export class WordPressService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly sites: SitesService,
    private readonly wp: WordPressNodePort,
    private readonly probe: SiteProbe,
    private readonly vault: VaultPort,
    private readonly cfg: HostingConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly kick: (orgId: string, operationId: string) => void = () => undefined,
  ) {}

  /* ───────────── queueing ───────────── */
  /** Idempotent: one `site_apps` row per site (the unique key is the arbiter), one install operation per row. */
  async enqueue(orgId: string, siteId: string): Promise<void> {
    const made = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `INSERT INTO hosting.site_apps (id, site_id, org_id, app) VALUES ($1,$2,$3,'wordpress') ON CONFLICT (site_id) DO NOTHING`,
            [uuidv7(), siteId, orgId],
          )
        ).rowCount,
    );
    if (made) await this.queue(orgId, siteId, null, {});
  }
  private async queue(
    orgId: string,
    siteId: string,
    userId: string | null,
    input: Record<string, unknown>,
  ) {
    const op = await this.ops.create(orgId, {
      kind: KIND.wordpress,
      input: { siteId, ...input },
      resourceKind: 'hosting_site',
      resourceId: siteId,
      createdBy: userId ?? undefined,
      maxAttempts: 5,
    });
    this.kick(orgId, op.id);
    return op.id;
  }
  /** Restart safety: an active WordPress site without its row (a crash between activation and queueing), or a pending row without a live operation, is queued again. */
  async sweep(now = this.clock()): Promise<{ queued: number; expired: number }> {
    const out = { queued: 0, expired: 0 };
    const missing = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.id, s.org_id FROM hosting.sites s WHERE s.app_kind = 'wordpress' AND s.status = 'active' AND NOT EXISTS (SELECT 1 FROM hosting.site_apps a WHERE a.site_id = s.id) LIMIT 50`,
          )
        ).rows,
    );
    for (const m of missing) {
      await this.enqueue(m.org_id as string, m.id as string);
      out.queued++;
    }
    const orphans = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT a.site_id, a.org_id FROM hosting.site_apps a WHERE a.state = 'pending' AND a.updated_at < $1::timestamptz - interval '2 minutes'
               AND NOT EXISTS (SELECT 1 FROM platform.operations o WHERE o.kind = $2 AND o.resource_id = a.site_id AND o.state IN ('pending','running','needs_reconcile')) LIMIT 50`,
            [now, KIND.wordpress],
          )
        ).rows,
    );
    for (const o of orphans) {
      await this.queue(o.org_id as string, o.site_id as string, null, {});
      await this.db.withPlatformScope((c) =>
        c.query(`UPDATE hosting.site_apps SET updated_at = now() WHERE site_id = $1`, [o.site_id]),
      );
      out.queued++;
    }
    // an unread handover does not live forever: the secret leaves the vault
    const old = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE hosting.site_apps SET handover_state = 'expired', updated_at = now() WHERE handover_state = 'pending' AND handover_expires_at <= $1 RETURNING admin_secret_ref`,
            [now],
          )
        ).rows,
    );
    for (const r of old) {
      if (r.admin_secret_ref) await this.vault.delete(r.admin_secret_ref as string);
      out.expired++;
    }
    return out;
  }

  /* ───────────── customer reads and actions ───────────── */
  private async appRow(orgId: string, siteId: string): Promise<Row> {
    await this.sites.row(orgId, siteId); // another organization's site: 404
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM hosting.site_apps WHERE site_id = $1 AND org_id = $2`, [
            siteId,
            orgId,
          ])
        ).rows[0],
    );
    if (!r) throw new ProblemException('not_found', 'this site has no managed application');
    return r;
  }
  private domainOf(site: Row) {
    return `${site.node_name as string}.${this.cfg.defaultDomainSuffix}`;
  }
  private dto(a: Row, site: Row): WordPressDto {
    const domain = this.domainOf(site);
    return {
      app: 'wordpress',
      state: a.state as WordPressDto['state'],
      phase: (a.phase as string | null) ?? null,
      siteUrl: `https://${domain}`,
      loginUrl: a.state === 'ready' ? `https://${domain}/wp-admin` : null,
      adminUser: (a.admin_user as string | null) ?? null,
      handover: { state: a.handover_state as string, expiresAt: iso(a.handover_expires_at) },
      verification: (a.verification as WordPressDto['verification']) ?? {},
      attempts: Number(a.attempts),
      lastError: (a.last_error as string | null) ?? null,
      installedAt: iso(a.installed_at),
      verifiedAt: iso(a.verified_at),
    };
  }
  async get(orgId: string, siteId: string): Promise<WordPressDto> {
    const site = await this.sites.row(orgId, siteId);
    return this.dto(await this.appRow(orgId, siteId), site);
  }

  /** `failed` → a new install attempt on the same site (it resumes from what the site shows; content is kept). */
  async retry(
    orgId: string,
    actor: Caller,
    siteId: string,
  ): Promise<{ operationId: string; wordpress: WordPressDto }> {
    const site = await this.sites.row(orgId, siteId);
    const a = await this.appRow(orgId, siteId);
    if (site.status !== 'active')
      throw new ProblemException('site_not_active', 'only an active site can be set up');
    if (a.state !== 'failed')
      throw new ProblemException(
        'conflict',
        `the installation is ${a.state as string}: only a failed one is retried`,
      );
    const moved = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE hosting.site_apps SET state = 'pending', last_error = NULL, updated_at = now() WHERE site_id = $1 AND state = 'failed'`,
            [siteId],
          )
        ).rowCount,
    );
    if (!moved) throw new ProblemException('conflict', 'a retry is already running');
    const operationId = await this.queue(orgId, siteId, actor.userId, {});
    await this.audit.record({
      action: 'hosting.wordpress.retry',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
    });
    return { operationId, wordpress: await this.get(orgId, siteId) };
  }

  /** A new admin password through `wp user update` (the old one may be lost or already consumed); a fresh one-time handover follows. */
  async resetAdmin(orgId: string, actor: Caller, siteId: string): Promise<{ operationId: string }> {
    const a = await this.appRow(orgId, siteId);
    if (a.state !== 'ready') throw new ProblemException('conflict', 'WordPress is not ready yet');
    if (!a.admin_user)
      throw new ProblemException(
        'conflict',
        'this installation was not set up by the platform: reset the password inside WordPress',
      );
    const operationId = await this.queue(orgId, siteId, actor.userId, { reset: true });
    await this.audit.record({
      action: 'hosting.wordpress.reset_requested',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
    });
    return { operationId };
  }

  /**
   * THE one-time handover. The secret is read first, then the single conditional update decides who gets it: two parallel requests cannot both receive it. The vault entry is deleted
   * right after. The caller must send `Cache-Control: no-store` with the answer (the controller does).
   */
  async handover(
    orgId: string,
    actor: Caller,
    siteId: string,
  ): Promise<{ username: string; password: string; loginUrl: string }> {
    const site = await this.sites.row(orgId, siteId);
    const a = await this.appRow(orgId, siteId);
    if (
      a.handover_state === 'expired' ||
      (a.handover_state === 'pending' && (a.handover_expires_at as Date) <= this.clock())
    )
      throw new ProblemException(
        'gone',
        'the one-time access expired: request a new admin password',
      );
    if (a.handover_state !== 'pending' || !a.admin_secret_ref)
      throw new ProblemException(
        'conflict',
        'the one-time access was already used: request a new admin password',
      );
    const raw = await this.vault.read(a.admin_secret_ref as string);
    if (!raw)
      throw new ProblemException(
        'conflict',
        'the one-time access is no longer available: request a new admin password',
      );
    const s = JSON.parse(raw.toString('utf8')) as { user: string; password: string };
    const claimed = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE hosting.site_apps SET handover_state = 'consumed', handover_consumed_at = now(), updated_at = now() WHERE site_id = $1 AND org_id = $2 AND handover_state = 'pending' AND handover_expires_at > $3`,
            [siteId, orgId, this.clock()],
          )
        ).rowCount,
    );
    if (!claimed)
      throw new ProblemException(
        'conflict',
        'the one-time access was already used: request a new admin password',
      );
    await this.vault.delete(a.admin_secret_ref as string);
    await this.audit.record({
      action: 'hosting.wordpress.handover',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
    });
    return {
      username: s.user,
      password: s.password,
      loginUrl: `https://${this.domainOf(site)}/wp-admin`,
    };
  }

  /* ───────────── the operation ───────────── */
  private async load(siteId: string): Promise<Row> {
    const r = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT s.*, n.compute_instance_id FROM hosting.sites s LEFT JOIN hosting.nodes n ON n.id = s.node_id WHERE s.id = $1`,
            [siteId],
          )
        ).rows[0],
    );
    if (!r) throw new PermanentError('the site no longer exists', 'site_gone');
    return r as Row;
  }
  /** Two runs of one operation (a lease that expired under a slow worker) can race for the same step sequence number: the loser records again, the step trail stays consistent. */
  private async step(
    orgId: string,
    opId: string,
    name: string,
    state: 'running' | 'succeeded' | 'failed' | 'skipped',
    detail: Record<string, unknown> = {},
  ) {
    for (let i = 0; ; i++)
      try {
        return await this.db.withOrg(orgId, (c) => recordStep(c, orgId, opId, name, state, detail));
      } catch (e) {
        if ((e as { code?: string }).code !== '23505' || i >= 2) throw e;
      }
  }
  /** A node answer as control flow: failures that retrying cannot fix are permanent; a lost answer is not trusted either way (the next look at the site decides). */
  private must<T>(r: OperationResult<T>, what: string): T | undefined {
    if (r.status === 'succeeded') return r.data;
    if (r.status === 'uncertain')
      throw new Error(`${what}: the answer was lost; the next run looks at the site first`);
    const cat = r.error?.category;
    const msg = `${what}: ${r.error?.message ?? 'failed'}`.slice(0, 200);
    if (cat === 'unsupported' || cat === 'auth')
      throw new PermanentError(msg, r.error?.providerCode ?? 'node_refused');
    throw new Error(msg);
  }

  async execute(o: OpCtx): Promise<Record<string, unknown>> {
    const siteId = o.input.siteId as string;
    const site = await this.load(siteId);
    if (site.status !== 'active')
      throw new PermanentError(`the site is ${site.status as string}`, 'bad_state');
    if (!site.node_id) throw new PermanentError('the site has no node', 'no_node');
    const node: NodeRef = {
      nodeId: site.node_id as string,
      computeInstanceId: site.compute_instance_id as string,
    };
    const ws: WpSite = {
      name: site.node_name as string,
      domain: this.domainOf(site),
      runtime: site.runtime as string,
    };
    const ctx = this.sites.ctx(o.operationId);
    await this.db.withPlatformScope((c) =>
      c.query(
        `INSERT INTO hosting.site_apps (id, site_id, org_id, app) VALUES ($1,$2,$3,'wordpress') ON CONFLICT (site_id) DO NOTHING`,
        [uuidv7(), siteId, o.orgId],
      ),
    );
    const app = (await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM hosting.site_apps WHERE site_id = $1`, [siteId])).rows[0],
    ))!;
    if (o.input.reset === true) return this.executeReset(o, app, node, ws);

    await this.db.withPlatformScope((c) =>
      c.query(
        `UPDATE hosting.site_apps SET state = 'installing', attempts = attempts + 1, last_error = NULL, updated_at = now() WHERE site_id = $1`,
        [siteId],
      ),
    );
    // secrets first, by reference, created once (a retry reuses them: the install may already have used them)
    const base = `vault://hosting/org/${o.orgId}/site/${siteId}`;
    const adminRef = (app.admin_secret_ref as string | null) ?? `${base}/wp-admin`;
    const dbRef = (app.db_secret_ref as string | null) ?? `${base}/wp-db`;
    // the admin identity exists from the first run; its password is (re)generated lazily, only when an install actually needs it (a consumed or expired handover deleted the old one)
    const adminUser = (app.admin_user as string | null) ?? `nz${randomBytes(3).toString('hex')}`;
    if (!app.admin_user)
      await this.db.withPlatformScope((c) =>
        c.query(
          `UPDATE hosting.site_apps SET admin_user = $2, admin_secret_ref = $3 WHERE site_id = $1`,
          [siteId, adminUser, adminRef],
        ),
      );
    if (!app.db_secret_ref) {
      const id = randomBytes(3).toString('hex');
      await this.vault.put(
        dbRef,
        JSON.stringify({
          name: `wp${id}`,
          user: `wp${id}`,
          password: password(),
          prefix: `wp_${randomBytes(2).toString('hex')}x_`,
        }),
      );
      await this.db.withPlatformScope((c) =>
        c.query(
          `UPDATE hosting.site_apps SET db_secret_ref = $2, db_name = $3 WHERE site_id = $1`,
          [siteId, dbRef, `wp${id}`],
        ),
      );
    }
    const sec = JSON.parse((await this.vault.read(dbRef))!.toString('utf8')) as {
      name: string;
      user: string;
      password: string;
      prefix: string;
    };
    const admin = async (): Promise<{ user: string; password: string }> => {
      const raw = await this.vault.read(adminRef);
      if (raw) return JSON.parse(raw.toString('utf8')) as { user: string; password: string };
      const fresh = { user: adminUser, password: password() };
      await this.vault.put(adminRef, JSON.stringify(fresh));
      return fresh;
    };
    const locale = (app.locale as string) ?? 'en_US';

    const observe = async () => {
      const v = await this.probe.observe(node.nodeId, ws.domain);
      await this.db.withPlatformScope((c) =>
        c.query(`UPDATE hosting.site_apps SET phase = $2, updated_at = now() WHERE site_id = $1`, [
          siteId,
          v.phase,
        ]),
      );
      return v;
    };
    let seen = await observe();
    if (!seen.answers) throw new Error('the node did not answer HTTP for this site yet');
    await this.step(o.orgId, o.operationId, 'observe', 'succeeded', { phase: seen.phase });

    await this.step(o.orgId, o.operationId, 'wp_cli', 'running');
    this.must(await this.wp.ensureWpCli(ctx, node, ws), 'wp-cli');
    await this.step(o.orgId, o.operationId, 'wp_cli', 'succeeded');

    let db: { dbName: string; dbUser: string } | undefined;
    const ensureDb = async () => {
      db = this.must(
        await this.wp.ensureDatabase(ctx, node, ws, {
          name: sec.name,
          user: sec.user,
          password: sec.password,
        }),
        'database',
      );
    };
    if (seen.phase === 'none') {
      await this.step(o.orgId, o.operationId, 'database', 'running');
      await ensureDb();
      await this.step(o.orgId, o.operationId, 'database', 'succeeded');
      await this.step(o.orgId, o.operationId, 'download', 'running');
      this.must(await this.wp.prepareDocroot(ctx, node, ws), 'docroot');
      const d = await this.wp.download(ctx, node, ws, locale);
      // a download that "failed" because WordPress is already there (a lost answer last time) is settled by looking again
      if (d.status !== 'succeeded') {
        seen = await observe();
        if (seen.phase === 'none') this.must(d, 'download');
      } else seen = await observe();
      await this.step(o.orgId, o.operationId, 'download', 'succeeded');
    }
    if (seen.phase === 'none')
      throw new Error('WordPress was downloaded but the site does not show it yet');
    if (seen.phase === 'unconfigured') {
      await this.step(o.orgId, o.operationId, 'configure', 'running');
      if (!db) await ensureDb();
      const c = await this.wp.configure(ctx, node, ws, {
        dbName: db!.dbName,
        dbUser: db!.dbUser,
        dbPassword: sec.password,
        prefix: sec.prefix,
        locale,
      });
      if (c.status !== 'succeeded') {
        seen = await observe();
        if (seen.phase === 'unconfigured') this.must(c, 'configure');
      } else seen = await observe();
      await this.step(o.orgId, o.operationId, 'configure', 'succeeded');
    }
    let installedNow = false;
    if (seen.phase === 'uninstalled') {
      await this.step(o.orgId, o.operationId, 'install', 'running');
      // the title is the domain: no space, nothing to escape (the customer renames the site in WordPress)
      const adm = await admin();
      const i = await this.wp.install(ctx, node, ws, {
        title: ws.domain,
        adminUser: adm.user,
        adminPassword: adm.password,
        adminEmail: `wp-admin@${ws.domain}`,
      });
      if (i.status !== 'succeeded') {
        const after = await observe();
        if (after.phase === 'uninstalled') this.must(i, 'install');
      } else await observe();
      installedNow = true;
      await this.step(o.orgId, o.operationId, 'install', 'succeeded');
      await this.db.withPlatformScope((c) =>
        c.query(
          `UPDATE hosting.site_apps SET installed_at = coalesce(installed_at, now()) WHERE site_id = $1`,
          [siteId],
        ),
      );
    }
    // pretty permalinks (Quick Install's web template): a node without the template is reported, it does not fail the install
    const t = await this.wp.applyTemplate(ctx, node, ws);
    await this.step(
      o.orgId,
      o.operationId,
      'template',
      t.status === 'succeeded' ? 'succeeded' : 'skipped',
      t.status === 'succeeded' ? {} : { reason: t.error?.message?.slice(0, 120) ?? 'refused' },
    );

    // verification: what the customer will see, not what the commands said
    await this.step(o.orgId, o.operationId, 'verify', 'running');
    const v = await this.probe.observe(node.nodeId, ws.domain);
    const ok = v.answers && v.phase === 'installed' && v.adminPage;
    if (!ok) {
      await this.step(o.orgId, o.operationId, 'verify', 'failed', {
        phase: v.phase,
        answers: v.answers,
        adminPage: v.adminPage,
      });
      throw new Error(`WordPress is not up yet (${v.detail})`.slice(0, 200));
    }
    const ours = installedNow || app.installed_at !== null;
    const now = this.clock();
    await this.db.withPlatformScope((c) =>
      c.query(
        `UPDATE hosting.site_apps SET state = 'ready', phase = 'installed', verified_at = $2, verification = $3::jsonb, last_error = NULL,
           handover_state = CASE WHEN $4 AND handover_state IN ('none','pending') THEN 'pending' ELSE handover_state END,
           handover_expires_at = CASE WHEN $4 AND handover_state IN ('none','pending') THEN $5 ELSE handover_expires_at END, updated_at = now()
         WHERE site_id = $1`,
        [
          siteId,
          now,
          JSON.stringify({
            answers: v.answers,
            adminPage: v.adminPage,
            checkedAt: now.toISOString(),
          }),
          ours,
          new Date(now.getTime() + HANDOVER_DAYS * 86_400_000),
        ],
      ),
    );
    await this.step(o.orgId, o.operationId, 'verify', 'succeeded', { adopted: !ours });
    await this.audit.record({
      action: 'hosting.wordpress.ready',
      actorType: 'system',
      orgId: o.orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
      detail: { adopted: !ours },
    });
    return { siteId, state: 'ready', adopted: !ours };
  }

  private async executeReset(
    o: OpCtx,
    app: Row,
    node: NodeRef,
    ws: WpSite,
  ): Promise<Record<string, unknown>> {
    if (app.state !== 'ready' || !app.admin_user)
      throw new PermanentError('WordPress is not ready', 'bad_state');
    const ref =
      (app.admin_secret_ref as string | null) ??
      `vault://hosting/org/${o.orgId}/site/${app.site_id as string}/wp-admin`;
    const pw = password();
    // the NEW secret goes to the vault first: if the node call then fails the customer still has the old, working, password and nothing was handed over
    const staged = `${ref}-next`;
    await this.vault.put(staged, JSON.stringify({ user: app.admin_user, password: pw }));
    const r = await this.wp.resetAdminPassword(this.sites.ctx(o.operationId), node, ws, {
      adminUser: app.admin_user as string,
      password: pw,
    });
    if (r.status === 'uncertain')
      throw new NeedsReconcile(
        'the reset answer was lost: the admin password may or may not have changed',
      );
    if (r.status !== 'succeeded') {
      await this.vault.delete(staged);
      this.must(r, 'reset');
    }
    await this.vault.put(ref, JSON.stringify({ user: app.admin_user, password: pw }));
    await this.vault.delete(staged);
    await this.db.withPlatformScope((c) =>
      c.query(
        `UPDATE hosting.site_apps SET admin_secret_ref = $2, handover_state = 'pending', handover_expires_at = $3, handover_consumed_at = NULL, updated_at = now() WHERE site_id = $1`,
        [app.site_id, ref, new Date(this.clock().getTime() + HANDOVER_DAYS * 86_400_000)],
      ),
    );
    await this.audit.record({
      action: 'hosting.wordpress.admin_reset',
      actorType: 'system',
      orgId: o.orgId,
      resource: { type: 'hosting_site', id: app.site_id as string },
      outcome: 'success',
    });
    return { siteId: app.site_id, reset: true };
  }

  /** The install operation ran out of attempts: the row says so (and why), the monitor raises the alert; the customer or an admin can retry. */
  async failed(orgId: string, siteId: string, reason: string): Promise<void> {
    await this.db.withPlatformScope((c) =>
      c.query(
        `UPDATE hosting.site_apps SET state = 'failed', last_error = $2, updated_at = now() WHERE site_id = $1 AND state <> 'ready'`,
        [siteId, reason.slice(0, 290)],
      ),
    );
    await this.audit.record({
      action: 'hosting.wordpress.failed',
      actorType: 'system',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'failure',
      detail: { reason: reason.slice(0, 200) },
    });
  }
}
