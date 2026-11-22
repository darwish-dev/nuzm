import type { Db } from '@nuzm/platform';
import { AI_FLAG, AI_KILLSWITCH } from './model';

/** The read-only agent tools (D-46, SCR-K-10 §6): per organization (an organization row beats the global row), default OFF. */
export const AI_AGENT_READ_TOOLS_FLAG = 'ai.agent.read_tools';
/** RESERVED for execution tools (build, test, shell). It cannot be turned on: `execTools` ignores every flag row until D-21 is accepted and the escape suite has passed (ADR-066 point 8). */
export const AI_AGENT_EXEC_TOOLS_FLAG = 'ai.agent.exec_tools';

const truthy = (v: unknown) =>
  v === true ||
  (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true);

/**
 * `ai.enabled` (feature flag, default OFF; an org row beats the global row) and `ai.killswitch` (global OR org row ON stops every call; NOT cached, so a toggle
 * takes effect on the next call: AC "kill switch ≤ 5 s" is met by construction).
 */
export class AiFlags {
  constructor(private readonly db: Db) {}
  private async read(orgId: string, key: string): Promise<boolean> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT org_id, value FROM platform.feature_flags WHERE key = $1 AND (org_id IS NULL OR org_id = $2) ORDER BY org_id NULLS FIRST`,
            [key, orgId],
          )
        ).rows,
    );
    return rows.length > 0 && truthy(rows[rows.length - 1]?.value as unknown);
  }
  enabled(orgId: string) {
    return this.read(orgId, AI_FLAG);
  }
  readTools(orgId: string) {
    return this.read(orgId, AI_AGENT_READ_TOOLS_FLAG);
  }
  /** Always false: no execution tool exists and none may be enabled before D-21 (the row is not even read, so no value of it can matter). */
  execTools(_orgId: string): Promise<false> {
    return Promise.resolve(false);
  }
  async killSwitch(orgId: string): Promise<boolean> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT value FROM platform.feature_flags WHERE key = $1 AND (org_id IS NULL OR org_id = $2)`,
            [AI_KILLSWITCH, orgId],
          )
        ).rows,
    );
    return rows.some((r) => truthy(r.value as unknown)); // ANY level ON stops calls
  }
}
