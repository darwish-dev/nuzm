import { createHash } from 'node:crypto';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../../common/errors';
import { ProjectService } from '../../../builder';
import { CustomerTemplateService } from '../../../knowledge';
import { ChangeService, MAX_PROJECT_FILES, type Patch } from '../changes/change.service';
import { isUuid } from '../core';
import { ProjectsPort } from '../ports/m09';
import { MAX_FILE_BYTES } from '../sandbox/paths';

/**
 * Start a project from a template (S-K7, SCR-K-01 §3 point 2): copies the PINNED, immutable version of a published template into a NEW web-app project of the customer's own, through
 * the same safe-change pipeline every file change uses (path checks, secret and canary scans, size limits, dependency policy, one internal Git commit). The template and every other
 * copy are never modified. Order: eligibility and files first (nothing is created when the template cannot be used), then the project, then the change; if the change is refused the
 * empty project is removed again. Binary files and files that were never stored are not copied and are reported.
 */
export class TemplateStartService {
  constructor(
    private readonly db: Db,
    private readonly templates: CustomerTemplateService,
    private readonly builder: ProjectService,
    private readonly projects: ProjectsPort,
    private readonly changes: ChangeService,
  ) {}

  async start(orgId: string, userId: string, b: Record<string, unknown>) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 1 || name.length > 100)
      throw new ProblemException('validation_failed', 'name must be 1..100 characters');
    if (!isUuid(b.resourceId))
      throw new ProblemException('validation_failed', 'resourceId must be a template id');
    if (b.planId !== undefined && b.planId !== null && !isUuid(b.planId))
      throw new ProblemException('validation_failed', 'planId must be a plan id');
    const prep = await this.templates.prepareCopy(orgId, {
      resourceId: b.resourceId,
      versionId: b.versionId,
      mode: b.adaptationMode,
    });

    const patches: Patch[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const f of prep.files) {
      if (f.bytes > MAX_FILE_BYTES) {
        skipped.push({ path: f.path, reason: 'too_large' });
        continue;
      }
      let buf: Buffer;
      try {
        buf = await this.templates.readFile(f.objectKey);
      } catch {
        throw new ProblemException(
          'unsupported_capability',
          'the template files are not available from the object store right now',
        );
      }
      if (createHash('sha256').update(buf).digest('hex') !== f.sha256)
        throw new ProblemException(
          'unsupported_capability',
          'a stored template file failed its integrity check; the copy was not made',
        );
      if (buf.includes(0)) {
        skipped.push({ path: f.path, reason: 'binary' });
        continue;
      }
      patches.push({ op: 'add', path: f.path, content: buf.toString('utf8') });
    }
    if (patches.length === 0)
      throw new ProblemException(
        'unsupported_capability',
        'this template has no text files to copy',
      );
    const { problems } = this.changes.validate(patches, MAX_PROJECT_FILES);
    if (problems.length)
      throw new ProblemException(
        'change_rejected',
        'the template cannot be copied: some of its files failed the safety checks',
        problems.slice(0, 20).map((p) => ({ field: p.path, message: p.message })),
      );

    const created = await this.builder.create(orgId, userId, { type: 'webapp', name });
    const project = await this.projects.get(orgId, created.id);
    if (!project) throw new ProblemException('not_found', 'project not found');
    let result;
    try {
      result = await this.changes.apply(
        orgId,
        userId,
        project,
        {
          baseVersion: null,
          patches,
          source: 'user',
          message: `Start from template: ${prep.name}`,
        },
        { maxPatches: MAX_PROJECT_FILES },
      );
    } catch (e) {
      await this.builder.remove(orgId, userId, created.id, name).catch(() => undefined); // an empty project is not left behind
      throw e;
    }
    await this.templates.recordCopied(orgId, userId, {
      resourceId: prep.resourceId,
      versionId: prep.versionId,
      projectId: created.id,
      mode: prep.mode,
      usage: prep.usage,
      copied: patches.length,
      skipped: skipped.length,
      planId: typeof b.planId === 'string' ? b.planId : null,
      // what this copy wrote, so the workspace can be compared with it later without the template
      baseline: Object.fromEntries(
        patches.map((p) => [
          p.path,
          createHash('sha256')
            .update(p.content ?? '', 'utf8')
            .digest('hex'),
        ]),
      ),
    });
    return {
      project: { id: created.id, name: created.name, type: created.type },
      versionId: result.versionId,
      commit: result.commit,
      branch: result.branch,
      template: {
        resourceId: prep.resourceId,
        versionId: prep.versionId,
        versionSeq: prep.versionSeq,
        name: prep.name,
        mode: prep.mode,
        usage: prep.usage,
      },
      license: { spdx: prep.license.spdx },
      files: { copied: patches.length, skipped },
      risks: result.risks,
    };
  }

  /** A plan belongs to a project of this organization (another organization's project is a 404). */
  async plan(orgId: string, userId: string, b: Record<string, unknown>) {
    if (!isUuid(b.projectId))
      throw new ProblemException('validation_failed', 'projectId must be a project id');
    const p = await this.projects.get(orgId, b.projectId.toLowerCase());
    if (!p) throw new ProblemException('not_found', 'project not found');
    return this.templates.createPlan(orgId, userId, { projectId: p.id, body: b });
  }
}
