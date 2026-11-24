import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupSink, BackupSinkPut } from '../ports';

const REGION = /^[A-Za-z0-9._-]{2,40}$/;
const SITE = /^s-[a-z0-9]{12,40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * The off-server backup store as the CONTROL PLANE sees it: one directory per data region (`HOSTING_BACKUP_DIR_<REGION>`), laid out `<root>/<siteName>/<archive>`.
 * The directory is the storage of the region's backup host (the SFTP target of Hestia's `v-add-backup-host`, mounted read/write on the worker host, or the host itself).
 * A reference is `<region>/<siteName>/<archive>`; every segment is validated, so a reference can never leave its region's root.
 * `productionReady` stays false unless the owner has decided D-07 and set `HOSTING_BACKUP_SINK_PRODUCTION=yes`; Hestia's own archive is NOT encrypted by Hestia
 * (nothing documents it), so the at-rest protection of this directory (disk encryption, access) is the backup host's, and is a go-live check of the runbook.
 */
export class RegionDirectorySink implements BackupSink {
  readonly kind = 'production-in-region' as const;
  constructor(
    private readonly roots: Record<string, string>,
    readonly productionReady = false,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RegionDirectorySink | null {
    const roots: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      const m = /^HOSTING_BACKUP_DIR_([A-Z0-9_]+)$/.exec(k);
      if (m && v && v.startsWith('/')) roots[m[1]!.toLowerCase().replace(/_/g, '-')] = v;
    }
    return Object.keys(roots).length
      ? new RegionDirectorySink(roots, env.HOSTING_BACKUP_SINK_PRODUCTION === 'yes')
      : null;
  }

  refOf(region: string, siteName: string, archiveName: string): string {
    return `${region}/${siteName}/${archiveName}`;
  }
  private path(ref: string): string | null {
    const [region, site, name, extra] = ref.split('/');
    if (extra !== undefined || !region || !site || !name) return null;
    const root = this.roots[region];
    if (!root || !REGION.test(region) || !SITE.test(site) || !NAME.test(name)) return null;
    return join(root, site, name);
  }
  async put(
    region: string,
    siteName: string,
    backupId: string,
    data: Buffer,
  ): Promise<BackupSinkPut> {
    const ref = this.refOf(region, siteName, backupId);
    const p = this.path(ref);
    if (!p) throw new Error('the backup reference is not valid for this sink');
    await mkdir(join(this.roots[region]!, siteName), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
    return {
      ref,
      sizeBytes: data.length,
      checksum: createHash('sha256').update(data).digest('hex'),
      region,
    };
  }
  async get(ref: string): Promise<Buffer | null> {
    const p = this.path(ref);
    if (!p) return null;
    return readFile(p).catch(() => null);
  }
  async delete(ref: string): Promise<boolean> {
    const p = this.path(ref);
    if (!p) return false;
    const there = await this.exists(ref);
    await rm(p, { force: true });
    return there;
  }
  async exists(ref: string): Promise<boolean> {
    const p = this.path(ref);
    return p
      ? stat(p).then(
          (s) => s.isFile(),
          () => false,
        )
      : false;
  }
  async list(region: string, siteName: string): Promise<{ name: string; sizeBytes: number }[]> {
    const root = this.roots[region];
    if (!root || !REGION.test(region) || !SITE.test(siteName)) return [];
    const dir = join(root, siteName);
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: { name: string; sizeBytes: number }[] = [];
    for (const n of names) {
      if (!NAME.test(n)) continue;
      const s = await stat(join(dir, n)).catch(() => null);
      if (s?.isFile()) out.push({ name: n, sizeBytes: s.size });
    }
    return out;
  }
  async stat(ref: string): Promise<{ sizeBytes: number; sha256: string } | null> {
    const p = this.path(ref);
    if (!p) return null;
    const s = await stat(p).catch(() => null);
    if (!s?.isFile()) return null;
    const h = createHash('sha256');
    await new Promise<void>((res, rej) =>
      createReadStream(p)
        .on('data', (c) => h.update(c))
        .on('end', res)
        .on('error', rej),
    );
    return { sizeBytes: s.size, sha256: h.digest('hex') };
  }
  async health(region: string): Promise<{ ok: boolean; detail?: string }> {
    const root = this.roots[region];
    if (!root) return { ok: false, detail: 'no backup directory is configured for this region' };
    return access(root, constants.R_OK | constants.W_OK).then(
      () => ({ ok: true }),
      () => ({ ok: false, detail: 'the backup directory is not readable and writable' }),
    );
  }
}
