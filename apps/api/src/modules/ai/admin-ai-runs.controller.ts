import { Controller, Get, Query } from '@nestjs/common';
import { RequirePlatformPermission } from '../../common/access';
import { parseLimit } from '../../common/pagination';
import { RealmOnly } from '../identity';
import { RunService } from './internal/run.service';

/** `GET /v1/admin/ai/runs`: run METADATA only (state, cost, model, region, error code). Never prompts, outputs, artifacts or checkpoints: content needs break-glass with consent (not built). */
@RealmOnly('admin')
@Controller('v1/admin/ai/runs')
export class AdminAiRunsController {
  constructor(private readonly runs: RunService) {}

  @RequirePlatformPermission('admin:ai:read')
  @Get()
  list(@Query() q: { limit?: string; cursor?: string; orgId?: string; state?: string }) {
    return this.runs.adminList({
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      ...(q.orgId ? { orgId: q.orgId.toLowerCase() } : {}),
      ...(q.state ? { state: q.state } : {}),
    });
  }
}
