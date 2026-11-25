import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner } from './command-runner';
import { treeUsage } from './fs-safe';

/**
 * Per-workspace DISK QUOTA. The workload must not be able to fill the node's volume, so a real node uses XFS PROJECT QUOTAS on the dedicated workspace filesystem (block and inode
 * hard limits per directory tree, enforced by the kernel for every writer including the sandbox). The accounting driver only MEASURES (walk and sum): it cannot stop a running
 * process, so the agent refuses to pair it with the real launcher (`config.parseAgentConfig`) and the attestation records `diskQuota: project-quota` only for the XFS driver.
 *
 * Commands go through the `CommandRunner` as argv arrays. Project ids are allocated by the agent (state file) and never reused while a workspace exists.
 */
export interface QuotaDriver {
  readonly enforcing: boolean;
  /** attach a hard limit to `dir` (bytes via MiB, and an inode cap) */
  apply(workspaceId: string, dir: string, diskMb: number): Promise<void>;
  /** measured use of the tree */
  usage(workspaceId: string, dir: string): Promise<{ diskMb: number; inodes: number }>;
  /** drop the limit (the directory is removed by the caller); idempotent */
  release(workspaceId: string): Promise<void>;
}
/** one inode per ~4 KiB of quota, at least 10 000: a million tiny files cannot defeat a block quota */
export const inodeCapFor = (diskMb: number): number =>
  Math.max(10_000, Math.floor((diskMb * 1024) / 4));

export class XfsProjectQuotaDriver implements QuotaDriver {
  readonly enforcing = true;
  constructor(
    private readonly run: CommandRunner,
    private readonly xfsQuota: string,
    /** mount point of the dedicated XFS workspace volume (mounted with prjquota) */
    private readonly mountPoint: string,
    private readonly stateFile: string,
  ) {}
  private async load(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(this.stateFile, 'utf8')) as Record<string, number>;
    } catch {
      return {};
    }
  }
  private async save(m: Record<string, number>): Promise<void> {
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(m), { mode: 0o600 });
    await rename(tmp, this.stateFile);
  }
  private async x(...cmd: string[]): Promise<void> {
    const r = await this.run.run([this.xfsQuota, '-x', '-c', cmd.join(' '), this.mountPoint], {
      timeoutMs: 30_000,
    });
    if (r.code !== 0) throw new Error('quota_command_failed');
  }
  async apply(workspaceId: string, dir: string, diskMb: number): Promise<void> {
    const m = await this.load();
    let id = m[workspaceId];
    if (id === undefined) {
      const used = new Set(Object.values(m));
      id = 10_000;
      while (used.has(id)) id++;
      m[workspaceId] = id;
      await this.save(m);
    }
    // -s: set up the project for the directory tree; new files inherit the project id
    await this.x('project', '-s', '-p', shq(dir), String(id));
    await this.x(
      'limit',
      '-p',
      `bhard=${diskMb}m`,
      `bsoft=${diskMb}m`,
      `ihard=${inodeCapFor(diskMb)}`,
      String(id),
    );
  }
  async usage(workspaceId: string, dir: string): Promise<{ diskMb: number; inodes: number }> {
    const m = await this.load();
    const id = m[workspaceId];
    if (id === undefined) return { diskMb: 0, inodes: 0 };
    const r = await this.run.run(
      [this.xfsQuota, '-x', '-c', `report -p -b -i -N`, this.mountPoint],
      { timeoutMs: 30_000 },
    );
    if (r.code === 0) {
      for (const line of r.stdout.split('\n')) {
        const f = line.trim().split(/\s+/);
        // `#<id> <blocks KiB> <soft> <hard> <warn> <inodes> ...` (format verified at qualification: V)
        if (f[0] === `#${id}` && f.length >= 6) {
          const kib = Number(f[1]);
          const inodes = Number(f[5]);
          if (Number.isFinite(kib) && Number.isFinite(inodes))
            return { diskMb: Math.ceil(kib / 1024), inodes };
        }
      }
    }
    const u = await treeUsage(dir);
    return { diskMb: Math.ceil(u.bytes / (1024 * 1024)), inodes: u.entries };
  }
  async release(workspaceId: string): Promise<void> {
    const m = await this.load();
    const id = m[workspaceId];
    if (id === undefined) return;
    try {
      await this.x('limit', '-p', 'bhard=0', 'bsoft=0', 'ihard=0', String(id));
    } finally {
      delete m[workspaceId];
      await this.save(m);
    }
  }
}
/** a path is never interpolated unquoted into an xfs_quota command string */
const shq = (p: string): string => {
  if (/[\s'"\\;$`|&<>()*?\0]/.test(p)) throw new Error('quota_path_unsafe');
  return p;
};

/** measures only: for the simulated node and tests. NOT enforcing. */
export class AccountingQuotaDriver implements QuotaDriver {
  readonly enforcing = false;
  async apply(): Promise<void> {}
  async usage(_id: string, dir: string): Promise<{ diskMb: number; inodes: number }> {
    const u = await treeUsage(dir);
    return { diskMb: Math.ceil(u.bytes / (1024 * 1024)), inodes: u.entries };
  }
  async release(): Promise<void> {}
}
export const quotaStateFile = (stateDir: string): string => join(stateDir, 'quota-projects.json');
