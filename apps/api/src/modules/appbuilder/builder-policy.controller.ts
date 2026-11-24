import { Body, Controller, Get, Put } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { ContentAccessService } from './internal/changes/content-access.service';

/**
 * O-9 (PROPOSED): the organization's own policy on whether a billing administrator may read project content through the builder tools. Default `allow` = today's behaviour.
 * Reading needs `org:read`; changing needs `org:update` (owners and admins). Not behind the builder-tools flag: this is where an owner decides before enabling it.
 * A policy change is a decision of a person: an API key is refused (403) even with the permission (same rule as the deployment policy, DEFECT-4/6).
 */
@Controller('v1/builder/policies/content-access')
export class BuilderPolicyController {
  constructor(private readonly svc: ContentAccessService) {}
  @RequirePermission('org:read')
  @Get()
  get(@Org() orgId: string) {
    return this.svc.get(orgId);
  }
  /** `{mode: "allow" | "deny"}`. Audited (`builder.policy.content_access_changed`). */
  @RequirePermission('org:update')
  @Put()
  put(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    if (a.actor.kind === 'api_key')
      throw new ProblemException(
        'forbidden',
        'a policy is changed by a signed-in person, not an API key',
      );
    return this.svc.set(orgId, a.actor.userId, body ?? {});
  }
}
