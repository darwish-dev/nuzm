import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { LocalDevSandboxRuntime } from './local-dev-runtime';

/**
 * R5 (P3-S02, Master decision): every host runner that is not isolated refuses model- and customer-origin code. The origin is a server-minted proof, never request data. This spec
 * covers the sandbox runner (the Android runner is covered in mobile/internal/builds/host-runner-guard.spec.ts; live preview uses the same guard at its single call site in `start`).
 * Nothing here executes anything: each case is refused before any process, directory or file is created.
 */
const spec = (origin: unknown) => ({
  sandboxId: 's',
  orgId: 'o',
  projectId: 'p',
  quota: { vcpu: 1, memoryMb: 512, diskGb: 1, pids: 32, buildTimeoutMinutes: 1 },
  egressProfile: 'none',
  origin,
});
const saved = { a: process.env.SANDBOX_LOCAL_DEV, b: process.env.NUZM_LOCAL_DEV_EXEC };
beforeEach(() => {
  process.env.SANDBOX_LOCAL_DEV = 'true';
  process.env.NUZM_LOCAL_DEV_EXEC = '1';
});
afterEach(() => {
  for (const [k, v] of [
    ['SANDBOX_LOCAL_DEV', saved.a],
    ['NUZM_LOCAL_DEV_EXEC', saved.b],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const BAD: [string, unknown][] = [
  ['no origin', undefined],
  ['model', 'model'],
  ['customer', 'customer'],
  ['"template" as text', 'template'],
  ['a JSON body claiming template', { kind: 'template', templateId: 'x1' }],
];

describe('LocalDevSandboxRuntime (host runner)', () => {
  it.each(BAD)('refuses %s', async (_n, origin) => {
    await expect(new LocalDevSandboxRuntime().create(spec(origin) as never)).rejects.toBeInstanceOf(
      eg.HostExecRefused,
    );
  });
  it('refuses without the opt-in env even for a template origin, and is audited', async () => {
    delete process.env.NUZM_LOCAL_DEV_EXEC;
    const seen: eg.HostExecDecision[] = [];
    eg.setHostExecAuditor((d) => seen.push(d));
    await expect(
      new LocalDevSandboxRuntime().create(spec(eg.templateOrigin('t-fixture')) as never),
    ).rejects.toMatchObject({ reasons: ['opt_in_missing'] });
    expect(seen).toEqual([
      {
        path: 'local-dev-sandbox',
        allowed: false,
        reasons: ['opt_in_missing'],
        templateId: 't-fixture',
      },
    ]);
    eg.setHostExecAuditor(() => undefined);
  });
  it('allows a template origin with the opt-in (and creates only an empty temp directory)', async () => {
    const rt = new LocalDevSandboxRuntime();
    const h = await rt.create(spec(eg.templateOrigin('t-fixture')) as never);
    expect(h).toMatch(/^local-/);
    await rt.destroy(h);
  });
});
