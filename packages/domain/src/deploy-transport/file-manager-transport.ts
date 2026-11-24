import { createHash } from 'node:crypto';
import {
  ArtifactTransportError,
  DEFAULT_TRANSPORT_LIMITS,
  artifactManifestHash,
  assertArtifactAcceptable,
  assertReleaseId,
  type ArtifactTransportPort,
  type ReleaseInfo,
  type TransportArtifact,
  type TransportLimits,
  type TransportSite,
} from './contract';

/**
 * HOST-TRANSPORT, option B (docs/parallel/HOST-TRANSPORT-DECISION-MEMO.md): an `ArtifactTransportPort` built ONLY on the hosting file manager's public operations
 * (list, download, upload, folder, rename, delete: all org-scoped, one site, relative to the site's web root, symlinks refused by the hosting guard). It does not talk to a
 * node and does not know SFTP, the vault or the panel: those stay inside the hosting module. Three narrow ports are injected:
 *
 *   SiteFileTreePort    the file-manager operations (a thin adapter over the hosting `FilesService`/its HTTP API writes this; `SIMULATED` fake: `./file-manager-transport.sim`)
 *   DocrootSwitchPort   the ONE thing the file manager cannot do: change what the domain serves (the Hestia panel command `v-change-web-domain-docroot`, NOT in the hosting line's
 *                       allow-list today). Optional: without it `switchCurrent` and `currentRelease` refuse with `node_unavailable`, they never pretend.
 *   HttpStatusProbePort a plain HTTPS GET of the staged host / live host, status code only (TLS problems are status 0)
 *
 * Layout inside the web root (strategy S1 of the spec, section 4.1; nothing else is created):
 *   .nuzm/releases/<releaseId>/...      a complete release (appears only by ONE directory rename from `.nuzm/tmp/<releaseId>`)
 *   .nuzm/tmp/<releaseId>/...           the release being written (never served as a release; removed on failure and before a retry)
 *   .nuzm/index/<13-digit epoch ms>-<releaseId>   zero-byte creation marker, so `listReleases` is oldest first without reading a mutable ledger (concurrent puts do not collide)
 *
 * Evidence: everything proved over the fake is SIMULATED. Which operations hold on a real node (graceful docroot reload, rename atomicity, permissions) is NOT VERIFIED until the
 * live probe of spec section 4.5 is run; this file claims nothing about it.
 */

export type SiteFileErrorCode =
  'site_not_found' | 'not_found' | 'conflict' | 'too_large' | 'quota' | 'unavailable' | 'io';
export class SiteFileError extends Error {
  constructor(
    readonly code: SiteFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SiteFileError';
  }
}
export interface TreeEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
}
/** The hosting file manager as the transport needs it. Paths are relative to the site's web root, `/`-separated, already checked by the shared artifact rules. */
export interface SiteFileTreePort {
  /** `null` when the folder does not exist; `site_not_found` when the site is missing or another organization's */
  list(siteId: string, dir: string): Promise<TreeEntry[] | null>;
  /** `not_found` when missing */
  read(siteId: string, path: string): Promise<Uint8Array>;
  /** create a file; the parent folder must exist; an existing file is `conflict`; `too_large` (plan upload limit) and `quota` (disk) are distinct from `io` */
  write(siteId: string, path: string, data: Uint8Array): Promise<void>;
  /** create a folder; an existing FOLDER is not an error (idempotent) */
  mkdir(siteId: string, path: string): Promise<void>;
  /** rename a file or folder; the target must not exist (`conflict`) */
  rename(siteId: string, from: string, to: string): Promise<void>;
  /** delete a file, or a folder with everything in it; a missing path is a no-op */
  remove(siteId: string, path: string): Promise<void>;
}
/** Change the document root of the site's domain. `releaseDir` is relative to the web root (e.g. `.nuzm/releases/<id>`); `null` = restore the default root. */
export interface DocrootSwitchPort {
  setDocroot(siteId: string, releaseDir: string | null): Promise<void>;
  /** the stored docroot read back from the panel, relative to the web root; `null` = the default root */
  getDocroot(siteId: string): Promise<string | null>;
}
export interface HttpStatusProbePort {
  status(
    site: TransportSite,
    where: { release: string } | 'live',
    path: string,
  ): Promise<{ status: number }>;
}

