import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ProblemException } from '../../common/errors';
import { Public } from '../identity';

/**
 * Provider callbacks (docs/04 §2.5). Unauthenticated by design: a verified signature over the RAW body and a replay window are the authentication.
 * No provider adapter implements webhook parsing yet (vendor adapters arrive in S18-S22, from the official documentation), so EVERY provider is
 * answered 404 ("unsupported providers 404"): nothing is accepted, stored or acted upon. Verification + dedupe by provider event id arrive with the
 * first adapter that declares webhook support.
 */
@Controller('v1/webhooks/cloud')
export class CloudWebhooksController {
  @Public()
  @Post(':provider')
  @HttpCode(200)
  receive(@Param('provider') _provider: string): never {
    throw new ProblemException('not_found', 'this provider does not send webhooks to Nuzm');
  }
}
