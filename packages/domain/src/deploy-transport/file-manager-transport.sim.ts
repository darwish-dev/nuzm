import {
  SiteFileError,
  type DocrootSwitchPort,
  type HttpStatusProbePort,
  type SiteFileTreePort,
  type TreeEntry,
} from './file-manager-transport';
import type { TransportSite } from './contract';

/**
 * SIMULATED stand-ins for the three ports of `FileManagerArtifactTransport`: an in-memory web root per site that behaves like the hosting file manager as documented (one file per
 * call, parent folder must exist, an existing file is a conflict, a per-file upload limit, a disk quota, a directory rename, recursive delete), a docroot switch over it, and a status
 * probe that serves from it. NOT a hosting node: every result obtained over these is SIMULATED. Fault injection is explicit so the shared conformance cases T-18/T-19 can run.
 */
interface Node {
  type: 'file' | 'dir';
  data?: Uint8Array;
}

export class InMemorySiteFileTree implements SiteFileTreePort {
  /** siteId -> path ('' = the web root) -> node */
  private readonly sites = new Map<string, Map<string, Node>>();
  private known: Set<string> | null = null;
  writes = 0;
  /** store different bytes for the NEXT written file (integrity must expose it) */
  corruptNextWrite = false;
  /** fail after this many more successful writes (cut-short transfer); `null` = off */
  failAfterWrites: number | null = null;
  /** per-file upload limit and disk quota (bytes) of the plan; `0` = unlimited */
  maxFileBytes = 0;
  quotaBytes = 0;
  /** the whole file manager is unavailable (vault not granted, node not connected) */
  unavailable = false;

  constructor(readonly siteIds: string[]) {
    for (const id of siteIds) this.sites.set(id, new Map([['', { type: 'dir' }]]));
  }
  /** restrict to these site ids: any other answers `site_not_found` (like another organization's site) */
  onlySites(ids: string[]) {
    this.known = new Set(ids);
    return this;
  }
  private fs(siteId: string) {
    if (this.unavailable) throw new SiteFileError('unavailable', 'file manager unavailable');
    if (this.known && !this.known.has(siteId))
      throw new SiteFileError('site_not_found', 'site not found');
    let m = this.sites.get(siteId);
    if (!m) this.sites.set(siteId, (m = new Map([['', { type: 'dir' }]])));
    return m;
  }
  private used(m: Map<string, Node>) {
    let n = 0;
    for (const v of m.values()) n += v.data?.byteLength ?? 0;
    return n;
  }
  private parent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  private under(m: Map<string, Node>, dir: string) {
    const pre = dir === '' ? '' : `${dir}/`;
    return [...m.keys()].filter((k) => k !== '' && k !== dir && k.startsWith(pre));
  }