export const RELEASES_DIR = '.nuzm/releases';
export const TMP_DIR = '.nuzm/tmp';
export const INDEX_DIR = '.nuzm/index';
const INDEX_RE = /^(\d{13})-([a-z0-9][a-z0-9-]{7,63})$/;

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export interface FileManagerTransportOptions {
  limits?: Partial<TransportLimits>;
  /** injected clock (epoch ms) for the creation markers */
  now?: () => number;
  /** a real file-manager transport answers false only after its live verification (evidence record); default true = every result is SIMULATED */
  simulated?: boolean;
}

export class FileManagerArtifactTransport implements ArtifactTransportPort {
  readonly simulated: boolean;
  private readonly limits: TransportLimits;
  private readonly now: () => number;
  private lastStamp = 0;
  private tmpSerial = 0;
  /** one chain per site: put, switch and remove of the SAME site never interleave inside this process (T-17); across processes the unique tmp folder and the one-step rename decide */
  private readonly chains = new Map<string, Promise<unknown>>();
  private serial<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(siteId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(siteId, tail);
    void tail.then(() => {
      if (this.chains.get(siteId) === tail) this.chains.delete(siteId);
    });
    return run;
  }
  constructor(
    private readonly tree: SiteFileTreePort,
    private readonly probePort: HttpStatusProbePort,
    private readonly docroot: DocrootSwitchPort | null = null,
    opts: FileManagerTransportOptions = {},
  ) {
    this.limits = { ...DEFAULT_TRANSPORT_LIMITS, ...opts.limits };
    this.now = opts.now ?? (() => Date.now());
    this.simulated = opts.simulated ?? true;
  }

