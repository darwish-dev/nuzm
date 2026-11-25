/**
 * `SiteFileTreePort` over the hosting file manager's PUBLIC operations (Phase 3, P3-S07; HOST-TRANSPORT option B). The deploy module imports nothing from the hosting module:
 * `FilesServiceLike` is a structural subset of the hosting `FilesService` (list, download, upload, mkdir, rename, remove), so the hosting wiring passes its own service in. The
 * wiring also decides the org and the acting user: this adapter is bound to ONE organization and ONE actor, and a site of another organization answers `not_found` from the
 * hosting module, which is reported as `site_not_found` (indistinguishable from a missing one).
 *
 * Facts about the file manager that shape this adapter (READ in `FilesService` on `main`, never run):
 *   - a listing is capped (`listMax`, default 1000 entries) and says `truncated`: a truncated folder is an ERROR here, never a silent partial listing (the read-back hash would lie);
 *   - a download is capped (`maxDownloadBytes`, default 50 MiB) and an upload by the plan's `uploadMb`: both surface as `too_large`, which the transport reports as `limit_exceeded`;
 *   - `upload` refuses to overwrite unless asked, `mkdir` of an existing name is a conflict, `rename` refuses an existing target, `remove` needs `recursive` for a folder;
 *   - every call opens an SFTP session as the site's own account (vault, pinned host key) and records an audit event: ONE FILE PER CALL is the real cost of this option, and a 2000-file
 *     release is thousands of calls. The live probe (spec section 4.5, question 8) measures it; nothing here claims a number.
 */
import { deployTransport } from '@nuzm/domain';

const { SiteFileError } = deployTransport;
type SiteFileTreePort = deployTransport.SiteFileTreePort;
type TreeEntry = deployTransport.TreeEntry;

export interface FilesServiceLike {
  list(
    orgId: string,
    siteId: string,
    q: { path?: string },
  ): Promise<{
    items: { name: string; type: 'file' | 'dir' | 'symlink'; size: number }[];
    truncated: boolean;
  }>;
  download(orgId: string, siteId: string, q: { path?: string }): Promise<{ data: Buffer }>;
  upload(
    orgId: string,
    userId: string,
    siteId: string,
    q: { path?: string; overwrite?: boolean },
    data: Buffer,
  ): Promise<unknown>;
  mkdir(orgId: string, userId: string, siteId: string, q: { path?: string }): Promise<unknown>;
  rename(
    orgId: string,
    userId: string,
    siteId: string,
    q: Record<string, never>,
    body: { from?: unknown; to?: unknown },
  ): Promise<unknown>;
  remove(
    orgId: string,
    userId: string,
    siteId: string,
    q: { path?: string; recursive?: boolean },
  ): Promise<unknown>;
}

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

export class FileManagerSiteTree implements SiteFileTreePort {
  constructor(
    private readonly files: FilesServiceLike,
    private readonly orgId: string,
    private readonly userId: string,
  ) {}

  /** map a hosting error (a `ProblemException` code) to the port's codes; `atRoot` = a `not_found` on the web root means the SITE is missing */
  private map(e: unknown, atRoot = false): never {
    if (e instanceof SiteFileError) throw e;
    switch (codeOf(e)) {
      case 'not_found':
        throw new SiteFileError(atRoot ? 'site_not_found' : 'not_found', 'not found');
      case 'conflict':
        throw new SiteFileError('conflict', 'already exists');
      case 'payload_too_large':
        throw new SiteFileError('too_large', 'over the size limit');
      case 'quota_exceeded':
        throw new SiteFileError('quota', 'over the disk quota');
      case 'unsupported_capability':
      case 'service_unavailable':
        throw new SiteFileError('unavailable', 'the file manager is not available');
      default:
        throw new SiteFileError('io', 'the file manager failed');
    }
  }
  private p = (path: string): { path?: string } => (path === '' ? {} : { path });

  async list(siteId: string, dir: string): Promise<TreeEntry[] | null> {
    try {
      const r = await this.files.list(this.orgId, siteId, this.p(dir));
      if (r.truncated)
        throw new SiteFileError('io', 'a folder has more entries than one listing returns');
      const out: TreeEntry[] = [];
      for (const i of r.items) {
        // a link anywhere inside a release would be served from outside it: refuse, never follow
        if (i.type === 'symlink')
          throw new SiteFileError('io', 'a symbolic link is present in the tree');
        out.push({ name: i.name, type: i.type, size: i.size });
      }
      return out;
    } catch (e) {
      if (codeOf(e) === 'not_found' && dir !== '') return null;
      return this.map(e, dir === '');
    }
  }
  async read(siteId: string, path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array((await this.files.download(this.orgId, siteId, { path })).data);
    } catch (e) {
      return this.map(e);
    }
  }
  async write(siteId: string, path: string, data: Uint8Array): Promise<void> {
    try {
      await this.files.upload(
        this.orgId,
        this.userId,
        siteId,
        { path, overwrite: false },
        Buffer.from(data),
      );
    } catch (e) {
      return this.map(e);
    }
  }
  async mkdir(siteId: string, path: string): Promise<void> {
    try {
      await this.files.mkdir(this.orgId, this.userId, siteId, { path });
    } catch (e) {
      // an existing FOLDER is fine (idempotent); an existing FILE of that name is a conflict
      if (codeOf(e) === 'conflict') {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const name = path.slice(path.lastIndexOf('/') + 1);
        const sib = await this.list(siteId, parent).catch(() => null);
        if (sib?.some((x) => x.name === name && x.type === 'dir')) return;
      }
      return this.map(e);
    }
  }
  async rename(siteId: string, from: string, to: string): Promise<void> {
    try {
      await this.files.rename(this.orgId, this.userId, siteId, {}, { from, to });
    } catch (e) {
      return this.map(e);
    }
  }
  async remove(siteId: string, path: string): Promise<void> {
    try {
      await this.files.remove(this.orgId, this.userId, siteId, { path, recursive: true });
    } catch (e) {
      if (codeOf(e) === 'not_found') return; // a missing path is a no-op
      return this.map(e);
    }
  }
}
