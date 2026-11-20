import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { StudioEnabledGuard } from './internal/studio/flag';
import { SkillsService } from './internal/studio/skills.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/** The organization's skill catalog (approved platform skills + its own) and its own private skills. */
@UseGuards(StudioEnabledGuard)
@Controller('v1/builder/skills')
export class StudioSkillsCatalogController {
  constructor(private readonly svc: SkillsService) {}
  @RequirePermission('builder:read')
  @Get()
  catalog(@Org() orgId: string) {
    return this.svc.catalog(orgId);
  }
  /** A private skill of this organization (`{files:[{path,content}]}` with a SKILL.md). Scanned; a reject verdict is refused; never executable. */
  @RequirePermission('builder:write')
  @Idempotent()
  @Post()
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.svc.customerCreate(orgId, a.actor.userId, b(body));
  }
}
