import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { newId } from '../core';
import type { ProjectRecord, ProjectsPort } from '../ports/m09';
import type { StudioFileWriter } from './files';
import type { GitHostAdapter } from './git-host';

type Row = Record<string, unknown>;
const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/|.*(\.\.|\/\/|@\{|\.lock$|\/$))[A-Za-z0-9._/-]{1,200}$/;
const STATE_TTL_MS = 30 * 60_000;

/**
 * GitHub for builder projects (ADR-064 point 1, D-39). Files move only through `StudioFileWriter` (the safe-diff change path, so secret, canary and
 * dependency checks apply to imported code too). Sync rules: pull refuses when the project changed since the last sync (push first), push refuses
 * when the branch moved on GitHub (pull first) — nothing is overwritten silently and nothing is force-pushed.
 */
export class GitHubService {
  private readonly stateKey: Buffer;
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly projects: ProjectsPort,
    private readonly files: StudioFileWriter,
    /** null when the App is not configured (production without HG-AS-01) */
    private readonly adapter: GitHostAdapter | null,
    stateKey?: string,
  ) {
    this.stateKey = stateKey ? createHash('sha256').update(stateKey).digest() : randomBytes(32);
  }

  private host(): GitHostAdapter {
    if (!this.adapter)
      throw new ProblemException(
        'service_unavailable',
        'the GitHub App is not configured on this platform yet (HG-AS-01)',
      );
    return this.adapter;
  }

  // ---- state that binds an installation callback to an organization and a user -----------------------------------------------------
  private sign(payload: string) {
    return createHmac('sha256', this.stateKey).update(payload).digest('base64url');
  }
  issueState(orgId: string, userId: string, now = Date.now()) {
    const payload = Buffer.from(
      JSON.stringify({ o: orgId, u: userId, e: now + STATE_TTL_MS }),
    ).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }
  private checkState(state: unknown, orgId: string, userId: string, now = Date.now()) {
    if (typeof state !== 'string' || !state.includes('.'))
      throw new ProblemException(
        'forbidden',
        'the installation callback is not bound to this session',
      );
    const [payload, sig] = state.split('.', 2) as [string, string];
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got))
      throw new ProblemException(
        'forbidden',
        'the installation callback is not bound to this session',
      );
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      o: string;
      u: string;
      e: number;
    };
    if (s.o !== orgId || s.u !== userId)
      throw new ProblemException(
        'forbidden',
        'the installation callback belongs to another session',
      );
    if (s.e < now)
      throw new ProblemException('forbidden', 'the installation callback expired; start again');
  }

  // ---- connection ----------------------------------------------------------------------------------------------------------------------
  private connDto(r: Row | undefined) {
    return r
      ? {
          id: r.id as string,
          installationId: Number(r.installation_id),
          accountLogin: r.account_login as string,
          accountType: r.account_type as string,
          repositorySelection: (r.repository_selection as string | null) ?? null,
          adapter: r.adapter as string,
          state: r.state as string,
          connectedAt: new Date(r.created_at as string).toISOString(),
        }
      : null;
  }
  private async active(orgId: string): Promise<Row | undefined> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM builder.github_connections WHERE org_id = $1 AND state <> 'removed'`,
            [orgId],
          )
        ).rows[0] as Row | undefined,
    );
  }
  async connection(orgId: string, userId: string) {
    const r = await this.active(orgId);
    return {
      available: this.adapter !== null,
      adapter: this.adapter?.kind ?? null,
      connection: this.connDto(r),
      installUrl:
        this.adapter && !r ? this.adapter.installUrl(this.issueState(orgId, userId)) : null,
    };
  }
  async connect(orgId: string, userId: string, body: Row) {
    const host = this.host();
    this.checkState(body.state, orgId, userId);
    const installationId = Number(body.installationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0)
      throw new ProblemException('validation_failed', 'installationId is required');
    const inst = await host.getInstallation(installationId);
    // one installation, one organization: a known installation id cannot be claimed by another organization
    const elsewhere = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT org_id FROM builder.github_connections WHERE installation_id = $1 AND state <> 'removed'`,
            [installationId],
          )
        ).rows[0] as Row | undefined,
    );
    if (elsewhere && elsewhere.org_id !== orgId)
      throw new ProblemException(
        'conflict',
        'this GitHub installation is connected to another organization',
      );
    const row = await this.db.withOrg(orgId, async (c) => {
      const cur = (
        await c.query(
          `SELECT * FROM builder.github_connections WHERE org_id = $1 AND state <> 'removed' FOR UPDATE`,
          [orgId],
        )
      ).rows[0] as Row | undefined;
      if (cur)
        throw new ProblemException('conflict', 'GitHub is already connected; disconnect it first');
      return (
        await c.query(
          `INSERT INTO builder.github_connections (id, org_id, installation_id, account_login, account_type, repository_selection, adapter, connected_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            newId(),
            orgId,
            installationId,
            inst.accountLogin,
            inst.accountType,
            inst.repositorySelection,
            host.kind,
            userId,
          ],
        )
      ).rows[0] as Row;
    });
    await this.audit.record({
      action: 'builder.github.connected',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_github_connection', id: row.id as string },
      outcome: 'success',
      detail: { installationId, account: inst.accountLogin },
    });
    return this.connDto(row);
  }
  /** Removes the link on the Nuzm side (the customer uninstalls the App on GitHub to revoke it there); linked projects are unlinked. */
  async disconnect(orgId: string, userId: string) {
    const id = await this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(
          `UPDATE builder.github_connections SET state = 'removed', updated_at = now() WHERE org_id = $1 AND state <> 'removed' RETURNING id`,
          [orgId],
        )
      ).rows[0] as Row | undefined;
      if (!r) throw new ProblemException('not_found', 'GitHub is not connected');
      await c.query(
        `UPDATE builder.github_repos SET state = 'unlinked', updated_at = now() WHERE org_id = $1 AND state = 'linked'`,
        [orgId],
      );
      return r.id as string;
    });
    await this.audit.record({
      action: 'builder.github.disconnected',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_github_connection', id },
      outcome: 'success',
    });
    return { disconnected: true };
  }
  private async conn(orgId: string): Promise<{ id: string; installationId: number }> {
    const r = await this.active(orgId);
    if (!r || r.state !== 'active')
      throw new ProblemException(
        'conflict',
        'GitHub is not connected (or the installation is suspended)',
      );
    return { id: r.id as string, installationId: Number(r.installation_id) };
  }
  async repositories(orgId: string) {
    const c = await this.conn(orgId);
    return { items: await this.host().listRepos(c.installationId) };
  }

  // ---- project link ------------------------------------------------------------------------------------------------------------------
  private linkDto(r: Row | undefined) {
    return r
      ? {
          fullName: r.full_name as string,
          repoId: Number(r.repo_id),
          defaultBranch: r.default_branch as string,
          private: r.private as boolean,
          lastSyncedSha: (r.last_synced_sha as string | null) ?? null,
          lastSyncedVersionId: (r.last_synced_version_id as string | null) ?? null,
          linkedAt: new Date(r.created_at as string).toISOString(),
        }
      : null;
  }
  private async link(orgId: string, p: ProjectRecord): Promise<Row | undefined> {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM builder.github_repos WHERE project_id = $1 AND state = 'linked'`,
            [p.id],
          )
        ).rows[0] as Row | undefined,
    );
  }
  private async mustLink(orgId: string, p: ProjectRecord) {
    const l = await this.link(orgId, p);
    if (!l)
      throw new ProblemException('conflict', 'the project is not linked to a GitHub repository');
    return l;
  }

  /** Link + live status: whether the project or GitHub changed since the last sync. */
  async status(orgId: string, p: ProjectRecord) {
    const l = await this.link(orgId, p);
    if (!l) return { linked: null, remoteTip: null, localChanged: false, remoteChanged: false };
    const c = await this.conn(orgId);
    const tip = await this.host().branchSha(
      c.installationId,
      l.full_name as string,
      l.default_branch as string,
    );
    return {
      linked: this.linkDto(l),
      remoteTip: tip,
      localChanged: (l.last_synced_version_id ?? null) !== p.headVersionId,
      remoteChanged: tip !== (l.last_synced_sha ?? null),
    };
  }
  async linkRepo(orgId: string, userId: string, p: ProjectRecord, body: Row) {
    if (typeof body.fullName !== 'string' || !FULL_NAME.test(body.fullName))
      throw new ProblemException('validation_failed', 'fullName must be owner/name');
    const c = await this.conn(orgId);
    const repo = await this.host().getRepo(c.installationId, body.fullName);
    await this.db.withOrg(orgId, async (q) => {
      if (
        (
          await q.query(
            `SELECT 1 FROM builder.github_repos WHERE project_id = $1 AND state = 'linked' FOR UPDATE`,
            [p.id],
          )
        ).rows[0]
      )
        throw new ProblemException('conflict', 'the project is already linked; unlink it first');
      await q.query(
        `INSERT INTO builder.github_repos (id, org_id, project_id, connection_id, repo_id, full_name, default_branch, private, linked_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          newId(),
          orgId,
          p.id,
          c.id,
          repo.id,
          repo.fullName,
          repo.defaultBranch,
          repo.private,
          userId,
        ],
      );
    });
    await this.audit.record({
      action: 'builder.github.linked',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: p.id },
      outcome: 'success',
      detail: { repo: repo.fullName },
    });
    return this.status(orgId, p);
  }
  async unlink(orgId: string, userId: string, p: ProjectRecord) {
    const n = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE builder.github_repos SET state = 'unlinked', updated_at = now() WHERE project_id = $1 AND state = 'linked'`,
            [p.id],
          )
        ).rowCount ?? 0,
    );
    if (!n) throw new ProblemException('not_found', 'the project is not linked');
    await this.audit.record({
      action: 'builder.github.unlinked',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: p.id },
      outcome: 'success',
    });
    return { unlinked: true };
  }

  private async markSynced(orgId: string, projectId: string, sha: string) {
    const p = await this.projects.get(orgId, projectId);
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE builder.github_repos SET last_synced_sha = $2, last_synced_version_id = $3, updated_at = now() WHERE project_id = $1 AND state = 'linked'`,
        [projectId, sha, p?.headVersionId ?? null],
      ),
    );
  }

  /**
   * Import / pull: the project's files become the repository's files at the default branch (or `ref`). Refused when the project changed since the
   * last sync, unless `replace: true` (first import into a non-empty project needs it too).
   */
  async pull(orgId: string, userId: string, p: ProjectRecord, body: Row) {
    const l = await this.mustLink(orgId, p);
    const c = await this.conn(orgId);
    const ref = typeof body.ref === 'string' && body.ref ? body.ref : (l.default_branch as string);
    if (!BRANCH.test(ref) && !/^[0-9a-f]{40}$/.test(ref))
      throw new ProblemException('validation_failed', 'ref is invalid');
    const local = await this.files.head(orgId, p);
    const dirty = l.last_synced_version_id
      ? l.last_synced_version_id !== p.headVersionId
      : local.size > 0;
    if (dirty && body.replace !== true)
      throw new ProblemException(
        'conflict',
        'the project has changes that are not on GitHub; push them first or confirm replacing them',
      );
    const tree = await this.host().readTree(c.installationId, l.full_name as string, ref);
    const deletes = [...local.keys()].filter((k) => !tree.files.has(k));
    const r = await this.files.apply(
      orgId,
      userId,
      p,
      tree.files,
      deletes,
      `Pull ${l.full_name as string}@${tree.sha.slice(0, 7)}`,
    );
    await this.markSynced(orgId, p.id, tree.sha);
    await this.audit.record({
      action: 'builder.github.pulled',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: p.id },
      outcome: 'success',
      detail: {
        repo: l.full_name,
        sha: tree.sha,
        files: tree.files.size,
        skipped: tree.skipped.length,
      },
    });
    return { sha: tree.sha, changed: r !== null, files: tree.files.size, skipped: tree.skipped };
  }

  /** Push: commits the project's head on top of the last synced commit to `branch` (default: a new `nuzm/…` branch). Never forced. */
  async push(orgId: string, userId: string, p: ProjectRecord, body: Row) {
    const l = await this.mustLink(orgId, p);
    const c = await this.conn(orgId);
    if (!l.last_synced_sha)
      throw new ProblemException('conflict', 'pull the repository once before pushing');
    const branch =
      typeof body.branch === 'string' && body.branch
        ? body.branch
        : `nuzm/${new Date().toISOString().slice(0, 10)}-${(p.headVersionId ?? 'head').slice(0, 8)}`;
    if (!BRANCH.test(branch)) throw new ProblemException('validation_failed', 'branch is invalid');
    const message =
      typeof body.message === 'string' && body.message.trim()
        ? body.message.trim().slice(0, 500)
        : 'Update from Nuzm';
    const host = this.host();
    const base = await host.readTree(
      c.installationId,
      l.full_name as string,
      l.last_synced_sha as string,
    );
    const local = await this.files.head(orgId, p);
    const files = new Map([...local].filter(([k, v]) => base.files.get(k) !== v));
    const deletes = [...base.files.keys()].filter(
      (k) => !local.has(k) && !base.skipped.includes(k),
    );
    if (!files.size && !deletes.length)
      throw new ProblemException(
        'conflict',
        'nothing to push: the project matches the last synced commit',
      );
    const out = await host.commit(c.installationId, l.full_name as string, {
      branch,
      baseSha: l.last_synced_sha as string,
      files,
      deletes,
      message,
    });
    if (branch === l.default_branch) await this.markSynced(orgId, p.id, out.sha);
    await this.audit.record({
      action: 'builder.github.pushed',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: p.id },
      outcome: 'success',
      detail: {
        repo: l.full_name,
        branch,
        sha: out.sha,
        changed: files.size,
        deleted: deletes.length,
      },
    });
    return { branch, sha: out.sha, changed: files.size, deleted: deletes.length };
  }

  async pullRequest(orgId: string, userId: string, p: ProjectRecord, body: Row) {
    const l = await this.mustLink(orgId, p);
    const c = await this.conn(orgId);
    if (typeof body.head !== 'string' || !BRANCH.test(body.head))
      throw new ProblemException('validation_failed', 'head (a branch) is required');
    const title =
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim().slice(0, 200)
        : 'Changes from Nuzm';
    const pr = await this.host().openPullRequest(c.installationId, l.full_name as string, {
      head: body.head,
      base:
        typeof body.base === 'string' && BRANCH.test(body.base)
          ? body.base
          : (l.default_branch as string),
      title,
      body: typeof body.body === 'string' ? body.body.slice(0, 10000) : '',
    });
    await this.audit.record({
      action: 'builder.github.pr_opened',
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'builder_project', id: p.id },
      outcome: 'success',
      detail: { repo: l.full_name, number: pr.number },
    });
    return pr;
  }
  async pullRequests(orgId: string, p: ProjectRecord) {
    const l = await this.mustLink(orgId, p);
    const c = await this.conn(orgId);
    return { items: await this.host().listPullRequests(c.installationId, l.full_name as string) };
  }

  // ---- webhooks ------------------------------------------------------------------------------------------------------------------------
  /** Unauthenticated by design: the HMAC over the raw body is the authentication; deliveries are deduped by `X-GitHub-Delivery`. */
  async webhook(raw: string | undefined, headers: Record<string, unknown>) {
    const host = this.host();
    const sig =
      typeof headers['x-hub-signature-256'] === 'string'
        ? headers['x-hub-signature-256']
        : undefined;
    if (raw === undefined || !host.verifyWebhook(raw, sig))
      throw new ProblemException('invalid_signature', 'the webhook signature is invalid');
    const delivery = headers['x-github-delivery'];
    const event = headers['x-github-event'];
    if (
      typeof delivery !== 'string' ||
      !delivery ||
      delivery.length > 100 ||
      typeof event !== 'string' ||
      !/^[a-z_]{1,60}$/.test(event)
    )
      throw new ProblemException('validation_failed', 'missing delivery or event header');
    const body = JSON.parse(raw) as { action?: string; installation?: { id?: number } };
    const action =
      typeof body.action === 'string' && /^[a-z_]{1,60}$/.test(body.action) ? body.action : null;
    const installationId = Number(body.installation?.id) || null;
    const fresh = await this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `INSERT INTO builder.github_events (id, delivery_id, event, action, installation_id, payload_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (delivery_id) DO NOTHING`,
        [
          newId(),
          delivery,
          event,
          action,
          installationId,
          createHash('sha256').update(raw).digest('hex'),
        ],
      );
      if (!r.rowCount) return false;
      if (event === 'installation' && installationId) {
        const state =
          action === 'deleted'
            ? 'removed'
            : action === 'suspend'
              ? 'suspended'
              : action === 'unsuspend'
                ? 'active'
                : null;
        if (state) {
          await c.query(
            `UPDATE builder.github_connections SET state = $2, updated_at = now() WHERE installation_id = $1 AND state <> 'removed'`,
            [installationId, state],
          );
          if (state === 'removed')
            await c.query(
              `UPDATE builder.github_repos SET state = 'unlinked', updated_at = now() WHERE state = 'linked' AND connection_id IN (SELECT id FROM builder.github_connections WHERE installation_id = $1)`,
              [installationId],
            );
        }
      }
      return true;
    });
    return { received: true, duplicate: !fresh };
  }
}
