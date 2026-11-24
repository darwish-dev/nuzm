import { createHash, randomBytes } from 'node:crypto';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { VaultPort } from '../ports';
import { guard, webRoot, type Guarded } from './path-guard';
import { SftpError, type SftpAttrs, type SftpConnector, type SftpSession } from './sftp';
import type { SiteToolsService } from './site-tools.service';
import { ToolContext, type ToolNode, type ToolSite } from './tool-context';

/**
 * The file manager: browse, download, upload, edit, rename and delete inside a website's folder, over SFTP as the SITE'S OWN account (never root, never a shell). The path
 * of every action is proven to be inside the folder (`path-guard.ts`), the plan's upload limit and the disk quota are checked before a byte is written, and every
 * mutation is audited (path and size, never content). NOT VERIFIED against a real node: only the local SFTP test double has answered these calls.
 */
export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  modifiedAt: string | null;
}
const MIB = 1024 * 1024;
const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : null);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** valid UTF-8 text without NUL: the only kind of file the editor opens */
const asText = (b: Buffer): string | null => {
  if (b.includes(0)) return null;
  const s = b.toString('utf8');
  return Buffer.from(s, 'utf8').equals(b) ? s : null;
};

export class FilesService {
  constructor(
    private readonly ctx: ToolContext,
    private readonly tools: SiteToolsService,
    private readonly audit: AuditSink,
    private readonly connector: SftpConnector,
    private readonly vault: VaultPort,
  ) {}

  /* ───────────── session ───────────── */
  private async open(site: ToolSite, node: ToolNode): Promise<SftpSession> {
    let secret: Buffer | null;
    try {
      secret = await this.vault.read(site.credentialsRef);
    } catch {
      secret = null;
    }
    if (!secret || !node.panelHost)
      throw new ProblemException(
        'unsupported_capability',
        'the file manager cannot sign in to this site yet',
      );
    let creds: { user?: string; password?: string };
    try {
      creds = JSON.parse(secret.toString('utf8'));
    } catch {
      throw new ProblemException('unsupported_capability', 'the site credentials are unreadable');
    }
    if (creds.user !== site.account || !creds.password)
      throw new ProblemException('unsupported_capability', 'the site credentials are unreadable');
    try {
      const s = await this.connector.open({
        host: node.panelHost,
        port: this.ctx.cfg.sftpPort,
        username: creds.user,
        password: creds.password,
        hostKeySha256: node.sftpHostKey,
        timeoutMs: this.ctx.cfg.sftpTimeoutMs,
      });
      if (!node.sftpHostKey && s.hostKey) {
        // first use: the key seen is pinned; every later connection must match it
        await this.ctx.db.withPlatformScope((c) =>
          c.query(
            `UPDATE hosting.nodes SET sftp_host_key_sha256 = $2 WHERE id = $1 AND sftp_host_key_sha256 IS NULL`,
            [node.id, s.hostKey],
          ),
        );
      }
      return s;
    } catch (e) {
      throw this.fail(e);
    }
  }
  private fail(e: unknown): ProblemException {
    if (e instanceof ProblemException) return e;
    if (e instanceof SftpError) {
      if (e.code === 'too_large')
        return new ProblemException(
          'payload_too_large',
          'the file is larger than the allowed size',
        );
      if (e.code === 'exists')
        return new ProblemException('conflict', 'a file with this name exists');
    }
    return new ProblemException(
      'service_unavailable',
      'the file service of the node is not available right now',
    );
  }

  private async withSession<T>(
    orgId: string,
    siteId: string,
    fn: (s: SftpSession, site: ToolSite, home: string) => Promise<T>,
  ): Promise<T> {
    const site = await this.ctx.site(orgId, siteId);
    const node = await this.tools.need(site, 'files');
    const s = await this.open(site, node);
    try {
      return await fn(s, site, await s.home());
    } catch (e) {
      throw this.fail(e);
    } finally {
      s.close();
    }
  }
  private async root(site: ToolSite, domain: string | undefined) {
    const d = await this.ctx.pickDomain(site, domain);
    return d.domain;
  }

  /* ───────────── reads ───────────── */
  async list(orgId: string, siteId: string, q: { domain?: string; path?: string }) {
    return this.withSession(orgId, siteId, async (s, site, home) => {
      const domain = await this.root(site, q.domain);
      const g = await guard(s, home, webRoot(home, domain), q.path);
      if (!g.attrs || g.attrs.type !== 'dir')
        throw new ProblemException('not_found', 'the folder does not exist');
      const all = await s.readdir(g.abs);
      all.sort(
        (a, b) =>
          Number(b.attrs.type === 'dir') - Number(a.attrs.type === 'dir') ||
          a.name.localeCompare(b.name),
      );
      const max = this.ctx.cfg.listMax;
      const items: FileEntry[] = all.slice(0, max).map((e) => ({
        name: e.name,
        type: e.attrs.type === 'dir' ? 'dir' : e.attrs.type === 'symlink' ? 'symlink' : 'file',
        size: e.attrs.type === 'file' ? e.attrs.size : 0,
        modifiedAt: iso(e.attrs.mtimeMs),
      }));
      return { domain, path: g.parts.join('/'), items, truncated: all.length > max };
    });
  }

