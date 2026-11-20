import { Body, Controller, Get, Put } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { StudioSettingsService } from './internal/studio/settings.service';

/**
 * The organization's own AI Studio switches (ADR-064). Not behind `ai_studio.enabled`: this is where the organization turns it on. Reading needs
 * `org:read`; changing needs `org:update` (owners and admins).
 */
@Controller('v1/builder/ai-studio/settings')
export class StudioSettingsController {
  constructor(private readonly svc: StudioSettingsService) {}
  @RequirePermission('org:read')
  @Get()
  get(@Org() orgId: string) {
    return this.svc.get(orgId);
  }
  /** `{aiStudio?: boolean, claudeCode?: boolean}`. Audited (`builder.ai_studio.settings_updated`). */
  @RequirePermission('org:update')
  @Put()
  put(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.svc.set(orgId, a.actor.userId, body ?? {});
  }
}
