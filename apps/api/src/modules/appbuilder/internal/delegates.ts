import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import type { ProjectTypeDelegate } from '../../builder';
import type { WebappDeployDelegate } from '../../deploy';
import type { ChangeService } from './changes/change.service';
import { isUuid } from './core';
import type { AppDeploymentService } from './deploy/deployment.service';
import { APP_BUILDER_FLAG, flagOn } from './flag.guard';
import type { ProjectsPort } from './ports/m09';

const enabled = async (db: Db, orgId: string) => {
  if (!(await flagOn(db, orgId, APP_BUILDER_FLAG)))
    throw new ProblemException('not_found', 'the app builder is not enabled for this organization');
};

/** `POST /v1/builder/projects/{id}/changes` for `webapp` projects: the M10 safe-diff patch set (M09 owns the path and dispatches here). */
export class WebappChangesDelegate implements ProjectTypeDelegate {
  constructor(
    private readonly db: Db,
    private readonly projects: ProjectsPort,
    private readonly changes: ChangeService,
  ) {}
  async applyChanges(
    orgId: string,
    userId: string,
    projectId: string,
    body: Record<string, unknown>,
  ) {
    await enabled(this.db, orgId);
    const project = await this.projects.get(orgId, projectId);
    if (!project) throw new ProblemException('not_found', 'project not found');
    return this.changes.apply(orgId, userId, project, { ...body, source: 'user' });
  }
}

/** `/v1/deployments/**` for `webapp` projects (M09 owns the paths and dispatches here by project type / by which table holds the deployment). */
export class WebappDeployDelegateImpl implements WebappDeployDelegate {
  constructor(
    private readonly db: Db,
    private readonly projects: ProjectsPort,
    private readonly deployments: AppDeploymentService,
  ) {}
  async create(orgId: string, userId: string, body: Record<string, unknown>) {
    await enabled(this.db, orgId);
    if (!isUuid(body.projectId))
      throw new ProblemException('validation_failed', 'projectId is required');
    const project = await this.projects.get(orgId, body.projectId.toLowerCase());
    if (!project) throw new ProblemException('not_found', 'project not found');
    const r = await this.deployments.create(orgId, userId, project, body);
    if (r.created && process.env.APPBUILDER_KICK !== 'off')
      setImmediate(
        () =>
          void this.deployments
            .execute(orgId, userId, project, r.deployment.id)
            .catch(() => undefined),
      );
    return r.deployment;
  }
  async list(orgId: string, projectId: string, limit: number) {
    await enabled(this.db, orgId);
    return { items: await this.deployments.list(orgId, { projectId, limit }), nextCursor: null };
  }
  async find(orgId: string, id: string) {
    try {
      const d = await this.deployments.get(orgId, id.toLowerCase());
      return { id: d.id };
    } catch {
      return null;
    }
  }
  async get(orgId: string, id: string) {
    await enabled(this.db, orgId);
    return this.deployments.get(orgId, id.toLowerCase());
  }
  async logs(orgId: string, id: string) {
    await enabled(this.db, orgId);
    return { items: await this.deployments.logs(orgId, id.toLowerCase()) };
  }
  async rollback(orgId: string, userId: string, id: string) {
    await enabled(this.db, orgId);
    const dep = await this.deployments.get(orgId, id.toLowerCase());
    const project = await this.projects.get(orgId, dep.projectId);
    if (!project) throw new ProblemException('not_found', 'project not found');
    return (await this.deployments.rollback(orgId, userId, project, dep.id)).deployment;
  }
}
