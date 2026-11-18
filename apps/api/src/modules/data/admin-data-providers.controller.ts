import { Body, Controller, Get, Post, Query, Req, HttpCode } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly, StepUp } from '../identity';
import { DataProviderService } from './internal/provider.service';

/**
 * Provider selection config (docs/04: `GET/POST /v1/admin/data-providers`; D-05..D-09 are OPEN: this selects nothing by itself).
 * One POST with an `action`: configure | probe | record_adr | request_enable | enable | disable. Enabling follows the two-person rule outside
 * environment=local and needs an accepted ADR, a probe with live evidence and an evidence reference; see DataProviderService.
 */
@RealmOnly('admin')
@Controller('v1/admin/data-providers')
export class AdminDataProvidersController {
  constructor(private readonly providers: DataProviderService) {}

  @RequirePlatformPermission('admin:data:read')
  @Get()
  list(@Query() q: { service?: string }) {
    return this.providers.list({ service: q.service });
  }

  @RequirePlatformPermission('admin:data:read')
  @StepUp()
  @Post()
  @HttpCode(200)
  async act(
    @Platform() who: PlatformContext,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
  ) {
    const b = body ?? {};
    const action = b.action ?? 'configure';
    const need = (p: string) => {
      if (!who.permissions.has(p))
        throw new ProblemException('forbidden', `permission ${p} is required for this action`);
    };
    const id = String(b.id ?? '');
    switch (action) {
      case 'configure':
        need('admin:data:manage');
        return this.providers.configure(who.userId, b);
      case 'probe':
        need('admin:data:manage');
        return this.providers.probe(
          who.userId,
          id,
          String(req.headers['x-request-id'] ?? 'admin-probe'),
        );
      case 'record_adr':
        need('admin:data:approve');
        return this.providers.recordAdrAcceptance(who.userId, id, b.adrRef);
      case 'request_enable':
        need('admin:data:manage');
        return this.providers.requestEnable(who.userId, id, b.evidenceRef, b.verifiedAt);
      case 'enable':
        need('admin:data:approve');
        return this.providers.enable(who.userId, id);
      case 'disable':
        need('admin:data:manage');
        return this.providers.disable(who.userId, id);
      default:
        throw new ProblemException(
          'validation_failed',
          'action must be configure, probe, record_adr, request_enable, enable or disable',
        );
    }
  }
}
