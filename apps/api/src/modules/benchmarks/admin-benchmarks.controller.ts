import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { BenchmarksService } from './internal/benchmarks.service';

/**
 * `GET /v1/admin/ai/benchmarks` (dashboard data), `GET /v1/admin/ai/benchmarks/runs/:id`, `POST /v1/admin/ai/benchmarks` (one POST with an `action`). Nothing here calls a model:
 * runs are offline replays of the reference oracle or scripted mocks and every stored run carries its evidence label. Reads need `admin:ai:read`; recording a run, comparing,
 * reviews and qualification steps need `admin:ai:manage`; accepting thresholds, setting the budget, recording the security review and approving a qualification need `admin:ai:approve`.
 * The whole module is behind the feature flag `ai.benchmarks` (default OFF) and is not registered in the application until the Master merges it.
 */
@RealmOnly('admin')
@Controller('v1/admin/ai/benchmarks')
export class AdminBenchmarksController {
  constructor(private readonly svc: BenchmarksService) {}

  @RequirePlatformPermission('admin:ai:read')
  @Get()
  overview() {
    return this.svc.overview();
  }

  @RequirePlatformPermission('admin:ai:read')
  @Get('runs/:id')
  run(@Param('id') id: string) {
    return this.svc.getRun(id);
  }

  @RequirePlatformPermission('admin:ai:read')
  @StepUp()
  @Post()
  @HttpCode(200)
  async act(@Platform() who: PlatformContext, @Body() body: Record<string, unknown> | undefined) {
    const b = body ?? {};
    const need = (p: string) => {
      if (!who.permissions.has(p)) throw new ProblemException('forbidden', `permission ${p} is required for this action`);
    };
    switch (b.action) {
      case 'run_offline':
        need('admin:ai:manage');
        return this.svc.runOffline(who.userId, b);
      case 'compare':
        need('admin:ai:read');
        return this.svc.compare(b.ids);
      case 'accept_thresholds':
        need('admin:ai:approve');
        return this.svc.acceptThresholds(who.userId, b);
      case 'set_budget':
        need('admin:ai:approve');
        return this.svc.setBudget(who.userId, b);
      case 'record_security_review':
        need('admin:ai:approve');
        return this.svc.recordSecurityReview(who.userId, b);
      case 'set_reviewers':
        need('admin:ai:manage');
        return this.svc.setReviewers(who.userId, b);
      case 'create_review_plan':
        need('admin:ai:manage');
        return this.svc.createReviewPlan(who.userId, b);
      case 'submit_review':
        need('admin:ai:manage');
        return this.svc.submitReview(who.userId, b);
      case 'evaluate_gate':
        need('admin:ai:manage');
        return this.svc.evaluateGate(who.userId, b);
      case 'propose_qualification':
        need('admin:ai:manage');
        return this.svc.proposeQualification(who.userId, b);
      case 'qualification_event':
        need(b.type === 'approve' ? 'admin:ai:approve' : 'admin:ai:manage');
        return this.svc.qualificationEvent(who.userId, b);
      case 'attempt_live_run':
        need('admin:ai:approve');
        return this.svc.attemptLiveRun(who.userId, b);
      default:
        throw new ProblemException('validation_failed', 'unknown action');
    }
  }
}
