import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly } from '../identity';
import { isUuid } from './internal/core';
import { SkillsService } from './internal/studio/skills.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const id = (x: string) => {
  if (!isUuid(x)) throw new ProblemException('not_found', 'not found');
  return x.toLowerCase();
};

/** The platform Skills registry (D-40): import into quarantine, review (two approvers for executable skills), disable. */
@RealmOnly('admin')
@Controller('v1/admin/ai/skills')
export class AdminSkillsController {
  constructor(private readonly svc: SkillsService) {}
  @RequirePlatformPermission('admin:ai:read')
  @Get()
  list(@Query('status') status?: string) {
    return this.svc.adminList(status || undefined);
  }
  @RequirePlatformPermission('admin:ai:read')
  @Get(':id')
  get(@Param('id') sid: string) {
    return this.svc.adminGet(id(sid));
  }
  /** Reads one file of a version (to review it). Never executed. */
  @RequirePlatformPermission('admin:ai:read')
  @Get('versions/:versionId/file')
  file(@Param('versionId') vid: string, @Query('path') path?: string) {
    if (typeof path !== 'string' || !path)
      throw new ProblemException('validation_failed', 'path is required');
    return this.svc.adminFile(id(vid), path);
  }
  /** `{github:{repo, ref, path}}` (public repository, pinned to the commit `ref` resolves to) or `{files:[…]}`. Lands in quarantine. */
  @RequirePlatformPermission('admin:ai:manage')
  @Post('import')
  importSkill(@Platform() who: PlatformContext, @Body() body: Body_) {
    return this.svc.adminImport(who.userId, b(body));
  }
  /** `{decision: approve|reject, note}`. Executable skills need two approvers, neither the importer. */
  @RequirePlatformPermission('admin:ai:approve')
  @Post('versions/:versionId/reviews')
  review(@Platform() who: PlatformContext, @Param('versionId') vid: string, @Body() body: Body_) {
    return this.svc.review(who.userId, id(vid), b(body));
  }
  /** `{status: disabled|approved}` — disabling hides the skill from catalogs and new installs. */
  @RequirePlatformPermission('admin:ai:manage')
  @Post(':id/status')
  @HttpCode(200)
  status(@Platform() who: PlatformContext, @Param('id') sid: string, @Body() body: Body_) {
    return this.svc.setStatus(who.userId, id(sid), b(body).status);
  }
}