  /** map the file manager's errors to the transport's codes; nothing else (no path, no content) is carried over */
  private fail(
    e: unknown,
    fallback: 'transfer_failed' | 'node_unavailable' = 'transfer_failed',
  ): never {
    if (e instanceof ArtifactTransportError) throw e;
    if (e instanceof SiteFileError) {
      switch (e.code) {
        case 'site_not_found':
          throw new ArtifactTransportError('site_not_found', 'site not found');
        case 'too_large':
        case 'quota':
          throw new ArtifactTransportError(
            'limit_exceeded',
            'the plan does not allow this release',
          );
        case 'unavailable':
          throw new ArtifactTransportError('node_unavailable', 'the file manager is not available');
        default:
          throw new ArtifactTransportError(
            fallback,
            'the file manager could not complete the operation',
          );
      }
    }
    throw new ArtifactTransportError(fallback, 'the file manager could not complete the operation');
  }
  private async guarded<T>(
    fn: () => Promise<T>,
    fallback?: 'transfer_failed' | 'node_unavailable',
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      return this.fail(e, fallback);
    }
  }

  /** the site must exist and be ours: asked first by EVERY call, so another organization's site answers exactly like a missing one */
  private async assertSite(site: TransportSite) {
    await this.guarded(() => this.tree.list(site.id, ''), 'node_unavailable');
  }

  private releasePath = (id: string) => `${RELEASES_DIR}/${id}`;
  private tmpPath = (id: string) => `${TMP_DIR}/${id}`;

  private async ensureDirs(siteId: string, path: string) {
    const parts = path.split('/');
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      await this.tree.mkdir(siteId, acc);
    }
  }

  /** every file under `dir` (relative path within it, bytes read as stored), sorted by path; a folder that is missing gives `null` */
  private async readTree(
    siteId: string,
    dir: string,
  ): Promise<{ path: string; content: Uint8Array }[] | null> {
    const top = await this.tree.list(siteId, dir);
    if (top === null) return null;
    const out: { path: string; content: Uint8Array }[] = [];
    const walk = async (rel: string, entries: TreeEntry[]) => {
      for (const e of entries) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.type === 'dir') await walk(p, (await this.tree.list(siteId, `${dir}/${p}`)) ?? []);
        else out.push({ path: p, content: await this.tree.read(siteId, `${dir}/${p}`) });
      }
    };
    await walk('', top);
    return out;
  }

  private async indexEntries(
    siteId: string,
  ): Promise<{ stamp: string; id: string; name: string }[]> {
    const l = (await this.tree.list(siteId, INDEX_DIR)) ?? [];
    const out: { stamp: string; id: string; name: string }[] = [];
    for (const e of l) {
      const m = INDEX_RE.exec(e.name);
      if (e.type === 'file' && m) out.push({ stamp: m[1]!, id: m[2]!, name: e.name });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async hasRelease(site: TransportSite, releaseId: string): Promise<boolean> {
    return this.guarded(async () => {
      await this.assertSite(site);
      try {
        assertReleaseId(releaseId);
      } catch {
        return false;
      }
      const l = await this.tree.list(site.id, RELEASES_DIR);
      return !!l?.some((e) => e.type === 'dir' && e.name === releaseId);
    });
  }

  async listReleases(site: TransportSite): Promise<string[]> {
    return this.guarded(async () => {
      await this.assertSite(site);
      const present = new Set(
        ((await this.tree.list(site.id, RELEASES_DIR)) ?? [])
          .filter((e) => e.type === 'dir')
          .map((e) => e.name),
      );
      // a marker without a directory is a leftover of a half-finished removal: not listed. A directory without a marker (cannot be created by this class) is not listed either.
      return (await this.indexEntries(site.id)).map((x) => x.id).filter((id) => present.has(id));
    });
  }

  async readReleaseHash(site: TransportSite, releaseId: string): Promise<string | null> {
    return this.guarded(async () => {
      await this.assertSite(site);
      try {
        assertReleaseId(releaseId);
      } catch {
        return null;
      }
      const files = await this.readTree(site.id, this.releasePath(releaseId));
      return files && files.length > 0 ? artifactManifestHash(files) : null;
    });
  }

  putRelease(
    site: TransportSite,
    releaseId: string,
    artifact: TransportArtifact,
  ): Promise<ReleaseInfo> {
    // validation first, synchronously rejecting before anything is queued or written
    try {
      assertReleaseId(releaseId);
      assertArtifactAcceptable(artifact, this.limits);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.serial(site.id, () => this.putLocked(site, releaseId, artifact));
  }
  private async putLocked(
    site: TransportSite,
    releaseId: string,
    artifact: TransportArtifact,
  ): Promise<ReleaseInfo> {
    assertReleaseId(releaseId);
    const { files, bytes } = assertArtifactAcceptable(artifact, this.limits);
    await this.assertSite(site);
    // idempotent for the same tree; a different tree under the same id is refused and untouched
    if (await this.hasRelease(site, releaseId)) {
      const have = await this.readReleaseHash(site, releaseId);
      if (have === artifact.hash) return { releaseId, hash: artifact.hash, files, bytes };
      throw new ArtifactTransportError('release_exists', 'a different tree already holds this id');
    }
    // a folder name of this attempt only: a leftover of an earlier cut-short attempt (or of another process) is never reused or trusted
    const tmp = `${this.tmpPath(releaseId)}-${this.now().toString(36)}${(this.tmpSerial++).toString(36)}`;
    return this.guarded(async () => {
      try {
        await this.ensureDirs(site.id, tmp);
        const made = new Set<string>();
        for (const f of [...artifact.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
          const segs = f.path.split('/');
          for (let i = 1; i < segs.length; i++) {
            const d = `${tmp}/${segs.slice(0, i).join('/')}`;
            if (!made.has(d)) {
              await this.tree.mkdir(site.id, d);
              made.add(d);
            }
          }
          await this.tree.write(site.id, `${tmp}/${f.path}`, f.content);
        }
        // what was actually written, read back from the node before the release becomes visible
        const back = await this.readTree(site.id, tmp);
        const written = back ? artifactManifestHash(back) : null;
        if (written !== artifact.hash)
          throw new ArtifactTransportError(
            'transfer_failed',
            'the stored tree does not match what was sent',
          );
        await this.ensureDirs(site.id, RELEASES_DIR);
        try {
          await this.tree.rename(site.id, tmp, this.releasePath(releaseId)); // the ONE step that makes the release visible
        } catch (e) {
          // another process finished the same id first: idempotent when it holds the same tree, otherwise refused (never overwritten)
          if (e instanceof SiteFileError && e.code === 'conflict') {
            const other = await this.readReleaseHash(site, releaseId);
            await this.tree.remove(site.id, tmp).catch(() => undefined);
            if (other === artifact.hash) return { releaseId, hash: artifact.hash, files, bytes };
            throw new ArtifactTransportError(
              'release_exists',
              'a different tree already holds this id',
            );
          }
          throw e;
        }
        await this.ensureDirs(site.id, INDEX_DIR);
        const stamp = Math.max(this.now(), this.lastStamp + 1);
        this.lastStamp = stamp;
        await this.tree.write(
          site.id,
          `${INDEX_DIR}/${String(stamp).padStart(13, '0')}-${releaseId}`,
          new Uint8Array(),
        );
        return { releaseId, hash: written, files, bytes };
      } catch (e) {
        await this.tree.remove(site.id, tmp).catch(() => undefined);
        throw e;
      }
    });
  }

  switchCurrent(
    site: TransportSite,
    releaseId: string,
  ): Promise<{ previousReleaseId: string | null }> {
    return this.serial(site.id, () => this.switchLocked(site, releaseId));
  }
  private async switchLocked(
    site: TransportSite,
    releaseId: string,
  ): Promise<{ previousReleaseId: string | null }> {
    await this.assertSite(site);
    if (!this.docroot)
      throw new ArtifactTransportError(
        'node_unavailable',
        'no document-root switch is available (the panel command is not allow-listed: spec section 4)',
      );
    assertReleaseId(releaseId);
    if (!(await this.hasRelease(site, releaseId)))
      throw new ArtifactTransportError('release_not_found', 'release not found on the node');
    const previousReleaseId = await this.currentRelease(site);
    // the spec's order quirk: the release folder is verified present BEFORE the panel command (done above), and the stored docroot is read back AFTER it
    await this.guarded(
      () => this.docroot!.setDocroot(site.id, this.releasePath(releaseId)),
      'node_unavailable',
    );
    const now = await this.currentRelease(site);
    if (now !== releaseId)
      throw new ArtifactTransportError('transfer_failed', 'the panel did not apply the switch');
    return { previousReleaseId };
  }

  async currentRelease(site: TransportSite): Promise<string | null> {
    await this.assertSite(site);
    if (!this.docroot)
      throw new ArtifactTransportError('node_unavailable', 'no document-root switch is available');
    const d = await this.guarded(() => this.docroot!.getDocroot(site.id), 'node_unavailable');
    if (d === null) return null;
    if (!d.startsWith(`${RELEASES_DIR}/`)) return null; // the default root, or something this transport did not set
    const id = d.slice(RELEASES_DIR.length + 1);
    return /^[a-z0-9][a-z0-9-]{7,63}$/.test(id) ? id : null;
  }

  async probe(
    site: TransportSite,
    where: { release: string } | 'live',
    path: string,
  ): Promise<{ status: number }> {
    await this.assertSite(site);
    if (where !== 'live') {
      assertReleaseId(where.release);
      if (!(await this.hasRelease(site, where.release))) return { status: 404 };
    } else if (this.docroot && (await this.currentRelease(site)) === null) {
      return { status: 404 }; // "no live release yet" is never a 200
    }
    return this.guarded(() => this.probePort.status(site, where, path), 'node_unavailable');
  }

  removeRelease(site: TransportSite, releaseId: string): Promise<void> {
    return this.serial(site.id, () => this.removeLocked(site, releaseId));
  }
  private async removeLocked(site: TransportSite, releaseId: string): Promise<void> {
    await this.assertSite(site);
    assertReleaseId(releaseId);
    if (this.docroot && (await this.currentRelease(site)) === releaseId)
      throw new ArtifactTransportError(
        'live_release_protected',
        'the live release is never removed',
      );
    await this.guarded(async () => {
      // marker first, so a half-finished removal never lists a release that is partly gone
      for (const m of await this.indexEntries(site.id))
        if (m.id === releaseId) await this.tree.remove(site.id, `${INDEX_DIR}/${m.name}`);
      await this.tree.remove(site.id, this.releasePath(releaseId));
    });
  }

  /** Remove every leftover write folder of this site (a crash mid-put leaves one). Only call while no put of this site is running; the deploy module calls it before a deployment. */
  sweepTmp(site: TransportSite): Promise<number> {
    return this.serial(site.id, async () => {
      await this.assertSite(site);
      const l = (await this.tree.list(site.id, TMP_DIR)) ?? [];
      for (const e of l) await this.tree.remove(site.id, `${TMP_DIR}/${e.name}`);
      return l.length;
    });
  }
}

/** hex sha256 of bytes, exported for adapters that report a per-file hash */
export const fileSha256 = sha;
