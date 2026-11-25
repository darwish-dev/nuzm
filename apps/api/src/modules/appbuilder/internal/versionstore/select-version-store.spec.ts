import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitStore } from '../git/git.store';
import { LogAuditSink } from '../../../../common/audit';
import { MemoryVersionStore } from './memory-backend';
import { PgVersionStore } from './pg-version-store';
import { makeVersionStore, resolveVersionStoreMode } from './select-version-store';

const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const residency = {
  evaluate: async () => ({
    decision: 'allow' as const,
    reasons: [],
    policyVersion: 1,
    floorVersion: 1,
    assessmentId: null,
    evidenceRef: 'e',
  }),
};
const fakeDb = {} as never;

describe('version store selection by configuration', () => {
  it('development default keeps today’s behaviour (host git); production default is the PostgreSQL store', () => {
    expect(resolveVersionStoreMode({} as NodeJS.ProcessEnv)).toBe('git');
    expect(resolveVersionStoreMode({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe('git');
    expect(resolveVersionStoreMode(prod)).toBe('pg');
  });
  it('production REFUSES the host git store and the memory store, however they are asked for', () => {
    for (const v of ['git', 'memory', ' git ']) {
      expect(() => resolveVersionStoreMode({ ...prod, APPBUILDER_VERSION_STORE: v })).toThrow(
        /refused in production/,
      );
      expect(() =>
        makeVersionStore({
          env: { ...prod, APPBUILDER_VERSION_STORE: v },
          db: fakeDb,
          audit: new LogAuditSink(),
          residency,
        }),
      ).toThrow();
    }
    expect(resolveVersionStoreMode({ ...prod, APPBUILDER_VERSION_STORE: 'pg' })).toBe('pg');
  });
  it('an unknown value is an error, not a silent default', () => {
    expect(() =>
      resolveVersionStoreMode({ APPBUILDER_VERSION_STORE: 'svn' } as NodeJS.ProcessEnv),
    ).toThrow(/git, pg or memory/);
  });
  it('builds each store; production without database, audit or residency fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuzm-sel-'));
    expect(
      makeVersionStore({ env: { APPBUILDER_GIT_ROOT: root } as NodeJS.ProcessEnv }),
    ).toBeInstanceOf(GitStore);
    expect(
      makeVersionStore({ env: { APPBUILDER_VERSION_STORE: 'memory' } as NodeJS.ProcessEnv }),
    ).toBeInstanceOf(MemoryVersionStore);
    expect(
      makeVersionStore({
        env: { APPBUILDER_VERSION_STORE: 'pg' } as NodeJS.ProcessEnv,
        db: fakeDb,
      }),
    ).toBeInstanceOf(PgVersionStore);
    expect(() =>
      makeVersionStore({ env: { APPBUILDER_VERSION_STORE: 'pg' } as NodeJS.ProcessEnv }),
    ).toThrow(/needs the database/);
    expect(() => makeVersionStore({ env: prod, db: fakeDb })).toThrow(
      /residency evaluator and the audit sink/,
    );
    expect(() => makeVersionStore({ env: prod, db: fakeDb, audit: new LogAuditSink() })).toThrow(
      /residency evaluator and the audit sink/,
    );
    expect(
      makeVersionStore({ env: prod, db: fakeDb, audit: new LogAuditSink(), residency }),
    ).toBeInstanceOf(PgVersionStore);
  });
  it('the production store module path starts no process: no child_process import in the versionstore folder', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = __dirname;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.spec.ts')))
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(
        /child_process|execa|(?<![.\w])(?:spawn|exec|execSync|execFile|fork)\(/,
      );
  });
});
