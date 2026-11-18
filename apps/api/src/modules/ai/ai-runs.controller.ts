import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { AiEnabledGuard } from './internal/ai-enabled.guard';
import { AI_CONFIG, type AiConfig } from './internal/model';
import { RunService } from './internal/run.service';
import { Inject } from '@nestjs/common';

const STOP_STATES = ['succeeded', 'failed', 'cancelled', 'budget_exceeded', 'waiting_approval'];

/** Runs (docs/04 §2.9): create, read, SSE events (resumable with `Last-Event-ID`), cancellation, approvals. */
@UseGuards(AiEnabledGuard)
@Controller('v1/ai/runs')
export class AiRunsController {
  constructor(
    private readonly runs: RunService,
    @Inject(AI_CONFIG) private readonly cfg: AiConfig,
  ) {}

  /** 202 run `{id,state,operationId}`. 402 `insufficient_credits`, 429, 422 `residency_denied`|`unsupported_kind`|`unsupported_capability`, 409 `run_active`, 503 kill switch. */
  @RequirePermission('ai:write')
  @Idempotent()
  @Post()
  @HttpCode(202)
  create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.runs.create(orgId, a.actor.userId, key, body ?? {});
  }

  @RequirePermission('ai:read')
  @Get()
  list(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; sessionId?: string; projectId?: string },
  ) {
    return this.runs.list(orgId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
    });
  }

  @RequirePermission('ai:read')
  @Get(':id')
  get(@Org() orgId: string, @Param('id') id: string) {
    return this.runs.get(orgId, id.toLowerCase());
  }

  @RequirePermission('ai:read')
  @Get(':id/artifacts/:artifactId')
  artifact(@Org() orgId: string, @Param('id') id: string, @Param('artifactId') aid: string) {
    return this.runs.artifact(orgId, id.toLowerCase(), aid.toLowerCase());
  }

  /**
   * Server-sent events `{seq,type,data}` with `id: <seq>`. Resume with the `Last-Event-ID` header (or `?lastEventId=`). The stream ends when the run is finished or is
   * waiting for an approval (reconnect after the decision), or after 120 s; a client that drops is simply gone, nothing is held.
   */
  @RequirePermission('ai:read')
  @Get(':id/events')
  async events(
    @Org() orgId: string,
    @Param('id') id: string,
    @Query('lastEventId') q: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const runId = id.toLowerCase();
    await this.runs.get(orgId, runId); // 404 before the stream starts
    const header = req.headers['last-event-id'];
    let last = Number(Array.isArray(header) ? header[0] : (header ?? q ?? 0));
    if (!Number.isInteger(last) || last < 0) last = 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    req.raw.on('close', () => (closed = true));
    const deadline = Date.now() + 120_000;
    reply.raw.write('retry: 2000\n\n');
    while (!closed && Date.now() < deadline) {
      const evs = await this.runs.eventsAfter(orgId, runId, last);
      for (const e of evs) {
        reply.raw.write(
          `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, data: e.data, at: e.at })}\n\n`,
        );
        last = e.seq;
      }
      if (evs.length === 0) {
        const st = await this.runs.state(orgId, runId);
        if (STOP_STATES.includes(st)) break;
        reply.raw.write(': keep-alive\n\n');
        await new Promise((r) => setTimeout(r, this.cfg.ssePollMs));
      }
    }
    reply.raw.end();
  }

  /** 202; 409 `invalid_state` when the run is already finished. A running run stops at its next step (the call in flight is aborted). */
  @RequirePermission('ai:write')
  @Post(':id/cancellation')
  @HttpCode(202)
  cancel(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    return this.runs.cancel(orgId, a.actor.userId, id.toLowerCase());
  }

  /** Body `{approvalId, decision: approve|deny, note?}`. Needs a write role (the approver is always a human member); 409 `approval_expired`. */
  @RequirePermission('ai:write')
  @Idempotent()
  @Post(':id/approvals')
  @HttpCode(200)
  approve(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.runs.decide(orgId, a.actor.userId, id.toLowerCase(), body ?? {});
  }
}
