import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { MobileBuilderEnabledGuard } from './internal/flag.guard';
import { ReleaseService } from './internal/releases/release.service';

type B = Record<string, unknown> | undefined;

/**
 * `/v1/mobile/releases` (docs/04 §2.10): store-submission PREPARATION records, status draft -> prepared. 422 `release_checklist_incomplete` when `prepared` is requested with items missing.
 * The owner-approval step, a read-by-id and the submission-preparation export have no path in docs/04: SCR-M10B-02 (service methods exist and are tested; no route is registered).
 * The platform never submits to a store.
 */
@UseGuards(MobileBuilderEnabledGuard)
@Controller('v1/mobile/releases')
export class ReleasesController {
  constructor(private readonly releases: ReleaseService) {}
  @RequirePermission('mobile:release')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: B) {
    return this.releases.create(orgId, a.actor.userId, body ?? {});
  }
  @RequirePermission('mobile:release')
  @Get()
  async list(@Org() orgId: string, @Query() q: { projectId?: string }) {
    return { items: await this.releases.list(orgId, q.projectId ? { projectId: q.projectId } : {}) };
  }
}
