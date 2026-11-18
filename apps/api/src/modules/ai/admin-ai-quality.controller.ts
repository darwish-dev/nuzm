import { Controller, Get } from '@nestjs/common';
import { RequirePlatformPermission } from '../../common/access';
import { RealmOnly } from '../identity';
import { EvaluationService } from './internal/evaluation.service';

/** `GET /v1/admin/ai/quality`: evaluation reports vs the (proposed) thresholds. Metrics only; every report says whether the model quality is VERIFIED. */
@RealmOnly('admin')
@Controller('v1/admin/ai/quality')
export class AdminAiQualityController {
  constructor(private readonly evaluation: EvaluationService) {}
  @RequirePlatformPermission('admin:ai:read')
  @Get()
  quality() {
    return this.evaluation.quality();
  }
}
