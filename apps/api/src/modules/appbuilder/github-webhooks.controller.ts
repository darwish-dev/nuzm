import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../identity';
import { GitHubService } from './internal/studio/github.service';

/** GitHub App webhooks. Unauthenticated by design: the HMAC over the RAW body is the authentication; deduped by delivery id. */
@Controller('v1/webhooks/github')
export class GithubWebhooksController {
  constructor(private readonly gh: GitHubService) {}
  @Public()
  @Post()
  @HttpCode(200)
  receive(@Req() req: FastifyRequest) {
    const raw = (req as { rawBody?: Buffer }).rawBody;
    return this.gh.webhook(raw?.toString('utf8'), req.headers);
  }
}