  private async regularFile(g: Guarded): Promise<SftpAttrs> {
    if (!g.attrs) throw new ProblemException('not_found', 'the file does not exist');
    if (g.attrs.type !== 'file')
      throw new ProblemException('validation_failed', 'this is not a file');
    return g.attrs;
  }

  async download(orgId: string, siteId: string, q: { domain?: string; path?: string }) {
    return this.withSession(orgId, siteId, async (s, site, home) => {
      const domain = await this.root(site, q.domain);
      const g = await guard(s, home, webRoot(home, domain), q.path, { notRoot: true });
      const at = await this.regularFile(g);
      if (at.size > this.ctx.cfg.maxDownloadBytes)
        throw new ProblemException('payload_too_large', 'the file is too large to download here');
      const data = await s.read(g.abs, this.ctx.cfg.maxDownloadBytes);
      return { name: g.parts[g.parts.length - 1]!, data };
    });
  }

  async readText(orgId: string, siteId: string, q: { domain?: string; path?: string }) {
    return this.withSession(orgId, siteId, async (s, site, home) => {
      const domain = await this.root(site, q.domain);
      const g = await guard(s, home, webRoot(home, domain), q.path, { notRoot: true });
      const at = await this.regularFile(g);
      if (at.size > this.ctx.cfg.maxEditBytes)
        throw new ProblemException('payload_too_large', 'the file is too large to edit here');
      const data = await s.read(g.abs, this.ctx.cfg.maxEditBytes);
      const text = asText(data);
      if (text === null)
        throw new ProblemException('validation_failed', 'only text files can be edited here');
      return { path: g.parts.join('/'), content: text, size: data.length, sha256: sha(data) };
    });
  }

  /* ───────────── writes ───────────── */
  private rec(
    orgId: string,
    userId: string,
    siteId: string,
    action: `${string}.${string}.${string}`,
    detail: Record<string, unknown>,
  ) {
    return this.audit.record({
      action,
      actorUserId: userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_site', id: siteId },
      outcome: 'success',
      detail,
    });
  }
  /** The disk the site already uses (latest report) plus what is about to be written must fit the plan's disk quota. The node's own quota stays the enforcing one. */
  private async checkDisk(site: ToolSite, add: number, replacing: number) {
    const used = await this.ctx.db.withOrg(site.orgId, async (c) =>
      Number(
        (
          await c.query(
            `SELECT disk_bytes FROM hosting.site_usage_reports WHERE site_id = $1 ORDER BY period_start DESC LIMIT 1`,
            [site.id],
          )
        ).rows[0]?.disk_bytes ?? 0,
      ),
    );
    const limit = Number(site.plan.quotas.diskMb) * MIB;
    if (limit > 0 && used - replacing + add > limit)
      throw new ProblemException('quota_exceeded', 'this would exceed the disk space of the plan');
  }

