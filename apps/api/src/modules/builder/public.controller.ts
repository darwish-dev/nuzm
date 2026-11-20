import { Controller, Delete, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../identity';
import { LivePreviewRegistry } from './internal/live-preview';
import { PreviewService } from './internal/preview.service';

/**
 * Isolated preview origin: `/_preview/{token}/…` is served ONLY on the host `<token>.<previewDomain>` (anything else is a plain 404). No cookies, no CORS, no console auth.
 * A token of a running application preview is proxied to that application (every method); any other token is a website preview (GET, static files).
 */
@Public()
@Controller('_preview')
export class PreviewServeController {
  constructor(
    private readonly previews: PreviewService,
    private readonly live: LivePreviewRegistry,
  ) {}
  @Get(':token/*')
  async file(
    @Param('token') token: string,
    @Param('*') path: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.handle(token, path ?? '', req, reply);
  }
  /** writes reach only a running application preview (its own API); a website preview answers 404 */
  @Post(':token/*')
  async post(
    @Param('token') t: string,
    @Param('*') p: string,
    @Req() q: FastifyRequest,
    @Res() r: FastifyReply,
  ) {
    return this.handle(t, p ?? '', q, r);
  }
  @Put(':token/*')
  async put(
    @Param('token') t: string,
    @Param('*') p: string,
    @Req() q: FastifyRequest,
    @Res() r: FastifyReply,
  ) {
    return this.handle(t, p ?? '', q, r);
  }
  @Patch(':token/*')
  async patch(
    @Param('token') t: string,
    @Param('*') p: string,
    @Req() q: FastifyRequest,
    @Res() r: FastifyReply,
  ) {
    return this.handle(t, p ?? '', q, r);
  }
  @Delete(':token/*')
  async remove(
    @Param('token') t: string,
    @Param('*') p: string,
    @Req() q: FastifyRequest,
    @Res() r: FastifyReply,
  ) {
    return this.handle(t, p ?? '', q, r);
  }
  @Get(':token')
  async root(
    @Param('token') token: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.handle(token, '', req, reply);
  }
  private async handle(token: string, path: string, req: FastifyRequest, reply: FastifyReply) {
    if (this.live.has(token)) {
      const q = req.url.indexOf('?');
      const raw = (req as FastifyRequest & { rawBody?: Buffer | string }).rawBody;
      const body =
        raw !== undefined
          ? Buffer.from(raw)
          : req.body === undefined || req.body === null
            ? undefined
            : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      const r = await this.live.proxy(
        req.headers.host,
        token,
        req.method,
        path,
        q >= 0 ? req.url.slice(q + 1) : '',
        req.headers,
        body,
      );
      return void reply.status(r.status).headers(r.headers).send(r.body);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return void reply.status(404).type('text/plain').send('not found');
    const r = await this.previews.serve(req.headers.host, token, path);
    void reply.status(r.status).headers(r.headers).send(r.body);
  }
}
