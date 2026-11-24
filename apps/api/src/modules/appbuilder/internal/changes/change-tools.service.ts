import { builderTools } from '@nuzm/domain';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { isUuid } from '../core';
import type { ProjectRecord, ProjectsPort } from '../ports/m09';
import type { CanaryRegistry } from '../sandbox/canary';
import type { ChangeResult, ChangeService } from './change.service';

const { previewChangeSet, opsFromUnifiedDiff, planRestore, planRevert } = builderTools;
type ChangePreview = builderTools.ChangePreview;
type FileOp = builderTools.FileOp;

/** What a preview or a diff returns: the domain preview without the in-memory `next` snapshot, plus where it was computed. */
export type PreviewView = Omit<ChangePreview, 'next'> & {
  baseVersion: string | null;
  headVersion: string | null;
  /** how many lines the hunks of a diff input moved to find their place (0 = exactly where they said) */
  drift: number;
  /** the ops the preview was computed from (a diff input is shown as the whole-file ops it turned into) */
  ops: FileOp[];
};

/**
 * Change preview, version diff, rollback and revert for file-tree projects (S-05 priority 1). The preview is READ-ONLY (a dry run on the head files, nothing stored); a rollback or a
 * revert is computed here and then applied ONLY through `ChangeService.apply` (every safety check again, a new version, a Git commit, audit): history is never rewritten, a rollback is a
 * new version whose files equal the old one. A change that needs a human (many deletions, migrations, pipeline files, a very large change) is refused unless the caller passes
 * `confirmed: true`, which only a person's click sets.
 */
export class ChangeToolsService {
  constructor(
    private readonly projects: ProjectsPort,
    private readonly changes: Pick<ChangeService, 'apply'>,
    private readonly canaries: CanaryRegistry,
    private readonly audit: AuditSink,
  ) {}

  private async files(orgId: string, p: ProjectRecord, versionId: string | null) {
    if (versionId === null) return new Map<string, string>();
    const f = await this.projects.readFiles(orgId, p.id, versionId);
    if (!f) throw new ProblemException('not_found', 'project version not found');
    return f;
  }
  private assertTree(p: ProjectRecord) {
    if (p.type !== 'webapp' && p.type !== 'mobile')
      throw new ProblemException(
        'unsupported_capability',
        'change previews and rollbacks apply to web-app and mobile projects; website projects use the site-model operations',
      );
  }
  private async canaryErrors(ops: readonly FileOp[]): Promise<boolean> {
    for (const o of ops)
      if (typeof o.content === 'string' && (await this.canaries.scan(o.content, { sandboxId: null, source: 'change preview' })).length)
        return true;
    return false;
  }

  /** Dry run: `patches` (whole-file ops, the shape of `POST …/changes`) or a unified `diff`, exactly one of them. Stores nothing. */
  async preview(
    orgId: string,
    p: ProjectRecord,
    body: { baseVersion?: unknown; patches?: unknown; diff?: unknown },
  ): Promise<PreviewView> {
    this.assertTree(p);
    if ((body.patches === undefined) === (body.diff === undefined))
      throw new ProblemException('validation_failed', 'send exactly one of patches or diff');
    const base = body.baseVersion ?? p.headVersionId;
    if (base !== null && !isUuid(base))
      throw new ProblemException('validation_failed', 'baseVersion must be a version id or null');
    if (base !== p.headVersionId)
      throw new ProblemException('base_mismatch', 'the project changed since you loaded it', undefined, {
        currentVersion: p.headVersionId,
      });
    const files = await this.files(orgId, p, p.headVersionId);
    let ops: unknown = body.patches;
    let drift = 0;
    if (body.diff !== undefined) {
      if (typeof body.diff !== 'string')
        throw new ProblemException('validation_failed', 'diff must be text');
      const r = opsFromUnifiedDiff(files, body.diff);
      if (!r.ok)
        throw new ProblemException(
          'change_rejected',
          'the diff was rejected',
          r.errors.map((e) => ({ field: e.at, message: `${e.code}: ${e.message}` })),
        );
      ops = r.ops;
      drift = r.drift;
    }
    const prev = previewChangeSet(files, ops, { hasHead: p.headVersionId !== null });
    if (prev.ok && (await this.canaryErrors(Array.isArray(ops) ? (ops as FileOp[]) : [])))
      prev.errors.push({ at: 'ops', code: 'canary_detected', message: 'a platform canary token was found in the change' });
    prev.ok = prev.errors.length === 0;
    const { next: _next, ...view } = prev;
    return { ...view, baseVersion: base as string | null, headVersion: p.headVersionId, drift, ops: Array.isArray(ops) ? (ops as FileOp[]) : [] };
  }

