import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { PaymentMethodService } from './internal/method.service';

/** Saved payment methods (docs/04 §2.3). Tokens only: card data is refused (422 `pan_not_allowed`). */
@Controller('v1/billing/payment-methods')
export class PaymentMethodsController {
  constructor(private readonly methods: PaymentMethodService) {}

  @RequirePermission('billing:manage')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.methods.create(orgId, a.actor.userId, body ?? {});
  }

  @RequirePermission('billing:read')
  @Get()
  list(@Org() orgId: string) {
    return this.methods.list(orgId);
  }

  @RequirePermission('billing:manage')
  @Idempotent()
  @Post(':id/default')
  @HttpCode(200)
  setDefault(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    return this.methods.setDefault(orgId, id.toLowerCase(), a.actor.userId);
  }

  @RequirePermission('billing:manage')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    await this.methods.remove(orgId, id.toLowerCase(), a.actor.userId);
  }
}
