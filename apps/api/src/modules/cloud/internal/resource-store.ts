import type { PoolClient } from 'pg';
import {
  assertResourceTransition,
  isResourceState,
  type ResourceState,
  type TransitionActor,
} from '@nuzm/domain';
import { ProblemException } from '../../../common/errors';
import type { Row } from './common';

export interface ResourcePatch {
  provider_ref?: string | null;
  last_seen_at?: Date | null;
  drift_state?: 'in_sync' | 'drift' | 'orphan_suspected' | 'missing';
  observed?: unknown;
  case_opened_at?: Date | null;
  case_detail?: unknown;
}
const PATCH_COLUMNS = [
  'provider_ref',
  'last_seen_at',
  'drift_state',
  'observed',
  'case_opened_at',
  'case_detail',
] as const;

/**
 * The one writer of `cloud.resources.state`: checks the canonical transition table (domain) AND tells the database who is acting
 * (`app.resource_actor`), so leaving `UNKNOWN` is possible only for the reconciler. The database trigger enforces the same rules.
 */
export async function transitionResource(
  c: PoolClient,
  resourceId: string,
  to: ResourceState,
  actor: TransitionActor,
  patch: ResourcePatch = {},
): Promise<Row> {
  const cur = (
    await c.query(`SELECT * FROM cloud.resources WHERE id = $1 FOR UPDATE`, [resourceId])
  ).rows[0] as Row | undefined;
  if (!cur) throw new ProblemException('not_found', 'resource not found');
  const from = cur.state as string;
  if (!isResourceState(from)) throw new Error(`resource ${resourceId} has a non-canonical state`);
  if (from !== to) assertResourceTransition(from, to, actor);
  await c.query(`SELECT set_config('app.resource_actor', $1, true)`, [actor]);
  const sets: string[] = ['state = $2'];
  const params: unknown[] = [resourceId, to];
  for (const k of PATCH_COLUMNS)
    if (k in patch) {
      const v = (patch as Record<string, unknown>)[k];
      params.push(k === 'observed' || k === 'case_detail' ? JSON.stringify(v ?? null) : v);
      sets.push(`${k} = $${params.length}`);
    }
  return (
    await c.query(`UPDATE cloud.resources SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params)
  ).rows[0] as Row;
}

/** Patch columns without changing the state (e.g. drift observations). */
export async function patchResource(
  c: PoolClient,
  resourceId: string,
  patch: ResourcePatch,
): Promise<Row> {
  const cur = (
    await c.query(`SELECT state FROM cloud.resources WHERE id = $1 FOR UPDATE`, [resourceId])
  ).rows[0] as Row | undefined;
  if (!cur) throw new ProblemException('not_found', 'resource not found');
  return transitionResource(c, resourceId, cur.state as ResourceState, 'orchestrator', patch);
}
