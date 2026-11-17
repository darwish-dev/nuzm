import { Body, Controller, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { WalletTopupService } from '../billing';
import { containsCardData } from './internal/pan';
import { PaymentService } from './internal/payment.service';

/**
 * POST /v1/billing/wallet-topups (docs/04): creates the top-up request and starts its payment with a saved method. The wallet is
 * credited only when that payment is captured (the ledger entry is made by the payment's completion, never here).
 * A top-up whose payment could not even be started (no method, bad return URL) stays `pending` and costs nothing.
 */
@Controller('v1/billing/wallet-topups')
export class WalletTopupsController {
  constructor(
    private readonly topups: WalletTopupService,
    private readonly payments: PaymentService,
  ) {}

  @RequirePermission('billing:manage')
  @Idempotent()
  @Post()
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const b = body ?? {};
    if (containsCardData(b))
      throw new ProblemException(
        'pan_not_allowed',
        'card data is never accepted; top up with a saved payment method',
      );
    const amount = this.topups.parseAmount(b.amount);
    const topup = await this.topups.create(orgId, a.actor.userId, amount);
    const r = await this.payments.create(orgId, a.actor.userId, {
      walletTopupId: topup.id,
      ...(b.paymentMethodId !== undefined ? { paymentMethodId: b.paymentMethodId } : {}),
      returnUrl: b.returnUrl,
    });
    void reply.status(r.httpStatus);
    return { ...(await this.topups.get(orgId, topup.id)), payment: r.payment };
  }
}
