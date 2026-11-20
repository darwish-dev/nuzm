import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { newId } from '../core';
import { APP_BUILDER_FLAG, flagOn } from '../flag.guard';
import { AI_STUDIO_FLAG, CLAUDE_CODE_FLAG, claudeCodeComplianceApproved } from './flag';

/** The switches an organization may set for itself (an allow-list: no other flag can be written through this path). */
const SELF_SERVICE = { aiStudio: AI_STUDIO_FLAG, claudeCode: CLAUDE_CODE_FLAG } as const;
type Switch = keyof typeof SELF_SERVICE;

/**
 * AI Studio settings of an organization (ADR-064): its owners and admins (`org:update`) turn AI Studio and the Claude Code proof of concept on or
 * off for their own organization. Each change writes the organization's own row in `platform.feature_flags` (RLS `flags_org_write`) and is audited
 * with before/after. Turning Claude Code on does not lift the D-38 gate: production still refuses it until the compliance approval is recorded.
 */
export class StudioSettingsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async get(orgId: string) {
    const [appBuilder, aiStudio, claudeCode] = await Promise.all([
      flagOn(this.db, orgId, APP_BUILDER_FLAG),
      flagOn(this.db, orgId, AI_STUDIO_FLAG),
      flagOn(this.db, orgId, CLAUDE_CODE_FLAG),
    ]);
    const compliance = claudeCodeComplianceApproved(this.env);
    return {
      appBuilder: { enabled: appBuilder },
      aiStudio: { enabled: aiStudio },
      claudeCode: {
        enabled: claudeCode,
        complianceApproved: compliance,
        /** usable only with AI Studio on, the switch on and (in production) the D-38 approval */
        available: aiStudio && claudeCode && compliance,
      },
    };
  }

  async set(orgId: string, actor: string, body: Record<string, unknown>) {
    const changes = (Object.keys(SELF_SERVICE) as Switch[]).filter((k) => body[k] !== undefined);
    if (!changes.length)
      throw new ProblemException('validation_failed', 'send aiStudio and/or claudeCode');
    for (const k of changes)
      if (typeof body[k] !== 'boolean')
        throw new ProblemException('validation_failed', `${k} must be true or false`);
    const unknown = Object.keys(body).filter((k) => !(k in SELF_SERVICE));
    if (unknown.length)
      throw new ProblemException('validation_failed', `unknown settings: ${unknown.join(', ')}`);
    const before = await this.get(orgId);
    await this.db.withOrg(orgId, async (c) => {
      for (const k of changes) {
        const key = SELF_SERVICE[k];
        const value = JSON.stringify(body[k] === true);
        const upd = await c.query(
          `UPDATE platform.feature_flags SET value = $3::jsonb, updated_by = $4, updated_at = now() WHERE key = $1 AND org_id = $2`,
          [key, orgId, value, actor],
        );
        if (!upd.rowCount)
          await c.query(
            `INSERT INTO platform.feature_flags (id, key, org_id, value, updated_by) VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [newId(), key, orgId, value, actor],
          );
      }
    });
    const after = await this.get(orgId);
    await this.audit.record({
      action: 'builder.ai_studio.settings_updated',
      actorUserId: actor,
      actorType: 'user',
      orgId,
      resource: { type: 'organization', id: orgId },
      outcome: 'success',
      detail: {
        before: { aiStudio: before.aiStudio.enabled, claudeCode: before.claudeCode.enabled },
        after: { aiStudio: after.aiStudio.enabled, claudeCode: after.claudeCode.enabled },
      },
    });
    return after;
  }
}
