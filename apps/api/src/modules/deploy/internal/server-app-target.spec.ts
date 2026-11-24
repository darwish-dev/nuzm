import { describe, expect, it } from 'vitest';
import {
  ServerAppTargetUnavailable,
  UnavailableServerAppTarget,
  assertServerAppReleaseSafe,
  type ServerAppRelease,
} from './server-app-target';

const rel: ServerAppRelease = {
  releaseId: 'release-0001',
  bundleHash: 'a'.repeat(64),
  startProfile: 'start-node',
  healthPath: '/health',
  envRefs: { DATABASE_URL: 'vault://staging/app-1/database-url' },
  database: { managedDatabaseRef: 'db:managed-1', migrationSetHash: 'b'.repeat(64) },
};

describe('server-app target: refuses, names the blockers, creates nothing', () => {
  const t = new UnavailableServerAppTarget();
  it('every operation throws unsupported_capability with all three blockers', () => {
    for (const call of [
      () => t.deploy(),
      () => t.health(),
      () => t.switchTraffic(),
      () => t.rollback(),
      () => t.current(),
    ]) {
      try {
        call();
        throw new Error('the call succeeded');
      } catch (e) {
        expect(e).toBeInstanceOf(ServerAppTargetUnavailable);
        expect((e as ServerAppTargetUnavailable).code).toBe('unsupported_capability');
        expect((e as ServerAppTargetUnavailable).message).toContain('NOT VERIFIED');
        expect((e as ServerAppTargetUnavailable).blockers.join(' ')).toMatch(/P3-S02.*B-DB.*HG-05/);
      }
    }
    expect(t.simulated).toBe(false);
  });
});

describe('assertServerAppReleaseSafe', () => {
  it('accepts a well-formed release', () =>
    expect(() => assertServerAppReleaseSafe(rel)).not.toThrow());
  it.each([
    ['a secret value instead of a vault reference', { envRefs: { API_KEY: 'sk-live-123456' } }],
    ['a lowercase environment name', { envRefs: { api_key: 'vault://staging/x/y' } }],
    ['a free-form command as the start profile', { startProfile: 'node server.js && curl evil' }],
    ['a relative health path', { healthPath: 'health' }],
    ['a malformed bundle hash', { bundleHash: 'abc' }],
    ['a path-like release id', { releaseId: '../current' }],
  ])('refuses %s', (_n, over) => {
    expect(() => assertServerAppReleaseSafe({ ...rel, ...over } as ServerAppRelease)).toThrow();
  });
});
