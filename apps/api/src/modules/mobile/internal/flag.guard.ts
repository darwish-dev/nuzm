import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ProblemException } from '../../../common/errors';
import { MobileProjectService } from '../../builder';

export { MOBILE_BUILDER_FLAG } from '../../builder';

/** Feature flag `mobile_builder.enabled` (CLAUDE.md §4, default OFF; an organization row beats the global row) gates every `/v1/mobile/*` route. */
@Injectable()
export class MobileBuilderEnabledGuard implements CanActivate {
  constructor(@Inject(MobileProjectService) private readonly projects: MobileProjectService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const orgId = ctx.switchToHttp().getRequest<FastifyRequest>().access?.orgId;
    if (!orgId) return true; // the access guard decides authentication
    if (!(await this.projects.mobileEnabled(orgId)))
      throw new ProblemException(
        'not_found',
        'the mobile builder is not enabled for this organization',
      );
    return true;
  }
}
