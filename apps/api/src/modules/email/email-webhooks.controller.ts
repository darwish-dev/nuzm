import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../identity';
import { MessageService } from './internal/message.service';

/**
 * Provider callbacks (docs/04 §1 inbound webhooks). Unauthenticated by design: the signature over the RAW body and the replay window are the authentication.
 * 200 once every event is durably stored (a duplicate provider event id is a no-op), 401 invalid signature, 409 outside the replay window, 404 unknown provider.
 */
@Controller('v1/webhooks/email')
export class EmailWebhooksController {
  constructor(private readonly messages: MessageService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  receive(@Param('provider') provider: string, @Req() req: FastifyRequest) {
    const raw = (req as { rawBody?: Buffer }).rawBody;
    return this.messages.handleWebhook(provider, raw?.toString('utf8'), req.headers);
  }
}
