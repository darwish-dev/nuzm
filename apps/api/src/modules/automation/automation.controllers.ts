import { Body, Controller, Get, Header, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Delegable, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { Public } from '../identity';
import { ConnectorService } from './internal/connector.service';
import { ExecutionService } from './internal/execution.service';
import { AutomationJobs } from './internal/jobs';
import { TriggerService } from './internal/trigger.service';
import { WebhookEndpointService } from './internal/webhook-endpoint.service';
import { WorkflowService } from './internal/workflow.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const page = (q: { limit?: string; cursor?: string }) => ({ limit: parseLimit(q.limit), cursor: q.cursor });
const ifMatch = (req: FastifyRequest) => {
  const v = parseIfMatch(req.headers['if-match']);
  if (v === null) throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
  return v;
};

/** Workflows, versions and executions (docs/04 §2.11). Usable by an agency acting for a client (`@Delegable`: the grant must carry automation:*). */
@Delegable()
@Controller('v1/workflows')
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowService,
    private readonly executions: ExecutionService,
    private readonly jobs: AutomationJobs,
  ) {}

  @RequirePermission('automation:write')
  @Idempotent()
  @Post()
  @HttpCode(201)
  async create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_, @Res({ passthrough: true }) reply: FastifyReply) {
    const w = await this.workflows.create(orgId, a.actor.userId, b(body));
    void reply.header('etag', etag(w.etag));
    return w;
  }
  @RequirePermission('automation:read')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string; status?: string }) {
    return this.workflows.list(orgId, { ...page(q), status: q.status });
  }
  @RequirePermission('automation:read')
  @Get(':id')
  async get(@Org() orgId: string, @Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const w = await this.workflows.get(orgId, id.toLowerCase());
    void reply.header('etag', etag(w.etag));
    return w;
  }
  @RequirePermission('automation:write')
  @Patch(':id')
  async patch(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string, @Body() body: Body_, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const w = await this.workflows.patch(orgId, a.actor.userId, id.toLowerCase(), ifMatch(req), b(body));
    void reply.header('etag', etag(w.etag));
    return w;
  }
  @RequirePermission('automation:write')
  @Idempotent()
  @Post(':id/versions')
  @HttpCode(201)
  createVersion(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string, @Body() body: Body_) {
    return this.workflows.createVersion(orgId, a.actor.userId, id.toLowerCase(), b(body));
  }
  /** 202 + the execution (its `operationId` is the durable operation). A repeated `dedupeKey` answers 200 with the ORIGINAL execution and `duplicate: true`. */
  @RequirePermission('automation:run')
  @Idempotent()
  @Post(':id/executions')
  @HttpCode(202)
  async run(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string, @Body() body: Body_, @Res({ passthrough: true }) reply: FastifyReply) {
    const e = await this.executions.create(orgId, a.actor.userId, id.toLowerCase(), b(body));
    if (e.duplicate) void reply.status(200);
    else this.jobs.kick(orgId, e.id);
    return e;
  }
  @RequirePermission('automation:read')
  @Get(':id/executions')
  listExecutions(@Org() orgId: string, @Param('id') id: string, @Query() q: { limit?: string; cursor?: string; status?: string }) {
    return this.executions.list(orgId, id.toLowerCase(), { ...page(q), status: q.status });
  }
}

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

@Controller('v1/connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorService) {}
  @RequirePermission('connector:manage')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.connectors.create(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('connector:manage')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.connectors.list(orgId, page(q));
  }
  @RequirePermission('connector:manage')
  @Idempotent()
  @Post(':id/authorization')
  @HttpCode(201)
  authorize(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string, @Body() body: Body_) {
    return this.connectors.authorize(orgId, a.actor.userId, id.toLowerCase(), b(body));
  }
}

@Controller('v1/webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly endpoints: WebhookEndpointService) {}
  /** 201 with the signing secret (shown ONCE). With `secretRotation` for an existing URL: 201 with the NEW secret; the old one signs too until the overlap ends. */
  @RequirePermission('webhook:manage')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.endpoints.create(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('webhook:manage')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.endpoints.list(orgId, page(q));
  }
}

/**
 * Inbound workflow trigger (docs/04 §1 inbound webhooks): `POST /v1/webhooks/workflows/{token}`. Unauthenticated by design: the secret URL token, the HMAC signature over the RAW body,
 * the 5 minute timestamp window and the dedupe on `X-Nuzm-Event-Id` are the authentication. 202 + the execution; a repeated event id = 200 with the original.
 */
@Controller('v1/webhooks/workflows')
export class WorkflowWebhookController {
  constructor(private readonly triggers: TriggerService, private readonly jobs: AutomationJobs) {}
  @Public()
  @Post(':token')
  @HttpCode(202)
  @Header('cache-control', 'no-store')
  async receive(@Param('token') token: string, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const raw = (req as { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';
    const sig = req.headers['x-nuzm-signature'];
    const r = await this.triggers.inbound(token, typeof sig === 'string' ? sig : undefined, raw, typeof req.headers['x-nuzm-event-id'] === 'string' ? (req.headers['x-nuzm-event-id'] as string) : undefined);
    if (r.duplicate) void reply.status(200);
    return { executionId: r.executionId, duplicate: r.duplicate };
  }
}
