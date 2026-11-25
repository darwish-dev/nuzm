import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../identity';
import { DocsFeedbackService } from './docs-feedback.service';

/**
 * `POST /v1/docs-feedback`: the "Was this helpful?" rating of the public documentation. No sign-in (the documentation is public) and no cookie, so there is no
 * session and no CSRF token to check; the body is validated strictly and the endpoint is rate limited. Nothing identifying is stored (see the service).
 */
@Controller('v1/docs-feedback')
export class DocsFeedbackController {
  constructor(private readonly feedback: DocsFeedbackService) {}

  @Public()
  @Post()
  @HttpCode(204)
  async rate(@Body() body: Record<string, unknown> | undefined, @Req() req: FastifyRequest) {
    const b = body ?? {};
    await this.feedback.record({
      page: b.page,
      score: b.score,
      locale: b.locale,
      ip: req.ip ?? '',
      agent: String(req.headers['user-agent'] ?? ''),
    });
  }
}
