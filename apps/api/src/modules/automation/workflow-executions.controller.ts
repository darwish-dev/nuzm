import { Controller, Get, Param } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Delegable, Org, RequirePermission } from '../../common/access';
import { parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { ExecutionService } from './internal/execution.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const page = (q: { limit?: string; cursor?: string }) => ({ limit: parseLimit(q.limit), cursor: q.cursor });
const ifMatch = (req: FastifyRequest) => {
  const v = parseIfMatch(req.headers['if-match']);
  if (v === null) throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
  return v;
};

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
