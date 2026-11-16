import { Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { OperationsService, type Operation } from '@nuzm/platform';
import { Org, RequirePermission } from '../../common/access';
import { ProblemException } from '../../common/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const shape = (o: Operation) => ({
  id: o.id,
  kind: o.kind,
  state: o.state,
  resourceKind: o.resource_kind,
  resourceId: o.resource_id,
  attempts: o.attempts,
  cancelRequested: o.cancel_requested,
  traceId: o.trace_id,
  result: o.result,
  error: o.error,
  createdAt: new Date(o.created_at).toISOString(),
  updatedAt: new Date(o.updated_at).toISOString(),
});

@Controller('v1')
export class OperationsController {
  constructor(private readonly ops: OperationsService) {}

  @RequirePermission('operation:read')
  @Get('operations')
  async list(@Org() orgId: string, @Query() q: Record<string, string>) {
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const before = q.cursor ? Buffer.from(q.cursor, 'base64url').toString('utf8') : undefined;
    const rows = await this.ops.list(orgId, {
      limit: limit + 1,
      before: before && UUID.test(before) ? before : undefined,
    });
    const items = rows.slice(0, limit).map(shape);
    return {
      items,
      nextCursor:
        rows.length > limit ? Buffer.from(items[items.length - 1]!.id).toString('base64url') : null,
    };
  }

  @RequirePermission('operation:read')
  @Get('operations/:id')
  async get(@Org() orgId: string, @Param('id') id: string) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const o = await this.ops.get(orgId, id);
    if (!o) throw new ProblemException('not_found');
    return { ...shape(o), steps: await this.ops.steps(orgId, id) };
  }

  /** 200 when cancelled immediately (it had not started); 202 when a worker must finish cancelling. */
  @RequirePermission('operation:cancel')
  @Post('operations/:id/cancellation')
  @HttpCode(202)
  async cancel(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const r = await this.ops.requestCancel(orgId, id);
    if (r.accepted === 'cancelled') void reply.status(200);
    return r;
  }

  /** Inventory is populated by owning modules from M05 on; the schema is fixed now (docs/04 §2.1). */
  @RequirePermission('resource:read')
  @Get('resources')
  async resources(@Org() _orgId: string) {
    return { items: [] as unknown[], nextCursor: null };
  }
}
