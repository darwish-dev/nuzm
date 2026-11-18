import { Controller, Get, Param } from '@nestjs/common';
import { Delegable, Org, RequirePermission } from '../../common/access';
import { ExecutionService } from './internal/execution.service';

@Delegable()
@Controller('v1/workflow-executions')
export class WorkflowExecutionsController {
  constructor(private readonly executions: ExecutionService) {}
  @RequirePermission('automation:read')
  @Get(':id')
  get(@Org() orgId: string, @Param('id') id: string) {
    return this.executions.get(orgId, id.toLowerCase());
  }
}
