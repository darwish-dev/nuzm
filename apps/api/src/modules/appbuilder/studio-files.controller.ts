import { Controller, Get, Param, Query } from '@nestjs/common';
import { Org, RequirePermission } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { ProjectsPort } from './internal/ports/m09';
import { StudioFileWriter } from './internal/studio/files';
import { StudioProjectScoped } from './internal/studio/flag';
import { ContentRead } from '../builder';

/** Files of a builder project: search (edit, rename, move and delete go through the existing `/changes` route). */
@Controller('v1/builder/projects/:projectId/files')
export class StudioFilesController extends StudioProjectScoped {
  constructor(
    projects: ProjectsPort,
    private readonly files: StudioFileWriter,
  ) {
    super(projects);
  }
  @RequirePermission('builder:read')
  @ContentRead('file_search')
  @Get('search')
  async search(@Org() orgId: string, @Param('projectId') pid: string, @Query('q') q?: string) {
    const p = await this.project(orgId, pid); // isolation first: another organization's project is a 404 whatever the query
    const term = typeof q === 'string' ? q.trim() : '';
    if (term.length > 200)
      throw new ProblemException('validation_failed', 'q is at most 200 characters');
    if (term.length < 2) return { query: term, paths: [], matches: [], truncated: false };
    return this.files.search(orgId, p, term);
  }
}
