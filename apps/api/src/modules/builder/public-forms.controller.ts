import { Body, Controller, HttpCode, Options, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../identity';
import { FormsService } from './internal/forms.service';

/** The client address for rate limiting. Behind a trusted edge (`BUILDER_TRUST_FORWARDED=true`) the first `X-Forwarded-For` entry; otherwise the socket address. */
const clientIp = (req: FastifyRequest): string => {
  if (process.env.BUILDER_TRUST_FORWARDED === 'true') {
    const x = req.headers['x-forwarded-for'];
    const first = (Array.isArray(x) ? x[0] : x)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip;
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, idempotency-key',
  'access-control-max-age': '600',
};

/** Public form ingest of published sites (S41.2): honeypot, per-IP rate limit, size limits; stores sealed `personal` data. Always answers without detail. */
@Public()
@Controller('p/:projectId/v1/public/forms')
export class PublicFormsController {
  constructor(private readonly forms: FormsService) {}
  @Options(':formKey')
  @HttpCode(204)
  preflight(@Res({ passthrough: true }) reply: FastifyReply) {
    void reply.headers(CORS);
  }
  @Post(':formKey')
  async submit(
    @Param('projectId') projectId: string,
    @Param('formKey') formKey: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const len = Number(req.headers['content-length'] ?? 0);
    const r = await this.forms.ingest(
      projectId.toLowerCase(),
      formKey,
      body,
      clientIp(req),
      Number.isFinite(len) ? len : 0,
    );
    void reply
      .headers(CORS)
      .status(r.status)
      .send(
        r.status === 202
          ? { received: true }
          : { received: false, ...(r.code ? { code: r.code } : {}) },
      );
  }
}
