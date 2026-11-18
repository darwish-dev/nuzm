import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ProblemException } from '../../../common/errors';
import { AiFlags } from './flags';

/** Feature flag `ai.enabled` (default OFF, CLAUDE.md §4) gates every customer route of the ai, builder and deploy modules: an org row beats the global row. */
@Injectable()
export class AiEnabledGuard implements CanActivate {
  constructor(private readonly flags: AiFlags) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const orgId = ctx.switchToHttp().getRequest<FastifyRequest>().access?.orgId;
    if (!orgId) return true; // the access guard decides authentication; staff routes are not flag-gated
    if (!(await this.flags.enabled(orgId)))
      throw new ProblemException('not_found', 'AI is not enabled for this organization');
    return true;
  }
}
