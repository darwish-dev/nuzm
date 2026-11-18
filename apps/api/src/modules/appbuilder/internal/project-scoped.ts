import { UseGuards } from '@nestjs/common';
import { ProblemException } from '../../../common/errors';
import { AppBuilderEnabledGuard } from './flag.guard';
import { isUuid } from './core';
import { ProjectsPort, type ProjectRecord } from './ports/m09';

/** Common lookup: the project of THIS organization (a project of another organization is a 404, indistinguishable from a missing one). */
@UseGuards(AppBuilderEnabledGuard)
export abstract class ProjectScoped {
  constructor(protected readonly projects: ProjectsPort) {}
  protected async project(orgId: string, id: string): Promise<ProjectRecord> {
    const p = isUuid(id) ? await this.projects.get(orgId, id.toLowerCase()) : null;
    if (!p) throw new ProblemException('not_found', 'project not found');
    return p;
  }
}
