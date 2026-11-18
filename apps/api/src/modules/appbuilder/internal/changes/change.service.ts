import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { isUuid, newId, sha256, type Row } from '../core';
import { GitError, GitStore, type CommitInfo } from '../git/git.store';
import { evaluateDependencies, StaticAdvisoryDb, type AdvisoryDbPort, type PackageManifest } from '../policy/dependencies';
import type { CanaryRegistry } from '../sandbox/canary';
import { MAX_FILE_BYTES, checkPath, scanSecrets } from '../sandbox/paths';
import { StaleBaseError, type ProjectRecord, type ProjectsPort, type ProjectVersion } from '../ports/m09';

export type PatchOp = 'add' | 'modify' | 'delete' | 'rename';
export interface Patch {
  op: PatchOp;
  path: string;
  /** add / modify: the full new content (UTF-8 text). */
  content?: string;
  /** rename: the old path. */
  from?: string;
  /** modify / delete / rename: sha256 of the content the patch was written against; a different file answers 409 `base_mismatch`. */
  expectedHash?: string;
}
export interface ChangeRisk {
  code: 'deletes_many_files' | 'edits_applied_migration' | 'changes_dependencies' | 'changes_deploy_manifest' | 'removes_tests';
  message: string;
}
export interface ChangeResult {
  versionId: string;
  commit: string;
  branch: string;
  diff: { added: string[]; modified: string[]; deleted: string[]; renamed: { from: string; to: string }[] };
  risks: ChangeRisk[];
}
export const MAX_PATCHES = 200;
export const MAX_TOTAL_BYTES = 5_000_000;
export const MAX_PROJECT_FILES = 5_000;

/**
 * Safe-diff apply (`POST /v1/builder/projects/{id}/changes`, S46.2): validates every patch (path traversal, secret patterns, canary tokens, size), checks the base
 * version (409 `base_mismatch`), applies the set ATOMICALLY in memory, re-evaluates the dependency policy when the manifest changes, creates the new project version
 * and records one commit (agent changes on a work branch, user changes on `main`). Nothing is written if any patch is refused.
 */