  /** The diff of two versions of the project (`from` -> `to`). Read-only. */
  async diff(orgId: string, p: ProjectRecord, from: string, to: string): Promise<PreviewView> {
    this.assertTree(p);
    if (!isUuid(from) || !isUuid(to)) throw new ProblemException('validation_failed', 'from and to must be version ids');
    const [a, b] = [await this.files(orgId, p, from.toLowerCase()), await this.files(orgId, p, to.toLowerCase())];
    const ops = planRestore(a, b);
    if (ops.length === 0)
      return {
        ok: true,
        errors: [],
        files: [],
        totals: { files: 0, added: 0, removed: 0 },
        risks: [],
        approval: { required: false, reasons: [] },
        baseVersion: from,
        headVersion: p.headVersionId,
        drift: 0,
        ops: [],
      };
    const { next: _next, ...view } = previewChangeSet(a, ops, { hasHead: true });
    return { ...view, baseVersion: from, headVersion: p.headVersionId, drift: 0, ops };
  }

  /** Rolls the project back to `targetVersion`: a NEW head version with that version's files. */
  async rollback(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    body: { targetVersion?: unknown; baseVersion?: unknown; confirmed?: unknown },
  ): Promise<ChangeResult & { restoredFrom: string }> {
    this.assertTree(p);
    const target = body.targetVersion;
    if (!isUuid(target)) throw new ProblemException('validation_failed', 'targetVersion must be a version id');
    if (body.baseVersion !== undefined && body.baseVersion !== p.headVersionId)
      throw new ProblemException('base_mismatch', 'the project changed since you loaded it', undefined, {
        currentVersion: p.headVersionId,
      });
    if (!p.headVersionId) throw new ProblemException('conflict', 'the project has no version to roll back from');
    if (target.toLowerCase() === p.headVersionId)
      throw new ProblemException('conflict', 'that version already is the head');
    const [cur, want] = [await this.files(orgId, p, p.headVersionId), await this.files(orgId, p, target.toLowerCase())];
    const ops = planRestore(cur, want);
    if (ops.length === 0) throw new ProblemException('conflict', 'that version has the same files as the head');
    return this.applyPlanned(orgId, actor, p, ops, cur, body.confirmed === true, `Rollback to ${target.slice(0, 8)}`, 'builder.change.rolled_back', {
      restoredFrom: target.toLowerCase(),
    }).then((r) => ({ ...r, restoredFrom: target.toLowerCase() }));
  }

  /** Undoes ONE earlier version (`versionId` against its parent), keeping later work; files edited since are reported as conflicts and left alone. */
  async revert(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    body: { versionId?: unknown; baseVersion?: unknown; confirmed?: unknown },
  ): Promise<ChangeResult & { revertedVersion: string; conflicts: string[] }> {
    this.assertTree(p);
    if (!isUuid(body.versionId)) throw new ProblemException('validation_failed', 'versionId must be a version id');
    if (body.baseVersion !== undefined && body.baseVersion !== p.headVersionId)
      throw new ProblemException('base_mismatch', 'the project changed since you loaded it', undefined, {
        currentVersion: p.headVersionId,
      });
    if (!p.headVersionId) throw new ProblemException('conflict', 'the project has no version');
    const v = await this.projects.getVersion(orgId, p.id, body.versionId.toLowerCase());
    if (!v) throw new ProblemException('not_found', 'project version not found');
    const before = await this.files(orgId, p, v.parentId);
    const after = await this.files(orgId, p, v.id);
    const cur = await this.files(orgId, p, p.headVersionId);
    const plan = planRevert(before, after, cur);
    if (plan.ops.length === 0)
      throw new ProblemException(
        'conflict',
        plan.conflicts.length ? 'every file of that change was edited since: nothing can be reverted safely' : 'that version changed nothing',
        plan.conflicts.slice(0, 50).map((path) => ({ field: path, message: 'edited after that change' })),
      );
    const r = await this.applyPlanned(orgId, actor, p, plan.ops, cur, body.confirmed === true, `Revert ${v.id.slice(0, 8)}`, 'builder.change.reverted', {
      revertedVersion: v.id,
      conflicts: plan.conflicts.length,
    });
    return { ...r, revertedVersion: v.id, conflicts: plan.conflicts };
  }

  private async applyPlanned(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    ops: FileOp[],
    cur: ReadonlyMap<string, string>,
    confirmed: boolean,
    message: string,
    action: `${string}.${string}.${string}`,
    extra: Record<string, unknown>,
  ): Promise<ChangeResult> {
    const prev = previewChangeSet(cur, ops, { hasHead: true });
    if (!prev.ok)
      throw new ProblemException(
        'change_rejected',
        'the planned change was rejected by the safety checks',
        prev.errors.slice(0, 20).map((e) => ({ field: e.at, message: `${e.code}: ${e.message}` })),
      );
    if (prev.approval.required && !confirmed)
      throw new ProblemException(
        'change_rejected',
        'this change needs a human confirmation (confirmed: true)',
        prev.approval.reasons.map((r) => ({ field: 'approval', message: r })),
      );
    const result = await this.changes.apply(orgId, actor, p, {
      baseVersion: p.headVersionId,
      patches: ops,
      source: 'restore',
      message,
    });
    await this.audit.record({
      action,
      orgId,
      actorUserId: actor,
      resource: { type: 'project', id: p.id },
      outcome: 'success',
      after: { versionId: result.versionId, files: prev.totals.files, added: prev.totals.added, removed: prev.totals.removed, confirmed, ...extra },
    });
    return result;
  }
}
