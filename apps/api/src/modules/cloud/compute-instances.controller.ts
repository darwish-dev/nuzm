import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { Idempotent } from '../../common/idempotency';
import { InstanceService } from './internal/instance.service';

/** Compute instances (docs/04 §2.5). Create/delete/actions are async (202 + operationId); other organizations' ids answer 404. */
@Controller('v1/compute/instances')
export class ComputeInstancesController {
  constructor(private readonly instances: InstanceService) {}

  @RequirePermission('compute:instance:create')
  @Idempotent()
  @Post()
  @HttpCode(202)
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: FastifyRequest,
  ) {
    const r = await this.instances.create(orgId, a.actor.userId, body, req.traceId ?? '', key);
    return {
      instance: { id: r.instance.id, status: r.instance.status },
      operationId: r.operationId,
    };
  }

  @RequirePermission('compute:instance:read')
  @Get()
  list(@Org() orgId: string, @Query() q: Record<string, string>) {
    return this.instances.list(orgId, q);
  }

  @RequirePermission('compute:instance:read')
  @Get(':id')
  async get(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const i = await this.instances.get(orgId, id);
    void reply.header('etag', etag(i.version));
    return i;
  }

  @RequirePermission('compute:instance:delete')
  @Delete(':id')
  @HttpCode(202)
  async remove(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() req: FastifyRequest,
  ) {
    const r = await this.instances.remove(
      orgId,
      a.actor.userId,
      id,
      parseIfMatch(ifMatch),
      req.traceId ?? '',
    );
    return {
      instance: { id: r.instance.id, status: r.instance.status },
      operationId: r.operationId,
    };
  }

  @RequirePermission('compute:instance:act')
  @Idempotent()
  @Post(':id/actions')
  @HttpCode(202)
  async act(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
    @Req() req: FastifyRequest,
  ) {
    const r = await this.instances.act(orgId, a.actor.userId, id, body, key, req.traceId ?? '');
    return {
      instance: { id: r.instance.id, status: r.instance.status },
      operationId: r.operationId,
      actionId: r.actionId,
    };
  }

  @RequirePermission('compute:instance:read')
  @Get(':id/metrics')
  metrics(
    @Org() orgId: string,
    @Param('id') id: string,
    @Query() q: { from?: string; to?: string },
  ) {
    return this.instances.metrics(orgId, id, q);
  }
}
