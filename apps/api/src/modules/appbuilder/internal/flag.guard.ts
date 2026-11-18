import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { DB } from '../../../common/tokens';
import {
  ArtifactStorePort,
  ModelGatewayPort,
  OrgBudgetPort,
  ProjectsPort,
  RunStorePort,
} from './ports/m09';

export const APP_BUILDER_FLAG = 'app_builder.enabled';
/** Dev-only flag: the stand-in endpoints for M09-owned paths (runs, projects, files, budgets). Never honoured in production. */
export const M09_STUBS_FLAG = 'app_builder.m09_stubs';

export const flagOn = async (db: Db, orgId: string, key: string): Promise<boolean> => {
  const row = await db.withOrg(
    orgId,
    async (c) =>
      (
        await c.query(
          `SELECT value FROM platform.feature_flags WHERE key = $1 AND (org_id = $2 OR org_id IS NULL) ORDER BY org_id NULLS LAST LIMIT 1`,
          [key, orgId],
        )
      ).rows[0],
  );
  return row?.value === true || row?.value?.enabled === true;
};

/**
 * Feature flag of the app builder (CLAUDE.md §4, default OFF): `platform.feature_flags` key `app_builder.enabled`; an organization row beats the global row. In production the
 * app builder additionally refuses to serve while any M09 port is an in-memory stand-in (M09 is not integrated) — nothing generated would be persisted.
 */
@Injectable()
export class AppBuilderEnabledGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly runs: RunStorePort,
    private readonly projects: ProjectsPort,
    private readonly gateway: ModelGatewayPort,
    private readonly artifacts: ArtifactStorePort,
    private readonly budget: OrgBudgetPort,
  ) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const orgId = req.access?.orgId;
    if (!orgId) return true;
    if (
      process.env.NODE_ENV === 'production' &&
      [this.runs, this.projects, this.gateway, this.artifacts, this.budget].some(
        (p) => (p as { isMock?: boolean }).isMock === true,
      )
    )
      throw new ProblemException(
        'not_found',
        'the app builder is not available: the M09 services are not connected',
      );
    if (!(await flagOn(this.db, orgId, APP_BUILDER_FLAG)))
      throw new ProblemException(
        'not_found',
        'the app builder is not enabled for this organization',
      );
    return true;
  }
}

/** Guard of the M09 stand-in routes: both flags, never in production. */
@Injectable()
export class M09StubGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const orgId = req.access?.orgId;
    if (!orgId) return true;
    if (process.env.NODE_ENV === 'production' || !(await flagOn(this.db, orgId, M09_STUBS_FLAG)))
      throw new ProblemException('not_found', 'not found');
    return true;
  }
}
