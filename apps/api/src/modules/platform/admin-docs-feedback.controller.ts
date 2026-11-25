import { Controller, Get, Query } from '@nestjs/common';
import { RequirePlatformPermission } from '../../common/access';
import { RealmOnly } from '../identity';
import { DocsFeedbackService } from './docs-feedback.service';

/** `GET /v1/admin/docs-feedback`: the ratings per page (staff with `admin:reports:read`). Counts only. */
@RealmOnly('admin')
@Controller('v1/admin/docs-feedback')
export class AdminDocsFeedbackController {
  constructor(private readonly feedback: DocsFeedbackService) {}

  @RequirePlatformPermission('admin:reports:read')
  @Get()
  summary(@Query('days') days?: string) {
    return this.feedback.summary(days);
  }
}
