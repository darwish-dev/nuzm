import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { MobileBuilderEnabledGuard } from './internal/flag.guard';
import { SigningService } from './internal/signing/signing.service';

type B = Record<string, unknown> | undefined;

/**
 * `/v1/mobile/signing-credentials` (docs/04 §2.10): VAULT REFERENCES ONLY. Body `{platform, label, vaultRef, authorizedBy}`; anything else, or anything that looks like key material, is
 * 422 `raw_secret_rejected` and is never echoed. Owner/admin only (`mobile:signing`). Revocation has no path in docs/04 yet: SCR-M10B-01.
 */
@UseGuards(MobileBuilderEnabledGuard)
@Controller('v1/mobile/signing-credentials')
export class SigningController {
  constructor(private readonly signing: SigningService) {}
  @RequirePermission('mobile:signing')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: B) {
    return this.signing.create(orgId, a.actor.userId, body ?? {});
  }
  @RequirePermission('mobile:signing')
  @Get()
  async list(@Org() orgId: string) {
    return { items: await this.signing.list(orgId) };
  }
}
