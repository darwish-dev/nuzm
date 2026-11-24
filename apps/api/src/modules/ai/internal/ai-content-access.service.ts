import { builderTools } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';

const P = builderTools.lifecycle;

/** The AI routes that return a customer's conversation text or a run's content. Usage, credits, budgets, models and the approvals list are billing data and stay readable. */
export const AI_CONTENT_OPERATIONS = [
  'ai_sessions',
  'ai_messages',
  'ai_runs',
  'ai_run',
  'ai_run_events',
  'ai_artifacts',
] as const;
export type AiContentOperation = (typeof AI_CONTENT_OPERATIONS)[number];

/**
 * O-9 for the AI routes: the SAME switch and the SAME policy as the builder tools (`builder.billing_admin_content_access`, `builderTools.lifecycle.decideContentAccess`: reused, not
 * forked). The setting lives in the organization's own `platform.feature_flags` row and is changed through the builder policy route (`PUT /v1/builder/policies/content-access`).
 * Absent = `allow` = today's behaviour. Only the `billing_admin` role is ever affected; a denial is 403 and is audited (`ai.content.access_denied`, the operation and the role, never
 * the content). This class only READS the setting: writing it stays with the builder module's `ContentAccessService`, so the two can never disagree about the storage.
 */
export class AiContentAccess {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async mode(orgId: string): Promise<builderTools.lifecycle.ContentAccessMode> {
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT value FROM platform.feature_flags WHERE key = $1 AND org_id = $2`, [
            P.CONTENT_ACCESS_KEY,
            orgId,
          ])
        ).rows[0] as { value: unknown } | undefined,
    );
    return P.parseContentAccess(row?.value);
  }

  /** Throws 403 when this role may not read AI content under the organization's setting. Every denial is audited. */
  async assert(
    orgId: string,
    actor: string,
    role: string,
    operation: AiContentOperation,
    resource: { type: 'ai_session' | 'ai_run' | 'organization'; id?: string } = {
      type: 'organization',
    },
  ): Promise<void> {
    // only the role the setting can affect costs a read
    if (role !== 'billing_admin') return;
    if (P.decideContentAccess(role, await this.mode(orgId)).allowed) return;
    await this.audit.record({
      action: 'ai.content.access_denied',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: resource.type, id: resource.id ?? orgId },
      outcome: 'failure',
      detail: { operation, role, setting: P.CONTENT_ACCESS_KEY },
    });
    throw new ProblemException(
      'forbidden',
      'billing administrators cannot read AI conversations or run content in this organization',
    );
  }
}
