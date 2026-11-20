import { CanActivate, ExecutionContext, Inject, Injectable, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../../common/errors';
import { DB } from '../../../../common/tokens';
import { isUuid } from '../core';
import { flagOn } from '../flag.guard';
import { ProjectsPort, type ProjectRecord } from '../ports/m09';

/** AI Studio (ADR-064): Skills, project instructions, GitHub and the file manager. Default OFF (CLAUDE.md §4); an organization row beats the global row. */
export const AI_STUDIO_FLAG = 'ai_studio.enabled';
/**
 * The Claude Code sandbox PROOF OF CONCEPT (D-38). Default OFF. In production it additionally needs the environment to record the compliance
 * approval (`CLAUDE_CODE_COMPLIANCE=approved`) — D-38 is open, so production refuses even with the flag on.
 */
export const CLAUDE_CODE_FLAG = 'ai.claude_code_sandbox';
export const claudeCodeComplianceApproved = (env: NodeJS.ProcessEnv = process.env) =>
  env.NODE_ENV !== 'production' || env.CLAUDE_CODE_COMPLIANCE === 'approved';

@Injectable()
export class StudioEnabledGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const orgId = req.access?.orgId;
    if (!orgId) return true; // platform routes carry their own permission checks
    if (!(await flagOn(this.db, orgId, AI_STUDIO_FLAG)))
      throw new ProblemException('not_found', 'AI Studio is not enabled for this organization');
    return true;
  }
}

/** A project of THIS organization, any type (a project of another organization is a 404, indistinguishable from a missing one). */
@UseGuards(StudioEnabledGuard)
export abstract class StudioProjectScoped {
  constructor(protected readonly projects: ProjectsPort) {}
  protected async project(orgId: string, id: string): Promise<ProjectRecord> {
    const p = isUuid(id) ? await this.projects.get(orgId, id.toLowerCase()) : null;
    if (!p) throw new ProblemException('not_found', 'project not found');
    return p;
  }
}

/** Project types whose files are a free file tree (patch sets apply to them); a website is a site model and has no free files. */
export const hasFileTree = (p: ProjectRecord) => p.type === 'webapp' || p.type === 'mobile';
