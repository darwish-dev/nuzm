import { ProblemException } from '../../../../common/errors';
import type { ChangeService } from '../changes/change.service';
import type { ProjectRecord, ProjectsPort } from '../ports/m09';
import { hasFileTree } from './flag';

/**
 * The ONE way AI Studio writes project files: a patch set through the existing safe-diff change service (path checks, secret and canary scans,
 * dependency policy, a new project version, a Git commit). Only real differences are sent; nothing here bypasses those checks.
 */
export class StudioFileWriter {
  constructor(
    private readonly projects: ProjectsPort,
    private readonly changes: ChangeService,
  ) {}

  async head(orgId: string, p: ProjectRecord): Promise<Map<string, string>> {
    if (!p.headVersionId) return new Map();
    return (await this.projects.readFiles(orgId, p.id, p.headVersionId)) ?? new Map();
  }

  /** Writes `writes` (path → content) and removes `deletes`. Returns null when nothing would change. */
  async apply(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    writes: ReadonlyMap<string, string>,
    deletes: readonly string[],
    message: string,
  ) {
    if (!hasFileTree(p))
      throw new ProblemException(
        'unsupported_capability',
        'a website project is a site model without a free file tree',
      );
    const cur = await this.head(orgId, p);
    const patches: { op: 'add' | 'modify' | 'delete'; path: string; content?: string }[] = [];
    for (const [path, content] of writes) {
      const was = cur.get(path);
      if (was === undefined) patches.push({ op: 'add', path, content });
      else if (was !== content) patches.push({ op: 'modify', path, content });
    }
    for (const path of deletes)
      if (cur.has(path) && !writes.has(path)) patches.push({ op: 'delete', path });
    if (!patches.length) return null;
    return this.changes.apply(orgId, actor, p, { baseVersion: p.headVersionId, patches, message });
  }

  /** Case-insensitive search over the text files of the head version: paths and line matches (at most `limit` hits). */
  async search(orgId: string, p: ProjectRecord, q: string, limit = 200) {
    const needle = q.toLowerCase();
    const hits: { path: string; line: number; preview: string }[] = [];
    const paths: string[] = [];
    for (const [path, content] of await this.head(orgId, p)) {
      if (path.toLowerCase().includes(needle)) paths.push(path);
      if (hits.length >= limit) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && hits.length < limit; i++)
        if (lines[i]!.toLowerCase().includes(needle))
          hits.push({ path, line: i + 1, preview: lines[i]!.trim().slice(0, 200) });
    }
    return {
      query: q,
      paths: paths.slice(0, limit),
      matches: hits,
      truncated: hits.length >= limit,
    };
  }
}
