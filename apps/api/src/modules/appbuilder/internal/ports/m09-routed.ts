import type { Db } from '@nuzm/platform';
import { flagOn, M09_STUBS_FLAG } from '../flag.guard';

/**
 * Dev fallback switch. Every port method of the M09 boundary takes the organization id first (except the admin `listAll`, which always goes to the real store), so a
 * routed port can pick the implementation PER ORGANIZATION: the real M09 services by default, the in-memory stand-ins only while the organization has the flag
 * `app_builder.m09_stubs` (dev only; NEVER honoured when NODE_ENV=production, where the real services are used unconditionally). The flag lookup is cached for a few seconds.
 */
export interface StubSwitch {
  useStubs(orgId: string): Promise<boolean>;
}

export function makeStubSwitch(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
  ttlMs = Number(env.APPBUILDER_STUB_SWITCH_TTL_MS ?? 5000),
): StubSwitch {
  const cache = new Map<string, { at: number; on: boolean }>();
  return {
    async useStubs(orgId: string) {
      if (env.NODE_ENV === 'production') return false;
      const hit = cache.get(orgId);
      const now = Date.now();
      if (hit && now - hit.at < ttlMs) return hit.on;
      const on = await flagOn(db, orgId, M09_STUBS_FLAG).catch(() => false);
      cache.set(orgId, { at: now, on });
      return on;
    },
  };
}

type AnyFn = (...a: unknown[]) => unknown;

/** A port whose methods route to `real` or `stub` by the organization (first argument). `isMock` is never reported (the real services are the default). */
export function routed<T extends object>(real: T, stub: T, sw: StubSwitch): T {
  return new Proxy(real, {
    get(target, prop, recv) {
      if (prop === 'isMock') return undefined;
      const r = Reflect.get(target, prop, recv) as unknown;
      if (typeof r !== 'function') return r;
      return async (...args: unknown[]) => {
        const org = args[0];
        const use =
          prop !== 'listAll' && typeof org === 'string' && UUIDISH.test(org)
            ? (await sw.useStubs(org))
              ? stub
              : real
            : real;
        return ((use as Record<string | symbol, unknown>)[prop] as AnyFn).apply(use, args);
      };
    },
  });
}
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
