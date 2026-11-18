import { Controller, Header, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { Public } from '../identity';
import { AutomationJobs } from './internal/jobs';
import { TriggerService } from './internal/trigger.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const page = (q: { limit?: string; cursor?: string }) => ({ limit: parseLimit(q.limit), cursor: q.cursor });
const ifMatch = (req: FastifyRequest) => {
  const v = parseIfMatch(req.headers['if-match']);
  if (v === null) throw new ProblemException('precondition_required', 'send the current ETag in If-Match');
  return v;
};

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