  /** Writes `data` to `g.abs` through a temporary file in the same folder and a rename: a link planted at the final name is replaced, never followed. */
  private async put(s: SftpSession, g: Guarded, data: Buffer) {
    const tmp = `${g.abs.slice(0, g.abs.lastIndexOf('/'))}/.nuzm-upload-${randomBytes(6).toString('hex')}`;
    await s.writeNew(tmp, data);
    try {
      if (g.attrs) await s.unlink(g.abs); // SFTP rename does not replace an existing file
      await s.rename(tmp, g.abs);
    } catch (e) {
      await s.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  async upload(
    orgId: string,
    userId: string,
    siteId: string,
    q: { domain?: string; path?: string; overwrite?: boolean },
    data: Buffer,
  ) {
    if (!Buffer.isBuffer(data))
      throw new ProblemException('validation_failed', 'the body must be the file bytes');
    return this.withSession(orgId, siteId, async (s, site, home) => {
      const limitMb = Math.min(this.ctx.limit(site, 'uploadMb'), this.ctx.cfg.maxUploadMb);
      if (data.length > limitMb * MIB)
        throw new ProblemException(
          'payload_too_large',
          `the plan allows uploads of up to ${limitMb} MB`,
        );
      const domain = await this.root(site, q.domain);
      const g = await guard(s, home, webRoot(home, domain), q.path, { notRoot: true });
      if (g.attrs && g.attrs.type !== 'file')
        throw new ProblemException('conflict', 'a folder with this name exists');
      if (g.attrs && !q.overwrite)
        throw new ProblemException('conflict', 'a file with this name exists');
      await this.checkDisk(site, data.length, g.attrs?.size ?? 0);
      await this.put(s, g, data);
      await this.rec(orgId, userId, siteId, 'hosting.files.uploaded', {
        path: g.parts.join('/').slice(0, 300),
        bytes: data.length,
      });
      return { path: g.parts.join('/'), size: data.length, sha256: sha(data) };
    });
  }

  async edit(
    orgId: string,
    userId: string,
    siteId: string,
    q: { domain?: string; path?: string },
    body: { content?: unknown; expectedSha256?: unknown },
  ) {
    if (typeof body.content !== 'string')
      throw new ProblemException('validation_failed', 'content must be text');
    const data = Buffer.from(body.content, 'utf8');
    if (data.length > this.ctx.cfg.maxEditBytes)
      throw new ProblemException('payload_too_large', 'the text is too large to save here');
    return this.withSession(orgId, siteId, async (s, site, home) => {
      const domain = await this.root(site, q.domain);
      const g = await guard(s, home, webRoot(home, domain), q.path, { notRoot: true });
      const at = await this.regularFile(g);
      // the editor sends the hash of what it opened: a file changed since (by FTP, SSH or a deploy) is a conflict, not silently overwritten
      const current = await s.read(g.abs, this.ctx.cfg.maxEditBytes);
      if (typeof body.expectedSha256 !== 'string' || body.expectedSha256 !== sha(current))
        throw new ProblemException('conflict', 'the file changed since you opened it');
      await this.checkDisk(site, data.length, at.size);
      await this.put(s, g, data);
      await this.rec(orgId, userId, siteId, 'hosting.files.edited', {
        path: g.parts.join('/').slice(0, 300),
        bytes: data.length,
      });
      return { path: g.parts.join('/'), size: data.length, sha256: sha(data) };
    });
  }

  async mkdir(
    orgId: string,
    userId: string,
    siteId: string,
    q: { domain?: string; path?: string },
  ) {
    return this.withSession(orgId, siteId, async (s, site, home) => {
      const domain = await this.root(site, q.domain);
      const g = await guard(s, home, webRoot(home, domain), q.path, { notRoot: true });
      if (g.attrs) throw new ProblemException('conflict', 'something with this name exists');
      await s.mkdir(g.abs);
      await this.rec(orgId, userId, siteId, 'hosting.files.folder_created', {
        path: g.parts.join('/').slice(0, 300),
      });
      return { path: g.parts.join('/') };
    });
  }

  async rename(
    orgId: string,
    userId: string,
    siteId: string,
    q: { domain?: string },
    body: { from?: unknown; to?: unknown },
  ) {
    if (typeof body.from !== 'string' || typeof body.to !== 'string')
      throw new ProblemException('validation_failed', 'from and to are required');
    const { from, to } = body;
    return this.withSession(orgId, siteId, async (s, site, home) => {
      const domain = await this.root(site, q.domain);
      const root = webRoot(home, domain);
      const a = await guard(s, home, root, from, { notRoot: true });
      if (!a.attrs) throw new ProblemException('not_found', 'the source does not exist');
      const b = await guard(s, home, root, to, { notRoot: true });
      if (b.attrs) throw new ProblemException('conflict', 'the target name exists');
      if (a.attrs.type === 'dir' && `${b.abs}/`.startsWith(`${a.abs}/`))
        throw new ProblemException('validation_failed', 'a folder cannot be moved into itself');
      await s.rename(a.abs, b.abs);
      await this.rec(orgId, userId, siteId, 'hosting.files.renamed', {
        from: a.parts.join('/').slice(0, 300),
        to: b.parts.join('/').slice(0, 300),
      });
      return { path: b.parts.join('/') };
    });
  }

  /** Deleting a link removes the link; a folder is removed bottom-up without ever following a link, within a bounded number of entries. */
  async remove(
    orgId: string,
    userId: string,
    siteId: string,
    q: { domain?: string; path?: string; recursive?: boolean },
  ) {
    return this.withSession(orgId, siteId, async (s, site, home) => {
      const domain = await this.root(site, q.domain);
      const g = await guard(s, home, webRoot(home, domain), q.path, {
        notRoot: true,
        allowFinalLink: true,
      });
      if (!g.attrs) throw new ProblemException('not_found', 'it does not exist');
      let removed: number;
      if (g.attrs.type === 'dir') {
        const empty = (await s.readdir(g.abs)).length === 0;
        if (!empty && !q.recursive)
          throw new ProblemException('conflict', 'the folder is not empty');
        const budget = { left: this.ctx.cfg.recursiveDeleteMax };
        removed = await this.rmTree(s, g.abs, budget);
      } else {
        await s.unlink(g.abs); // a file, or the link itself
        removed = 1;
      }
      await this.rec(orgId, userId, siteId, 'hosting.files.deleted', {
        path: g.parts.join('/').slice(0, 300),
        entries: removed,
      });
      return { removed };
    });
  }
  private async rmTree(s: SftpSession, dir: string, budget: { left: number }): Promise<number> {
    let n = 0;
    for (const e of await s.readdir(dir)) {
      if (--budget.left < 0)
        throw new ProblemException(
          'validation_failed',
          'the folder has too many entries to delete at once',
        );
      const p = `${dir}/${e.name}`;
      if (e.attrs.type === 'dir')
        n += await this.rmTree(s, p, budget); // lstat-typed: a link to a folder is `symlink`, never entered
      else {
        await s.unlink(p);
        n++;
      }
    }
    await s.rmdir(dir);
    return n + 1;
  }
}
