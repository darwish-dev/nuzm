import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResidencyEvaluator } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { GitStore } from '../git/git.store';
import { MemoryVersionStore } from './memory-backend';
import { PgVersionStore } from './pg-version-store';
import type { VersionStore } from './version-store.port';

export type VersionStoreMode = 'git' | 'pg' | 'memory';

/**
 * Which version store a process uses, from `APPBUILDER_VERSION_STORE` (`git` | `pg` | `memory`).
 *  - not production, unset: `git` (today's development behaviour, unchanged);
 *  - production, unset: `pg`;
 *  - production with `git` or `memory`: REFUSED (throws): the host `git` binary must never be the production store, and memory loses data.
 */
export function resolveVersionStoreMode(env: NodeJS.ProcessEnv): VersionStoreMode {
  const production = env.NODE_ENV === 'production';
  const raw = env.APPBUILDER_VERSION_STORE?.trim();
  if (!raw) return production ? 'pg' : 'git';
  if (raw !== 'git' && raw !== 'pg' && raw !== 'memory')
    throw new Error(`APPBUILDER_VERSION_STORE must be git, pg or memory (got "${raw}")`);
  if (production && raw !== 'pg')
    throw new Error(
      `APPBUILDER_VERSION_STORE=${raw} is refused in production: the version store must be the PostgreSQL store (no subprocess on the application host)`,
    );
  return raw;
}

export interface VersionStoreDeps {
  env: NodeJS.ProcessEnv;
  db?: Db;
  audit?: AuditSink;
  residency?: ResidencyEvaluator;
}

/** Builds the configured store. Production additionally requires the database, the audit sink and the residency evaluator (fail closed, no silent fallback). */
export function makeVersionStore(deps: VersionStoreDeps): VersionStore {
  const mode = resolveVersionStoreMode(deps.env);
  const production = deps.env.NODE_ENV === 'production';
  if (mode === 'git')
    return new GitStore(deps.env.APPBUILDER_GIT_ROOT ?? join(tmpdir(), 'nuzm-appbuilder-git'));
  if (mode === 'memory')
    return new MemoryVersionStore({ ...(deps.audit ? { audit: deps.audit } : {}) });
  if (!deps.db) throw new Error('the PostgreSQL version store needs the database');
  if (production && (!deps.residency || !deps.audit))
    throw new Error(
      'the production version store needs the residency evaluator and the audit sink',
    );
  return new PgVersionStore(deps.db, {
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.residency ? { residency: deps.residency } : {}),
  });
}
