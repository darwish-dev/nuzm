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
import { ProblemException } from '../../common/errors';
import { PanelInstallService } from './internal/hestia-vps/panel-install.service';
import { InstanceService } from './internal/instance.service';

/** Compute instances (docs/04 §2.5). Create/delete/actions are async (202 + operationId); other organizations' ids answer 404. */
@Controller('v1/compute/instances')
export class ComputeInstancesController {
  constructor(
    private readonly instances: InstanceService,
    private readonly panel: PanelInstallService,
  ) {}

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

  /** The staged HestiaCP install of this server and the state of its panel link (the provider actions do not depend on it). */
  @RequirePermission('compute:instance:read')
  @Get(':id/panel')
  async panelStatus(@Org() orgId: string, @Param('id') id: string) {
    await this.instances.get(orgId, id); // 404 for another organization's id and when compute is off
    const p = await this.panel.status(orgId, id);
    if (!p) throw new ProblemException('not_found', 'this server has no control panel');
    return p;
  }

  /** Resume an install that needs attention on the SAME server (never a new server, never a wipe). */
  @RequirePermission('compute:instance:act')
  @Idempotent()
  @Post(':id/panel/retry')
  @HttpCode(202)
  async panelRetry(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    await this.instances.get(orgId, id);
    return this.panel.retry(orgId, id, a.actor.userId);
  }
}
