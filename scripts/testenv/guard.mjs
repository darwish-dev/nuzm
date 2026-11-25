// Vitest global setup (and plain import) that makes every integration run PREFLIGHT its database before a single test starts:
// the URL is mandatory (no development fallback), loopback only, not a protected port, and must belong to this session's live lease.
// Wire it as `test.globalSetup: ['<repo>/scripts/testenv/guard.mjs']` in every integration vitest config.
import { checkUrl, TestEnvError } from './lib.mjs';

export function assertTestDatabase(env = process.env) {
  checkUrl(env.NUZM_TEST_ADMIN_URL, { env });
  // any other database URL present must not point at a protected port either (a stray DATABASE_URL must not be reachable from a test)
  for (const k of ['DATABASE_ADMIN_URL', 'DATABASE_URL', 'WORKER_DATABASE_URL']) {
    if (!env[k]) continue;
    try {
      checkUrl(env[k], { env });
    } catch (e) {
      if (e instanceof TestEnvError) throw new TestEnvError(e.code, `${k}: ${e.message}`);
      throw e;
    }
  }
}

export default function setup() {
  try {
    assertTestDatabase();
  } catch (e) {
    if (e instanceof TestEnvError) {
      throw new Error(
        `test environment preflight REFUSED (${e.code}): ${e.message}\nAcquire an isolated environment first: node scripts/testenv/testenv.mjs acquire, then source the printed file.`,
        { cause: e },
      );
    }
    throw e;
  }
}
