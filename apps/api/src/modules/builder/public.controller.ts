import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../identity';
import { PreviewService } from './internal/preview.service';

/** Isolated preview origin: `GET /_preview/{token}/…` is served ONLY on the host `<token>.<previewDomain>` (anything else is a plain 404). No cookies, no CORS, no auth. */
@Public()
@Controller('_preview')
export class PreviewServeController {
  constructor(private readonly previews: PreviewService) {}
  @Get(':token/*')
  async file(
    @Param('token') token: string,
    @Param('*') path: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const r = await this.previews.serve(req.headers.host, token, path ?? '');
    void reply.status(r.status).headers(r.headers).send(r.body);
  }
  @Get(':token')
  async root(
    @Param('token') token: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const r = await this.previews.serve(req.headers.host, token, '');
    void reply.status(r.status).headers(r.headers).send(r.body);
  }
}