  async list(siteId: string, dir: string): Promise<TreeEntry[] | null> {
    const m = this.fs(siteId);
    const d = m.get(dir);
    if (!d || d.type !== 'dir') return null;
    const pre = dir === '' ? '' : `${dir}/`;
    const out: TreeEntry[] = [];
    for (const k of m.keys()) {
      if (k === '' || !k.startsWith(pre)) continue;
      const rest = k.slice(pre.length);
      if (rest.includes('/')) continue;
      const n = m.get(k)!;
      out.push({ name: rest, type: n.type, size: n.data?.byteLength ?? 0 });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  async read(siteId: string, path: string): Promise<Uint8Array> {
    const n = this.fs(siteId).get(path);
    if (!n || n.type !== 'file') throw new SiteFileError('not_found', 'no such file');
    return n.data!;
  }
  async write(siteId: string, path: string, data: Uint8Array): Promise<void> {
    const m = this.fs(siteId);
    const par = m.get(this.parent(path));
    if (!par || par.type !== 'dir') throw new SiteFileError('not_found', 'parent folder missing');
    if (m.has(path)) throw new SiteFileError('conflict', 'a file with this name exists');
    if (this.maxFileBytes > 0 && data.byteLength > this.maxFileBytes)
      throw new SiteFileError('too_large', 'over the per-file upload limit');
    if (this.quotaBytes > 0 && this.used(m) + data.byteLength > this.quotaBytes)
      throw new SiteFileError('quota', 'over the disk quota');
    if (this.failAfterWrites !== null) {
      if (this.failAfterWrites <= 0) {
        this.failAfterWrites = null;
        throw new SiteFileError('io', 'connection reset');
      }
      this.failAfterWrites--;
    }
    this.writes++;
    let stored = data;
    if (this.corruptNextWrite) {
      this.corruptNextWrite = false;
      stored = new Uint8Array([...data, 0]);
    }
    m.set(path, { type: 'file', data: stored.slice() });
  }
  async mkdir(siteId: string, path: string): Promise<void> {
    const m = this.fs(siteId);
    const ex = m.get(path);
    if (ex) {
      if (ex.type === 'dir') return;
      throw new SiteFileError('conflict', 'a file with this name exists');
    }
    const par = m.get(this.parent(path));
    if (!par || par.type !== 'dir') throw new SiteFileError('not_found', 'parent folder missing');
    m.set(path, { type: 'dir' });
  }
  async rename(siteId: string, from: string, to: string): Promise<void> {
    const m = this.fs(siteId);
    const src = m.get(from);
    if (!src || from === '') throw new SiteFileError('not_found', 'source missing');
    if (m.has(to)) throw new SiteFileError('conflict', 'target exists');
    const par = m.get(this.parent(to));
    if (!par || par.type !== 'dir') throw new SiteFileError('not_found', 'target parent missing');
    if (`${to}/`.startsWith(`${from}/`))
      throw new SiteFileError('conflict', 'cannot move into itself');
    const moved = [from, ...this.under(m, from)];
    for (const k of moved) {
      const n = m.get(k)!;
      m.delete(k);
      m.set(to + k.slice(from.length), n);
    }
  }
  async remove(siteId: string, path: string): Promise<void> {
    const m = this.fs(siteId);
    if (path === '') throw new SiteFileError('conflict', 'the root is never removed');
    if (!m.has(path)) return;
    for (const k of this.under(m, path)) m.delete(k);
    m.delete(path);
  }

  /** test helpers: what is on the node */
  paths(siteId: string): string[] {
    return [...this.fs(siteId).keys()].filter((k) => k !== '').sort();
  }
  tamper(siteId: string, path: string, data: Uint8Array) {
    const n = this.fs(siteId).get(path);
    if (n) n.data = data;
  }
}

export class InMemoryDocrootSwitch implements DocrootSwitchPort {
  private readonly roots = new Map<string, string>();
  /** the panel rejects the command (the forum `Error 3` case) */
  rejectNext = false;
  /** the command "succeeds" but nothing changes (a panel that did not apply it) */
  ignoreNext = false;
  calls = 0;
  constructor(private readonly tree: InMemorySiteFileTree) {}
  async setDocroot(siteId: string, releaseDir: string | null): Promise<void> {
    this.calls++;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new SiteFileError('io', 'panel error');
    }
    if (this.ignoreNext) {
      this.ignoreNext = false;
      return;
    }
    // the real command requires the directory to exist inside the domain's folder (E_NOTEXIST otherwise)
    if (releaseDir !== null && (await this.tree.list(siteId, releaseDir)) === null)
      throw new SiteFileError('not_found', 'directory does not exist');
    if (releaseDir === null) this.roots.delete(siteId);
    else this.roots.set(siteId, releaseDir);
  }
  async getDocroot(siteId: string): Promise<string | null> {
    await this.tree.list(siteId, ''); // tenant/site check
    return this.roots.get(siteId) ?? null;
  }
}

/** Serves from the in-memory tree: a staged release from its folder, live from the stored docroot; a path ending in `/` means its `index.html`. */
export class InMemoryStatusProbe implements HttpStatusProbePort {
  /** paths forced to answer a given status (a deliberately broken page) */
  forced = new Map<string, number>();
  constructor(
    private readonly tree: InMemorySiteFileTree,
    private readonly docroot: InMemoryDocrootSwitch,
  ) {}
  async status(site: TransportSite, where: { release: string } | 'live', path: string) {
    const f = this.forced.get(path);
    if (f !== undefined) return { status: f };
    const dir =
      where === 'live' ? await this.docroot.getDocroot(site.id) : `.nuzm/releases/${where.release}`;
    if (dir === null) return { status: 404 };
    const file = path.endsWith('/')
      ? `${path.replace(/^\//, '')}index.html`
      : path.replace(/^\//, '');
    try {
      await this.tree.read(site.id, `${dir}/${file}`);
      return { status: 200 };
    } catch {
      return { status: 404 };
    }
  }
}
