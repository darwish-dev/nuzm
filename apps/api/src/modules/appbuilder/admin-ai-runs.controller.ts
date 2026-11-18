import { Controller, Get, Query } from '@nestjs/common';
import { RequirePlatformPermission } from '../../common/access';
import { RealmOnly } from '../identity';
import { RunStorePort, type RunState } from './internal/ports/m09';

/** `GET /v1/admin/ai/runs` (docs/04 §2.9): the read-only support view: METADATA only (kind, state, budget, usage, region); never prompts, outputs or files. */
@RealmOnly('admin')
@Controller('v1/admin/ai/runs')
export class AdminAiRunsController {
  constructor(private readonly runs: RunStorePort) {}
  @RequirePlatformPermission('admin:ai:read')
  @Get()
  async list(@Query('state') state?: string, @Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const items = await this.runs.listAll({
      ...(state ? { state: state as RunState } : {}),
      limit: n,
    });
    return {
      items: items.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        kind: r.kind,
        projectId: r.projectId,
        state: r.state,
        reason: r.reason,
        budget: r.budget,
        usage: r.usage,
        dataRegion: r.dataRegion,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        flags: {
          budgetBreach: r.state === 'budget_exceeded',
          deniedApproval: r.reason === 'approval_rejected',
          escalated: r.reason === 'escalated_to_human',
        },
      })),
    };
  }
}
