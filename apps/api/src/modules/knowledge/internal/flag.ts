import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { DB } from '../../../common/tokens';

/** AI Intelligence Center flags (ADR-065, CLAUDE.md §4): every one defaults OFF. The library flag is platform-wide; the customer flags are per organization (S-K7). */
export const KNOWLEDGE_LIBRARY_FLAG = 'knowledge.library';
export const KNOWLEDGE_CUSTOMER_TEMPLATES_FLAG = 'knowledge.customer_templates';
export const KNOWLEDGE_IMPORT_PROJECTS_FLAG = 'knowledge.import_projects';
export const KNOWLEDGE_SEMANTIC_SEARCH_FLAG = 'knowledge.semantic_search';

/** The admin console routes answer 404 while `knowledge.library` is off (a global `platform.feature_flags` row), exactly like AI Studio. */
@Injectable()
export class KnowledgeLibraryGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}
  async canActivate(): Promise<boolean> {
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT value FROM platform.feature_flags WHERE key = $1 AND org_id IS NULL LIMIT 1`,
            [KNOWLEDGE_LIBRARY_FLAG],
          )
        ).rows[0] as { value: unknown } | undefined,
    );
    const v = row?.value as boolean | { enabled?: boolean } | undefined;
    if (v === true || (typeof v === 'object' && v?.enabled === true)) return true;
    throw new ProblemException('not_found', 'the AI knowledge library is not enabled');
  }
}

/**
 * The customer routes (S-K7) answer 404 while `knowledge.customer_templates` is off. An organization row beats the global row; the flag defaults OFF (CLAUDE.md §4). The platform flag
 * `knowledge.library` is NOT required: a customer sees only what staff published, whether or not the admin console is open to a given staff member.
 */
@Injectable()
export class KnowledgeCustomerTemplatesGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const orgId = ctx.switchToHttp().getRequest<FastifyRequest>().access?.orgId;
    if (!orgId) throw new ProblemException('not_found', 'templates are not enabled');
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT value FROM platform.feature_flags WHERE key = $1 AND (org_id = $2 OR org_id IS NULL) ORDER BY org_id NULLS LAST LIMIT 1`,
            [KNOWLEDGE_CUSTOMER_TEMPLATES_FLAG, orgId],
          )
        ).rows[0] as { value: unknown } | undefined,
    );
    const v = row?.value as boolean | { enabled?: boolean } | undefined;
    if (v === true || (typeof v === 'object' && v?.enabled === true)) return true;
    throw new ProblemException('not_found', 'templates are not enabled for this organization');
  }
}
