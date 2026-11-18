import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../identity';
import { RegistrarWebhookService } from './internal/webhook.service';

/** Registrar callbacks (docs/04 §2.7). Unauthenticated by design: the signature over the RAW body and the replay window are the authentication. */
@Controller('v1/webhooks/registrars')
export class RegistrarWebhooksController {
  constructor(private readonly hooks: RegistrarWebhookService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  receive(@Param('provider') provider: string, @Req() req: FastifyRequest) {
    const raw = (req as { rawBody?: Buffer }).rawBody;
    return this.hooks.receive(provider, raw?.toString('utf8'), req.headers);
  }
}
