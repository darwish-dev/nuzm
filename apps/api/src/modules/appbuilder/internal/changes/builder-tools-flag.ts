import { CanActivate, ExecutionContext, Inject, Injectable, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../../common/errors';
import { DB } from '../../../../common/tokens';
import { isUuid } from '../core';
import { flagOn } from '../flag.guard';
import { ProjectsPort, type ProjectRecord } from '../ports/m09';

/** The builder-tools capabilities of Session 05 (change preview, rollback, planning, repair loop, project memory, generation planners). Default OFF; an organization row beats the global row (CLAUDE.md §4). */
export const BUILDER_TOOLS_FLAG = 'builder_tools.enabled';

@Injectable()
export class BuilderToolsEnabledGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const orgId = ctx.switchToHttp().getRequest<FastifyRequest>().access?.orgId;
    if (!orgId) return true;
    if (!(await flagOn(this.db, orgId, BUILDER_TOOLS_FLAG)))
      throw new ProblemException(
        'not_found',
        'the builder tools are not enabled for this organization',
      );
    return true;
  }
}

/** A project of THIS organization (another organization's is a 404, indistinguishable from a missing one), behind the builder-tools flag. */
@UseGuards(BuilderToolsEnabledGuard)
export abstract class BuilderToolsProjectScoped {
  constructor(protected readonly projects: ProjectsPort) {}
  protected async project(orgId: string, id: string): Promise<ProjectRecord> {
    const p = isUuid(id) ? await this.projects.get(orgId, id.toLowerCase()) : null;
    if (!p) throw new ProblemException('not_found', 'project not found');
    return p;
  }
}