export class ChangeService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly projects: ProjectsPort,
    private readonly git: GitStore,
    private readonly canaries: CanaryRegistry,
    private readonly advisories: AdvisoryDbPort = new StaticAdvisoryDb(),
  ) {}

  /** `builder.git_repos`: one repository per project, created on first use. */
  async repoFor(orgId: string, project: ProjectRecord): Promise<{ storageRef: string; lastCommit: string | null }> {
    const row = await this.db.withOrg(orgId, async (c) => {
      const found = (await c.query(`SELECT * FROM builder.git_repos WHERE project_id = $1 AND org_id = $2`, [project.id, orgId])).rows[0] as Row | undefined;
      if (found) return found;
      return (
        await c.query(`INSERT INTO builder.git_repos (id, org_id, project_id, storage_ref, data_region) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id) DO UPDATE SET default_branch = builder.git_repos.default_branch RETURNING *`, [newId(), orgId, project.id, `${orgId}/${project.id}.git`, project.dataRegion])
      ).rows[0] as Row;
    });
    await this.git.init(row.storage_ref as string);
    return { storageRef: row.storage_ref as string, lastCommit: (row.last_commit as string | null) ?? null };
  }

  validate(patches: unknown): { patches: Patch[]; problems: { path: string; message: string }[] } {
    const problems: { path: string; message: string }[] = [];
    if (!Array.isArray(patches) || patches.length === 0) return { patches: [], problems: [{ path: 'patches', message: 'a non-empty list is required' }] };
    if (patches.length > MAX_PATCHES) return { patches: [], problems: [{ path: 'patches', message: `at most ${MAX_PATCHES} patches per change` }] };
    const out: Patch[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    patches.forEach((raw, i) => {
      const p = raw as Partial<Patch>;
      const at = `patches[${i}]`;
      if (typeof raw !== 'object' || raw === null || !['add', 'modify', 'delete', 'rename'].includes(p.op as string)) return void problems.push({ path: at, message: 'op must be add, modify, delete or rename' });
      const pe = checkPath(p.path);
      if (pe) problems.push({ path: `${at}.path`, message: pe });
      if (p.op === 'rename') {
        const fe = checkPath(p.from);
        if (fe) problems.push({ path: `${at}.from`, message: fe });
      }
      if ((p.op === 'add' || p.op === 'modify') && typeof p.content !== 'string') problems.push({ path: `${at}.content`, message: 'content (text) is required' });
      if (p.op === 'delete' && p.content !== undefined) problems.push({ path: `${at}.content`, message: 'a delete carries no content' });
      if (p.expectedHash !== undefined && !(typeof p.expectedHash === 'string' && /^[0-9a-f]{64}$/.test(p.expectedHash))) problems.push({ path: `${at}.expectedHash`, message: 'must be a sha256 hex' });
      if (typeof p.content === 'string') {
        const size = Buffer.byteLength(p.content);
        bytes += size;
        if (size > MAX_FILE_BYTES) problems.push({ path: `${at}.content`, message: `larger than ${MAX_FILE_BYTES} bytes` });
        for (const f of scanSecrets(p.content)) problems.push({ path: `${at}.content`, message: `a secret pattern (${f.rule}) at line ${f.line}` });
        if (p.content.includes('NZCANARY-')) problems.push({ path: `${at}.content`, message: 'contains a platform canary token' });
      }
      for (const key of [p.path, p.op === 'rename' ? p.from : undefined]) if (typeof key === 'string') {
        if (seen.has(key)) problems.push({ path: `${at}.path`, message: `${key} is changed twice in one change set` });
        seen.add(key);
      }
      if (problems.length === 0 || !problems.some((x) => x.path.startsWith(at))) out.push(p as Patch);
    });
    if (bytes > MAX_TOTAL_BYTES) problems.push({ path: 'patches', message: `more than ${MAX_TOTAL_BYTES} bytes in one change` });
    return { patches: out, problems };
  }

  async apply(orgId: string, actor: string, project: ProjectRecord, body: { baseVersion?: unknown; patches?: unknown; source?: unknown; message?: unknown; branch?: unknown }): Promise<ChangeResult> {
    if (project.type !== 'webapp' && project.type !== 'mobile') throw new ProblemException('unsupported_capability', 'patch-set changes apply to web-app and mobile projects; website projects use the editor operations of M09');
    if (body.baseVersion !== null && body.baseVersion !== undefined && !isUuid(body.baseVersion)) throw new ProblemException('validation_failed', 'baseVersion must be a version id or null');
    const base = (body.baseVersion ?? null) as string | null;
    const source = body.source === 'ai' ? 'ai' : 'user';
    const { patches, problems } = this.validate(body.patches);
    if (problems.length) throw new ProblemException('change_rejected', 'the change set was rejected by the safety checks', problems.map((p) => ({ field: p.path, message: p.message })));
    for (const p of patches) if (typeof p.content === 'string' && (await this.canaries.scan(p.content, { sandboxId: null, source: 'changes api' })).length) throw new ProblemException('change_rejected', 'a platform canary token was found in the change');
    const head = project.headVersionId;
    if (base !== head) throw new ProblemException('base_mismatch', 'the project changed since you loaded it', undefined, { currentVersion: head });
    const files = head ? await this.projects.readFiles(orgId, project.id, head) : new Map<string, string>();
    if (!files) throw new ProblemException('not_found', 'project version not found');
    const next = new Map(files);
    const diff: ChangeResult['diff'] = { added: [], modified: [], deleted: [], renamed: [] };
    const hashMismatch = (path: string, p: Patch, cur: string) => p.expectedHash !== undefined && p.expectedHash !== sha256(cur) && ((): never => { throw new ProblemException('base_mismatch', `${path} changed since you loaded it`, undefined, { path }); })();
    for (const p of patches) {
      if (p.op === 'add') {
        if (next.has(p.path)) throw new ProblemException('change_rejected', `${p.path} already exists`, [{ field: 'path', message: 'already exists' }]);
        next.set(p.path, p.content!);
        diff.added.push(p.path);
      } else if (p.op === 'modify') {
        const cur = next.get(p.path);
        if (cur === undefined) throw new ProblemException('change_rejected', `${p.path} does not exist`, [{ field: 'path', message: 'does not exist' }]);
        hashMismatch(p.path, p, cur);
        next.set(p.path, p.content!);
        diff.modified.push(p.path);
      } else if (p.op === 'delete') {
        const cur = next.get(p.path);
        if (cur === undefined) throw new ProblemException('change_rejected', `${p.path} does not exist`, [{ field: 'path', message: 'does not exist' }]);
        hashMismatch(p.path, p, cur);
        next.delete(p.path);
        diff.deleted.push(p.path);
      } else {
        const cur = next.get(p.from!);
        if (cur === undefined) throw new ProblemException('change_rejected', `${p.from} does not exist`, [{ field: 'from', message: 'does not exist' }]);
        if (next.has(p.path)) throw new ProblemException('change_rejected', `${p.path} already exists`, [{ field: 'path', message: 'already exists' }]);
        hashMismatch(p.from!, p, cur);
        next.delete(p.from!);
        next.set(p.path, cur);
        diff.renamed.push({ from: p.from!, to: p.path });
      }
    }
    if (next.size > MAX_PROJECT_FILES) throw new ProblemException('change_rejected', `a project may have at most ${MAX_PROJECT_FILES} files`);
    const risks: ChangeRisk[] = [];
    if (diff.deleted.length >= 10) risks.push({ code: 'deletes_many_files', message: `${diff.deleted.length} files are deleted` });
    if ([...diff.modified, ...diff.deleted].some((p) => /^db\/migrations\/.+\.sql$/.test(p)) && head) risks.push({ code: 'edits_applied_migration', message: 'an existing migration is edited or deleted: migrations are forward-only, add a new one instead' });
    if ([...diff.modified, ...diff.deleted].some((p) => p.startsWith('tests/'))) risks.push({ code: 'removes_tests', message: 'tests are modified or deleted' });
    if ([...diff.added, ...diff.modified].includes('nuzm.app.json')) risks.push({ code: 'changes_deploy_manifest', message: 'the run, build and deploy commands change' });
    if (next.get('package.json') !== files.get('package.json')) {
      let manifest: PackageManifest;
      try {
        manifest = JSON.parse(next.get('package.json') ?? '{}') as PackageManifest;
      } catch {
        throw new ProblemException('change_rejected', 'package.json is not valid JSON');
      }
      const policy = await evaluateDependencies({ manifest, lockfile: null, advisories: this.advisories, lockfileRequired: false });
      if (!policy.ok) throw new ProblemException('dependency_blocked', policy.findings.filter((f) => f.level === 'block').map((f) => f.message).join('; '));
      risks.push({ code: 'changes_dependencies', message: 'dependencies changed: the lockfile must be regenerated through the package mirror and scanned' });
    }
    let version: ProjectVersion;
    try {
      version = await this.projects.commit(orgId, project.id, { baseVersionId: head, files: next, label: typeof body.message === 'string' ? body.message.slice(0, 120) : null, source, createdBy: actor });
    } catch (e) {
      if (e instanceof StaleBaseError) throw new ProblemException('base_mismatch', 'the project changed since you loaded it', undefined, { currentVersion: e.currentHead });
      throw e;
    }
    const repo = await this.repoFor(orgId, project);
    const branch = source === 'ai' ? 'work/ai' : 'main';
    let commit: CommitInfo;
    try {
      const tip = await this.git.tipOf(repo.storageRef, `refs/heads/${branch}`);
      commit = await this.git.commit(repo.storageRef, branch, next, typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 200) : `${source} change ${version.id.slice(0, 8)}`, { expectedTip: tip });
    } catch (e) {
      if (e instanceof GitError) throw new ProblemException('change_rejected', e.message);
      throw e;
    }
    await this.db.withOrg(orgId, (c) => c.query(`UPDATE builder.git_repos SET last_commit = $2 WHERE project_id = $1`, [project.id, commit.sha]));
    await this.audit.record({ action: 'builder.change.applied', orgId, actorUserId: actor, resource: { type: 'project', id: project.id }, outcome: 'success', after: { versionId: version.id, commit: commit.sha, branch, source, added: diff.added.length, modified: diff.modified.length, deleted: diff.deleted.length, risks: risks.map((r) => r.code) } });
    return { versionId: version.id, commit: commit.sha, branch, diff, risks };
  }

  /** Checkpoint = a tag on the commit that holds the files of a project version. */
  async checkpoint(orgId: string, project: ProjectRecord, name: string, branch = 'main'): Promise<{ name: string; sha: string }> {
    const repo = await this.repoFor(orgId, project);
    const tip = await this.git.tipOf(repo.storageRef, `refs/heads/${branch}`);
    if (!tip) throw new ProblemException('not_found', 'there is no commit on this branch yet');
    try {
      await this.git.tag(repo.storageRef, name, tip);
    } catch (e) {
      if (e instanceof GitError) throw new ProblemException(e.code === 'stale_ref' ? 'conflict' : 'validation_failed', e.message);
      throw e;
    }
    return { name, sha: tip };
  }
}
