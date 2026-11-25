import { chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executionGateway as eg } from '@nuzm/domain';
import {
  forceRemoveTree,
  listOutputs,
  readFileConfined,
  UnsafePath,
  writeFileConfined,
} from './fs-safe';
import type { QuotaDriver } from './quota';

/**
 * The agent's workspaces on disk. Layout (all under `workspaceRoot`, which is a dedicated XFS volume on a real node):
 *
 *   <root>/<workspaceId>/            0700 agent-owned: not traversable by the sandbox user
 *       meta.json                    the agent's own record (org, run, quota, created): OUTSIDE every sandbox mount
 *       work/                        mounted at /work (read-write)
 *       scratch/                     mounted at /scratch (read-write, noexec)
 *
 * `meta.json` is what lets the node answer `listWorkspaces` after an agent restart (the node, not the control plane, knows what physically exists) so the control plane can reap
 * orphans. One workspace per run; a workspace is never reused; destroy removes the tree, releases the quota and verifies the path is gone.
 */
export interface WorkspaceMeta {
  workspaceId: string;
  orgId: string;
  runId: string;
  diskMb: number;
  createdAt: number;
}
export class WorkspaceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WorkspaceError';
  }
}
export interface WorkspaceStoreOptions {
  root: string;
  outputRoots: readonly string[];
  /** uid/gid the sandbox runs as: the work and scratch trees are made accessible to it */
  sandboxUid: number;
  sandboxGid: number;
  maxWorkspaceDiskMb: number;
  quota: QuotaDriver;
  now: () => number;
  /** chown the trees to the sandbox user (needs CAP_CHOWN); the simulated node does not */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
}
export class WorkspaceStore {
  constructor(private readonly o: WorkspaceStoreOptions) {}

  dirs(id: string) {
    const base = join(this.o.root, id);
    return {
      base,
      work: join(base, 'work'),
      scratch: join(base, 'scratch'),
      meta: join(base, 'meta.json'),
    };
  }
  async meta(id: string): Promise<WorkspaceMeta | null> {
    try {
      const m = JSON.parse(await readFile(this.dirs(id).meta, 'utf8')) as WorkspaceMeta;
      return m.workspaceId === id ? m : null;
    } catch {
      return null;
    }
  }
  async create(w: eg.WorkspaceSpec): Promise<void> {
    if (!w.workspaceId.includes(w.runId)) throw new WorkspaceError('workspace_not_bound_to_run');
    if (!(w.diskMb > 0) || w.diskMb > this.o.maxWorkspaceDiskMb)
      throw new WorkspaceError('disk_quota_missing');
    const d = this.dirs(w.workspaceId);
    if ((await lstat(d.base).catch(() => null)) !== null)
      throw new WorkspaceError('workspace_exists');
    await mkdir(d.base, { mode: 0o700 });
    try {
      // 0777 + sticky-free dirs are safe only because `base` is 0700 and the sandbox sees nothing above its own mount
      await mkdir(d.work, { mode: 0o777 });
      await mkdir(d.scratch, { mode: 0o777 });
      await chmod(d.work, 0o777);
      await chmod(d.scratch, 0o777);
      if (this.o.chown) {
        await this.o.chown(d.work, this.o.sandboxUid, this.o.sandboxGid);
        await this.o.chown(d.scratch, this.o.sandboxUid, this.o.sandboxGid);
      }
      await this.o.quota.apply(w.workspaceId, d.base, w.diskMb);
      const meta: WorkspaceMeta = { ...w, createdAt: this.o.now() };
      await writeFile(d.meta, JSON.stringify(meta), { mode: 0o600 });
    } catch (e) {
      await this.destroy(w.workspaceId).catch(() => undefined);
      throw e instanceof WorkspaceError ? e : new WorkspaceError('internal');
    }
  }
  async putFiles(id: string, files: readonly (readonly [string, string])[]): Promise<void> {
    const meta = await this.meta(id);
    if (!meta) throw new WorkspaceError('unknown_workspace');
    const budget = Math.floor((meta.diskMb * 1024 * 1024) / 2); // seed files may use at most half the quota: the workload needs room to write
    let total = 0;
    const d = this.dirs(id);
    for (const [, c] of files) total += Buffer.byteLength(c);
    if (total > budget) throw new WorkspaceError('too_large');
    try {
      for (const [p, c] of files) {
        await writeFileConfined(d.work, p, c, { dirMode: 0o777, fileMode: 0o666 });
        if (this.o.chown) await this.o.chown(join(d.work, p), this.o.sandboxUid, this.o.sandboxGid);
      }
    } catch (e) {
      if (e instanceof UnsafePath) throw new WorkspaceError(e.code);
      throw e;
    }
  }
  async listProduced(id: string) {
    if (!(await this.meta(id))) throw new WorkspaceError('unknown_workspace');
    const { files } = await listOutputs(this.dirs(id).work, this.o.outputRoots);
    return files;
  }
  async readProduced(id: string, path: string, maxBytes: number): Promise<string> {
    if (!(await this.meta(id))) throw new WorkspaceError('unknown_workspace');
    try {
      return await readFileConfined(this.dirs(id).work, path, maxBytes);
    } catch (e) {
      if (e instanceof UnsafePath)
        throw new WorkspaceError(
          e.code === 'path_escapes_workspace'
            ? 'path_escapes_workspace'
            : e.code === 'too_large'
              ? 'too_large'
              : 'not_a_regular_file',
        );
      throw e;
    }
  }
  async usage(id: string) {
    return this.o.quota.usage(id, this.dirs(id).base);
  }
  async list(): Promise<WorkspaceMeta[]> {
    const names = await readdir(this.o.root).catch(() => [] as string[]);
    const out: WorkspaceMeta[] = [];
    for (const n of names) {
      const m = await this.meta(n);
      if (m) out.push(m);
    }
    return out;
  }
  /** directories under the root that have no readable meta (a half-created or damaged workspace): reaped too */
  async strays(): Promise<string[]> {
    const names = await readdir(this.o.root).catch(() => [] as string[]);
    const out: string[] = [];
    for (const n of names) if (!(await this.meta(n))) out.push(n);
    return out;
  }
  /** idempotent; throws `destroy_failed` if anything remains */
  async destroy(id: string): Promise<void> {
    const d = this.dirs(id);
    const ok = await forceRemoveTree(d.base);
    await this.o.quota.release(id).catch(() => undefined);
    if (!ok) throw new WorkspaceError('destroy_failed');
  }
  async exists(id: string): Promise<boolean> {
    return (await lstat(this.dirs(id).base).catch(() => null)) !== null;
  }
}
