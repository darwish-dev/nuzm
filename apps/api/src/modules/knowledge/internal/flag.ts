import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { DB } from '../../../common/tokens';

/** AI Intelligence Center flags (ADR-065, CLAUDE.md §4): every one defaults OFF. The library flag is platform-wide; the customer flags are per organization (S-K7). */
export const KNOWLEDGE_LIBRARY_FLAG = 'knowledge.library';
export const KNOWLEDGE_CUSTOMER_TEMPLATES_FLAG = 'knowledge.customer_templates';
export const KNOWLEDGE_GENERATION_FLAG = 'knowledge.generation';
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

/**
 * The adaptation of a copied template (S-K6, SCR-K-09): workspace comparison, the context preview and the run that adapts the copy answer 404 while `knowledge.generation` is off
 * for the organization (an organization row beats the global row; default OFF). It is a separate flag from the gallery: the gallery copies, this one may send text to a model.
 */
@Injectable()
export class KnowledgeGenerationGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const orgId = ctx.switchToHttp().getRequest<FastifyRequest>().access?.orgId;
    if (!orgId || !(await knowledgeGenerationEnabled(this.db, orgId)))
      throw new ProblemException(
        'not_found',
        'template generation is not enabled for this organization',
      );
    return true;
  }
}
export async function knowledgeGenerationEnabled(db: Db, orgId: string): Promise<boolean> {
  const row = await db.withOrg(
    orgId,
    async (c) =>
      (
        await c.query(
          `SELECT value FROM platform.feature_flags WHERE key = $1 AND (org_id = $2 OR org_id IS NULL) ORDER BY org_id NULLS LAST LIMIT 1`,
          [KNOWLEDGE_GENERATION_FLAG, orgId],
        )
      ).rows[0] as { value: unknown } | undefined,
  );
  const v = row?.value as boolean | { enabled?: boolean } | undefined;
  return v === true || (typeof v === 'object' && v?.enabled === true);
}
