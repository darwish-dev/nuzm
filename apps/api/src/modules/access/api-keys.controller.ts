import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { ApiKeyService, DenyImpersonation, StepUp } from '../identity';
import { PolicyService } from './policy.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sees = (role: string) => role === 'owner' || role === 'admin';

@Controller('v1/api-keys')
export class ApiKeysController {
  constructor(
    private readonly keys: ApiKeyService,
    private readonly policy: PolicyService,
  ) {}

  /** Session-only and step-up protected: an API key can never mint another API key. */
  @DenyImpersonation()
  @RequirePermission('apikey:manage')
  @StepUp()
  @Idempotent()
  @Post()
  @HttpCode(201)
  async create(
    @Org() orgId: string,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Access() a: AccessContext,
  ) {
    if (a.actor.kind !== 'session')
      throw new ProblemException('forbidden', 'API keys cannot create API keys');
    const i = body ?? {};
    if (
      typeof i.name !== 'string' ||
      !Array.isArray(i.scopes) ||
      !i.scopes.every((s) => typeof s === 'string')
    )
      throw new ProblemException('validation_failed', 'name and scopes[] are required');
    let expiresAt: Date | null = null;
    if (i.expiresAt !== undefined && i.expiresAt !== null) {
      expiresAt = new Date(String(i.expiresAt));
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
        throw new ProblemException('validation_failed', 'expiresAt must be a future ISO date');
    }
    const ipAllowList = i.ipAllowList === undefined ? [] : i.ipAllowList;
    if (!Array.isArray(ipAllowList) || !ipAllowList.every((s) => typeof s === 'string'))
      throw new ProblemException('validation_failed', 'ipAllowList must be a string array');
    const perms = await this.policy.userPermissions(a.actor.userId, orgId);
    const k = await this.keys.create(
      orgId,
      a.actor.userId,
      {
        name: i.name,
        scopes: i.scopes as string[],
        expiresAt,
        ipAllowList: ipAllowList as string[],
      },
      perms,
    );
    return {
      id: k.id,
      prefix: k.prefix,
      key: k.key,
      note: 'Store this key now; it cannot be shown again.',
    };
  }

  @RequirePermission('apikey:read')
  @Get()
  async list(@Org() orgId: string, @Access() a: AccessContext) {
    const rows = await this.keys.list(orgId, sees(a.role) ? {} : { createdBy: a.actor.userId });
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scopes: r.scopes,
        ipAllowList: r.ip_allow_list,
        expiresAt: r.expires_at?.toISOString() ?? null,
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
        revokedAt: r.revoked_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
        createdBy: r.created_by,
      })),
      nextCursor: null,
    };
  }

  @DenyImpersonation()
  @RequirePermission('apikey:manage')
  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @Org() orgId: string,
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Access() a: AccessContext,
  ) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const ok = await this.keys.revoke(
      orgId,
      id,
      sees(a.role) ? {} : { onlyCreatedBy: a.actor.userId },
    );
    if (!ok) throw new ProblemException('not_found');
  }
}
