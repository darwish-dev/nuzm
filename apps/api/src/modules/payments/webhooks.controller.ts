import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../identity';
import { PaymentService } from './internal/payment.service';

/**
 * Provider callbacks (docs/04 §2.3). Unauthenticated by design: the signature over the RAW body and the replay window are the
 * authentication. Answers 200 once the event is durable (duplicates are 200 with no effect), 401 for a bad signature or replay,
 * 404 for an unknown provider.
 */
@Controller('v1/webhooks/payments')
export class PaymentWebhooksController {
  constructor(private readonly payments: PaymentService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  receive(@Param('provider') provider: string, @Req() req: FastifyRequest) {
    // Nest keeps the exact request bytes (`rawBody: true` at application creation): signatures are computed over them, never over re-serialized JSON
    const raw = (req as { rawBody?: Buffer }).rawBody;
    return this.payments.handleWebhook(provider, raw?.toString('utf8'), req.headers);
  }
}
